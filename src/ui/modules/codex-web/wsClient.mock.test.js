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
    seedDefaultThreads: true,
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
    expect(
      notifications.some(
        (item) =>
          item?.method === "item/started" &&
          item?.params?.item?.type === "web_search" &&
          item?.params?.item?.status === "running"
      )
    ).toBe(true);
    expect(
      notifications.some(
        (item) =>
          item?.method === "item/completed" &&
          item?.params?.item?.type === "web_search" &&
          item?.params?.item?.status === "completed"
      )
    ).toBe(true);
    expect(
      notifications.some(
        (item) =>
          item?.method === "item/started" &&
          item?.params?.item?.type === "command_execution" &&
          item?.params?.item?.status === "running"
      )
    ).toBe(true);
    expect(
      notifications.some(
        (item) =>
          item?.method === "item/completed" &&
          item?.params?.item?.type === "command_execution" &&
          item?.params?.item?.status === "completed"
      )
    ).toBe(true);
    expect(notifications.some((item) => item?.method === "turn/completed")).toBe(true);

    const history = await module.api(`/codex/threads/${created.threadId}/history?workspace=windows`);
    const latestTurn = history.turns[history.turns.length - 1];
    expect(latestTurn.items[0].type).toBe("userMessage");
    expect(latestTurn.items[1]).toEqual(
      expect.objectContaining({ type: "agentMessage", phase: "commentary" })
    );
    expect(latestTurn.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "web_search", status: "completed" }),
        expect.objectContaining({ type: "command_execution", status: "completed" }),
        expect.objectContaining({ type: "assistantMessage", phase: "final_answer" }),
      ])
    );
  });

  it("persists failed mock tool runs into history and completion notifications", async () => {
    vi.useFakeTimers();
    const state = createState();
    const notifications = [];
    const module = createModule(state, notifications, vi.fn());

    const created = await module.api("/codex/threads", {
      method: "POST",
      body: { workspace: "windows" },
    });

    await module.api("/codex/turns/start", {
      method: "POST",
      body: {
        threadId: created.threadId,
        prompt: "Reproduce the websocket failure",
        workspace: "windows",
        mockScenario: "failed-command",
      },
    });

    await vi.runAllTimersAsync();

    const failedNotification = notifications.find(
      (item) =>
        item?.method === "item/completed" &&
        item?.params?.item?.id === "mock-command-2"
    );
    expect(failedNotification?.params?.item).toEqual(
      expect.objectContaining({ status: "failed", exitCode: 1 })
    );

    const history = await module.api(`/codex/threads/${created.threadId}/history?workspace=windows`);
    const latestTurn = history.turns[history.turns.length - 1];
    expect(latestTurn.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mock-command-2",
          type: "command_execution",
          status: "failed",
          exitCode: 1,
        }),
      ])
    );
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
    await expect(module.api("/codex/threads?workspace=windows")).resolves.toEqual(
      expect.objectContaining({
        items: expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ id: "real-thread-1", title: "Real thread", workspace: "windows" }),
          ]),
        }),
      })
    );

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

  it("passes git meta reads and branch switches through to live routes in safe transport mode", async () => {
    const state = createState();
    const notifications = [];
    const fetchRef = vi.fn(async (path, init = {}) => {
      const method = String(init?.method || "GET").trim().toUpperCase();
      if (method === "GET" && path === "/codex/git?workspace=windows&cwd=C%3A%5Crepo") {
        return {
          ok: true,
          json: async () => ({
            workspace: "windows",
            cwd: "C:\\repo",
            currentBranch: "main",
            branches: [{ name: "main" }, { name: "feat/ui", prNumber: 182 }],
            isWorktree: false,
          }),
        };
      }
      if (method === "GET" && path === "/codex/threads/thread-1/git?workspace=windows") {
        return {
          ok: true,
          json: async () => ({
            threadId: "thread-1",
            workspace: "windows",
            cwd: "C:\\repo",
            currentBranch: "feat/ui",
            branches: [{ name: "main" }, { name: "feat/ui", prNumber: 182 }],
            isWorktree: true,
          }),
        };
      }
      if (method === "POST" && path === "/codex/git/branch") {
        return {
          ok: true,
          json: async () => ({
            workspace: "windows",
            cwd: "C:\\repo",
            currentBranch: "feat/ui",
            branches: [{ name: "main" }, { name: "feat/ui", prNumber: 182 }],
            isWorktree: false,
          }),
        };
      }
      if (method === "POST" && path === "/codex/threads/thread-1/branch") {
        return {
          ok: true,
          json: async () => ({
            threadId: "thread-1",
            workspace: "windows",
            cwd: "C:\\repo",
            currentBranch: "main",
            branches: [{ name: "main" }, { name: "feat/ui", prNumber: 182 }],
            isWorktree: true,
          }),
        };
      }
      throw new Error(`unexpected fetch ${method} ${path}`);
    });
    const module = createModule(state, notifications, fetchRef, "safe");

    await expect(
      module.api("/codex/git?workspace=windows&cwd=C%3A%5Crepo")
    ).resolves.toEqual(
      expect.objectContaining({
        currentBranch: "main",
        branches: [{ name: "main" }, { name: "feat/ui", prNumber: 182 }],
      })
    );
    await expect(
      module.api("/codex/threads/thread-1/git?workspace=windows")
    ).resolves.toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        currentBranch: "feat/ui",
        isWorktree: true,
      })
    );
    await expect(
      module.api("/codex/git/branch", {
        method: "POST",
        body: { workspace: "windows", cwd: "C:\\repo", branch: "feat/ui" },
      })
    ).resolves.toEqual(expect.objectContaining({ currentBranch: "feat/ui" }));
    await expect(
      module.api("/codex/threads/thread-1/branch", {
        method: "POST",
        body: { workspace: "windows", branch: "main" },
      })
    ).resolves.toEqual(expect.objectContaining({ threadId: "thread-1", currentBranch: "main" }));

    expect(fetchRef).toHaveBeenCalledTimes(4);
  });

  it("returns mock git meta payloads in pure mock transport mode", async () => {
    const state = createState();
    const notifications = [];
    const fetchRef = vi.fn(async () => {
      throw new Error("fetch should not be called");
    });
    const module = createModule(state, notifications, fetchRef, "mock");

    const created = await module.api("/codex/threads", {
      method: "POST",
      body: { workspace: "windows", cwd: "C:\\repo\\demo" },
    });

    await expect(
      module.api("/codex/git?workspace=windows&cwd=C%3A%5Crepo%5Cdemo")
    ).resolves.toEqual(
      expect.objectContaining({
        workspace: "windows",
        cwd: "C:\\repo\\demo",
        currentBranch: "feat/codex-web-branch-picker",
        branches: expect.arrayContaining([expect.objectContaining({ name: "main" })]),
      })
    );
    await expect(
      module.api(`/codex/threads/${created.threadId}/git?workspace=windows`)
    ).resolves.toEqual(
      expect.objectContaining({
        threadId: created.threadId,
        cwd: "C:\\repo\\demo",
      })
    );
    await expect(
      module.api("/codex/git/branch", {
        method: "POST",
        body: { workspace: "windows", cwd: "C:\\repo\\demo", branch: "main" },
      })
    ).resolves.toEqual(expect.objectContaining({ currentBranch: "main" }));
    await expect(
      module.api(`/codex/threads/${created.threadId}/branch`, {
        method: "POST",
        body: { workspace: "windows", branch: "main" },
      })
    ).resolves.toEqual(
      expect.objectContaining({ threadId: created.threadId, currentBranch: "main" })
    );

    expect(fetchRef).not.toHaveBeenCalled();
  });

  it("merges sandbox-created threads into safe thread list reads", async () => {
    const state = createState();
    const notifications = [];
    const fetchRef = vi.fn(async (path) => {
      if (String(path).startsWith("/codex/threads?workspace=windows")) {
        return {
          ok: true,
          json: async () => ({
            items: {
              data: [{ id: "real-thread-1", title: "Real thread", workspace: "windows", updatedAt: "2026-03-18T00:00:00.000Z" }],
              nextCursor: null,
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    const module = createModule(state, notifications, fetchRef, "safe");

    const created = await module.api("/codex/threads", {
      method: "POST",
      body: { workspace: "windows" },
    });
    const list = await module.api("/codex/threads?workspace=windows");
    const items = Array.isArray(list?.items?.data) ? list.items.data : [];

    expect(items.some((item) => item.id === "real-thread-1")).toBe(true);
    expect(items.some((item) => item.id === created.threadId)).toBe(true);
  });

  it("merges live history payload shape with sandbox turns in safe mode", async () => {
    vi.useFakeTimers();
    const state = createState();
    const notifications = [];
    const fetchRef = vi.fn(async (path) => {
      if (String(path).startsWith("/codex/threads/real-thread-1/history")) {
        return {
          ok: true,
          json: async () => ({
            thread: {
              id: "real-thread-1",
              workspace: "windows",
              path: "C:\\real\\rollout.jsonl",
              turns: [
                {
                  id: "real-turn-1",
                  items: [{ type: "assistantMessage", text: "Existing real answer" }],
                },
              ],
            },
            page: { incomplete: false, totalTurns: 1, hasMore: false },
          }),
        };
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    const module = createModule(state, notifications, fetchRef, "safe");

    await module.api("/codex/turns/start", {
      method: "POST",
      body: {
        threadId: "real-thread-1",
        prompt: "Sandbox follow-up",
        workspace: "windows",
      },
    });

    const history = await module.api("/codex/threads/real-thread-1/history?workspace=windows");
    expect(history?.thread?.turns?.[0]?.id).toBe("real-turn-1");
    expect(
      history?.thread?.turns?.some((turn) =>
        Array.isArray(turn?.items) &&
        turn.items.some((item) => item?.type === "userMessage")
      )
    ).toBe(true);
    expect(history?.page?.incomplete).toBe(true);
  });

  it("returns wrapped mock history when safe mode live history read fails for mock-only threads", async () => {
    const state = createState();
    const notifications = [];
    const fetchRef = vi.fn(async (path) => {
      if (String(path).startsWith("/codex/threads/mock-thread-1/history")) {
        throw new Error("history 502");
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    const module = createModule(state, notifications, fetchRef, "safe");

    const history = await module.api("/codex/threads/mock-thread-1/history?workspace=windows");

    expect(fetchRef).not.toHaveBeenCalled();
    expect(history?.thread?.id).toBe("mock-thread-1");
    expect(Array.isArray(history?.thread?.turns)).toBe(true);
    expect(history?.page?.totalTurns).toBe(history?.thread?.turns?.length);
    expect(history?.page?.hasMore).toBe(false);
  });
});
