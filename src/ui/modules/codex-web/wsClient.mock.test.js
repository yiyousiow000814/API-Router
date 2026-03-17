import { afterEach, describe, expect, it, vi } from "vitest";

import { createWsClientModule } from "./wsClient.js";

function createState() {
  return {
    token: "",
    ws: null,
    wsPingTimer: null,
    wsReconnectTimer: null,
    wsReconnectAttempt: 0,
    wsConnectSeq: 0,
    wsReqHandlers: new Map(),
    pendingApprovals: [],
    pendingUserInputs: [],
    liveDebugEvents: [],
    activeThreadWorkspace: "windows",
    workspaceTarget: "windows",
    activeThreadId: "",
    selectedModel: "gpt-5.5-codex",
    planModeEnabled: false,
    fastModeEnabled: false,
    permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
    wsLastEventId: 0,
    wsRecentEventIds: new Set(),
    wsRecentEventIdQueue: [],
    wsSubscribedEvents: false,
  };
}

function createModule(state, notifications, fetchRef, transportMode = "mock") {
  return createWsClientModule({
    state,
    setStatus: () => {},
    toRecord: (value) => (value && typeof value === "object" ? value : null),
    readString: (value) => (typeof value === "string" ? value : null),
    readNumber: (value) => (typeof value === "number" ? value : null),
    resetEventReplayState: () => {},
    markEventIdSeen: () => {},
    extractNotificationEventId: () => null,
    extractNotificationThreadId: (record) =>
      String(record?.params?.threadId || record?.params?.conversationId || "").trim(),
    shouldRefreshThreadsFromNotification: () => false,
    shouldRefreshActiveThreadFromNotification: () => false,
    scheduleThreadRefresh: () => {},
    scheduleActiveThreadRefresh: () => {},
    renderLiveNotification: (notification) => notifications.push(notification),
    applyPendingPayloads: () => {},
    addChat: () => {},
    LAST_EVENT_ID_KEY: "web_codex_last_event_id_v1",
    fetchRef,
    localStorageRef: { getItem() { return null; }, setItem() {}, removeItem() {} },
    windowRef: { location: { protocol: "http:", host: "127.0.0.1:5173" } },
    transportMode,
  });
}

describe("wsClient mock transport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles bootstrap requests without touching fetch", async () => {
    const state = createState();
    const notifications = [];
    const fetchRef = vi.fn(async () => {
      throw new Error("fetch should not be called");
    });
    const module = createModule(state, notifications, fetchRef);

    await expect(module.api("/codex/auth/verify", { method: "POST", body: {} })).resolves.toEqual(
      expect.objectContaining({ ok: true, mode: "mock" })
    );
    await expect(module.api("/codex/models")).resolves.toEqual(
      expect.objectContaining({ items: expect.any(Array) })
    );
    await expect(module.api("/codex/threads?workspace=windows")).resolves.toEqual(
      expect.objectContaining({ items: expect.any(Object) })
    );
    expect(fetchRef).not.toHaveBeenCalled();
  });

  it("simulates turn streaming and completion notifications", async () => {
    vi.useFakeTimers();
    const state = createState();
    const notifications = [];
    const module = createModule(state, notifications, vi.fn());

    const created = await module.api("/codex/threads", {
      method: "POST",
      body: { workspace: "windows" },
    });
    state.activeThreadId = created.threadId;
    state.activeThreadWorkspace = "windows";

    const started = await module.api("/codex/turns/start", {
      method: "POST",
      body: {
        threadId: created.threadId,
        prompt: "Explain the mock transport",
        workspace: "windows",
        serviceTier: "fast",
      },
    });

    expect(started.turnId).toMatch(/^mock-turn-/);
    await vi.runAllTimersAsync();

    expect(notifications.some((item) => item?.method === "turn/started")).toBe(true);
    expect(notifications.some((item) => item?.method === "turn/assistant/delta")).toBe(true);
    expect(notifications.some((item) => item?.method === "turn/completed")).toBe(true);

    const history = await module.api(`/codex/threads/${created.threadId}/history?workspace=windows`);
    const latestTurn = history.turns[history.turns.length - 1];
    expect(latestTurn.items[0].type).toBe("userMessage");
    expect(latestTurn.items[1].type).toBe("assistantMessage");
  });

  it("keeps an interrupted mock turn pending briefly so queued actions stay visible", async () => {
    vi.useFakeTimers();
    const state = createState();
    const notifications = [];
    const module = createModule(state, notifications, vi.fn());

    const created = await module.api("/codex/threads", {
      method: "POST",
      body: { workspace: "windows" },
    });

    const started = await module.api("/codex/turns/start", {
      method: "POST",
      body: {
        threadId: created.threadId,
        prompt: "Let me test steer",
        workspace: "windows",
      },
    });

    await module.api(`/codex/turns/${started.turnId}/interrupt`, { method: "POST" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(notifications.some((item) => item?.method === "turn/cancelled")).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    expect(notifications.some((item) => item?.method === "turn/cancelled")).toBe(true);
  });

  it("uses live reads in safe transport mode while keeping turn writes sandboxed", async () => {
    const state = createState();
    const notifications = [];
    const fetchRef = vi.fn(async (path) => {
      if (path === "/codex/models") {
        return {
          ok: true,
          json: async () => ({ items: [{ id: "real-model", name: "Real Model" }] }),
        };
      }
      if (String(path).startsWith("/codex/threads?workspace=windows")) {
        return {
          ok: true,
          json: async () => ({
            items: {
              data: [{ id: "real-thread-1", title: "Real thread", workspace: "windows" }],
              nextCursor: null,
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    const module = createModule(state, notifications, fetchRef, "safe");

    await expect(module.api("/codex/models")).resolves.toEqual({
      items: [{ id: "real-model", name: "Real Model" }],
    });
    await expect(module.api("/codex/threads?workspace=windows")).resolves.toEqual({
      items: {
        data: [{ id: "real-thread-1", title: "Real thread", workspace: "windows" }],
        nextCursor: null,
      },
    });

    const started = await module.api("/codex/turns/start", {
      method: "POST",
      body: {
        threadId: "real-thread-1",
        prompt: "Sandbox this turn",
        workspace: "windows",
      },
    });

    expect(started.turnId).toMatch(/^mock-turn-/);
    expect(fetchRef).toHaveBeenCalledTimes(2);
  });
});
