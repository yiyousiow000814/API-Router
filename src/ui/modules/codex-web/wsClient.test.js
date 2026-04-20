import { describe, expect, it } from "vitest";

import {
  buildCodexWsUrl,
  createWsClientModule,
  ensureArrayItems,
  normalizeLiveWorkspaceTarget,
  resolveLiveWorkspaceSubscription,
  resolveApiErrorMessage,
  subscriptionIncludesWorkspace,
} from "./wsClient.js";

describe("wsClient", () => {
  it("normalizes array-like payloads", () => {
    expect(ensureArrayItems([1, 2])).toEqual([1, 2]);
    expect(ensureArrayItems({ items: [3] })).toEqual([3]);
    expect(ensureArrayItems(null)).toEqual([]);
  });

  it("builds websocket urls from location and token", () => {
    expect(buildCodexWsUrl({ protocol: "https:", host: "example.com" }, "abc")).toBe(
      "wss://example.com/codex/ws?token=abc"
    );
  });

  it("normalizes live workspace targets", () => {
    expect(normalizeLiveWorkspaceTarget("wsl2")).toBe("wsl2");
    expect(normalizeLiveWorkspaceTarget("windows")).toBe("windows");
    expect(normalizeLiveWorkspaceTarget("")).toBe("windows");
  });

  it("builds dual-workspace live subscriptions only when both targets are available", () => {
    expect(
      resolveLiveWorkspaceSubscription({
        workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
        workspaceTarget: "windows",
      })
    ).toEqual({
      workspace: "all",
      workspaces: ["windows", "wsl2"],
    });
    expect(
      resolveLiveWorkspaceSubscription({
        workspaceAvailability: { windowsInstalled: false, wsl2Installed: false },
        activeThreadWorkspace: "wsl2",
        workspaceTarget: "windows",
      })
    ).toEqual({
      workspace: "wsl2",
      workspaces: ["wsl2"],
    });
    expect(subscriptionIncludesWorkspace(["windows", "wsl2"], "wsl2")).toBe(true);
    expect(subscriptionIncludesWorkspace("all", "windows")).toBe(true);
  });

  it("prefers structured api errors", () => {
    expect(resolveApiErrorMessage({ error: { detail: "boom" } }, 500)).toBe("boom");
    expect(resolveApiErrorMessage({}, 404)).toBe("HTTP 404");
  });

  it("records codex api failures and missing-thread details", async () => {
    const transportEvents = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        wsLastEventId: 0,
        wsRecentEventIds: new Set(),
        wsSubscribedEvents: false,
      },
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      recordWebTransportEvent(kind, detail) {
        transportEvents.push({ kind, detail });
      },
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => ({
        ok: false,
        status: 502,
        json: async () => ({
          error: {
            detail: "thread not found: thread-1",
          },
        }),
      }),
    });

    await expect(
      module.api("/codex/turns/start", {
        method: "POST",
        body: { threadId: "thread-1" },
      })
    ).rejects.toThrow("thread not found: thread-1");
    expect(transportEvents).toEqual([
      {
        kind: "api_request_failed",
        detail: "POST /codex/turns/start -> HTTP 502: thread not found: thread-1",
      },
      {
        kind: "thread_missing_observed",
        detail: "thread not found: thread-1",
      },
    ]);
  });

  it("records network-level codex api failures", async () => {
    const transportEvents = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        wsLastEventId: 0,
        wsRecentEventIds: new Set(),
        wsSubscribedEvents: false,
      },
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      recordWebTransportEvent(kind, detail) {
        transportEvents.push({ kind, detail });
      },
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => {
        throw new Error("gateway offline");
      },
    });

    await expect(module.api("/codex/threads")).rejects.toThrow("gateway offline");
    expect(transportEvents).toEqual([
      {
        kind: "api_request_failed",
        detail: "GET /codex/threads -> network error: gateway offline",
      },
    ]);
  });

  it("preserves conversation id on ui assistant delta notifications", () => {
    const notifications = [];
    const statuses = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        wsLastEventId: 0,
        wsRecentEventIds: new Set(),
        wsSubscribedEvents: false,
      },
      setStatus(message) {
        statuses.push(message);
      },
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification(notification) {
        notifications.push(notification);
      },
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.handleWsPayload({
      type: "ui.event",
      payload: {
        kind: "assistant_delta",
        conversationId: "thread-1",
        delta: "hello",
      },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      method: "turn/assistant/delta",
      params: {
        conversationId: "thread-1",
        threadId: "thread-1",
        delta: "hello",
      },
    });
    expect(statuses).toEqual([]);
  });

  it("does not schedule active-thread refresh for ui assistant deltas", () => {
    const activeRefreshes = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        wsLastEventId: 0,
        wsRecentEventIds: new Set(),
        wsSubscribedEvents: false,
      },
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification(method) {
        return method === "turn/completed";
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh(threadId) {
        activeRefreshes.push(threadId);
      },
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.handleWsPayload({
      type: "ui.event",
      payload: {
        kind: "assistant_delta",
        conversationId: "thread-1",
        delta: "hello",
      },
    });

    expect(activeRefreshes).toEqual([]);
  });

  it("surfaces approval and subscription status updates", () => {
    const statuses = [];
    const chats = [];
    const threadRefreshes = [];
    const activeRefreshes = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        activeThreadId: "thread-live",
        wsLastEventId: 0,
        wsRecentEventIds: new Set(),
        wsSubscribedEvents: false,
      },
      setStatus(message) {
        statuses.push(message);
      },
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh(delay) {
        threadRefreshes.push(delay ?? null);
      },
      scheduleActiveThreadRefresh(threadId, delay) {
        activeRefreshes.push({ threadId, delay: delay ?? null });
      },
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat(role, text) {
        chats.push({ role, text });
      },
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.handleWsPayload({ type: "approval.requested", payload: [{ id: "a1" }] });
    module.handleWsPayload({ type: "subscribed" });

    expect(statuses).toEqual(["Approval requested.", "Live updates connected."]);
    expect(chats).toEqual([]);
    expect(threadRefreshes).toEqual([0]);
    expect(activeRefreshes).toEqual([{ threadId: "thread-live", delay: 0 }]);
  });

  it("schedules active-thread refresh for ui activity notifications", () => {
    const activeRefreshes = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        wsLastEventId: 0,
        wsRecentEventIds: new Set(),
        wsSubscribedEvents: false,
      },
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification(method) {
        return method === "thread/status";
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh(threadId, delay) {
        activeRefreshes.push({ threadId, delay: delay ?? null });
      },
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.handleWsPayload({
      type: "ui.event",
      payload: {
        kind: "activity",
        conversationId: "thread-live",
        status: "running",
        message: "Running...",
      },
    });

    expect(activeRefreshes).toEqual([{ threadId: "thread-live", delay: 90 }]);
  });

  it("resets replay cursor when backend asks for resync", () => {
    const statuses = [];
    let resetCalls = 0;
    const threadRefreshes = [];
    const activeRefreshes = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        activeThreadId: "thread-1",
        wsLastEventId: 14549,
        wsRecentEventIds: new Set([14549]),
        wsSubscribedEvents: true,
      },
      setStatus(message) {
        statuses.push(message);
      },
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {
        resetCalls += 1;
      },
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh(delay) {
        threadRefreshes.push(delay ?? null);
      },
      scheduleActiveThreadRefresh(threadId) {
        activeRefreshes.push(threadId);
      },
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "14549"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.handleWsPayload({
      type: "events.reset",
      payload: { requestedSince: 14549, lastEventId: 108 },
    });

    expect(resetCalls).toBe(1);
    expect(statuses).toEqual(["Live event stream resynced."]);
    expect(threadRefreshes).toEqual([null]);
    expect(activeRefreshes).toEqual(["thread-1"]);
  });

  it("subscribes websocket events with active workspace", () => {
    const sent = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      constructor() {
        this.readyState = FakeWebSocket.CONNECTING;
      }
      send(value) {
        sent.push(JSON.parse(value));
      }
    }
    const state = {
      token: "",
      ws: null,
      wsReqHandlers: new Map(),
      pendingApprovals: [],
      pendingUserInputs: [],
      wsLastEventId: 0,
      wsRecentEventIds: new Set(),
      wsSubscribedEvents: false,
      activeThreadWorkspace: "wsl2",
      workspaceTarget: "windows",
      workspaceAvailability: { windowsInstalled: false, wsl2Installed: false },
    };
    const module = createWsClientModule({
      state,
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "7"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: FakeWebSocket,
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.connectWs();
    state.ws.readyState = FakeWebSocket.OPEN;
    state.ws.onopen();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "subscribe.events",
      payload: { events: true, lastEventId: 7, workspace: "wsl2" },
    });
    expect(state.wsRequestedWorkspaceTarget).toBe("wsl2");

    module.handleWsPayload({
      type: "subscribed",
      payload: { events: true, workspace: "wsl2" },
    });

    expect(state.wsSubscribedEvents).toBe(true);
    expect(state.wsSubscribedWorkspaceTarget).toBe("wsl2");
  });

  it("subscribes websocket events for both workspaces when both are available", () => {
    const sent = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      constructor() {
        this.readyState = FakeWebSocket.CONNECTING;
      }
      send(value) {
        sent.push(JSON.parse(value));
      }
    }
    const state = {
      token: "",
      ws: null,
      wsReqHandlers: new Map(),
      pendingApprovals: [],
      pendingUserInputs: [],
      wsLastEventId: 0,
      wsRecentEventIds: new Set(),
      wsSubscribedEvents: false,
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
    };
    const module = createWsClientModule({
      state,
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "11"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: FakeWebSocket,
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.connectWs();
    state.ws.readyState = FakeWebSocket.OPEN;
    state.ws.onopen();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "subscribe.events",
      payload: { events: true, lastEventId: 11, workspace: "all", workspaces: ["windows", "wsl2"] },
    });
    expect(state.wsRequestedWorkspaceTarget).toBe("all");
    expect(state.wsRequestedWorkspaceTargets).toEqual(["windows", "wsl2"]);

    module.handleWsPayload({
      type: "subscribed",
      payload: { events: true, workspace: "all", workspaces: ["windows", "wsl2"] },
    });

    expect(state.wsSubscribedEvents).toBe(true);
    expect(state.wsSubscribedWorkspaceTarget).toBe("all");
    expect(state.wsSubscribedWorkspaceTargets).toEqual(["windows", "wsl2"]);
  });

  it("reconnects and resubscribes after websocket close", () => {
    const sent = [];
    const timeouts = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static instances = [];
      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        FakeWebSocket.instances.push(this);
      }
      send(value) {
        const parsed = JSON.parse(value);
        this.sent.push(parsed);
        sent.push(parsed);
      }
    }
    const state = {
      token: "",
      ws: null,
      wsPingTimer: null,
      wsReconnectTimer: null,
      wsReconnectAttempt: 0,
      wsConnectSeq: 0,
      wsReqHandlers: new Map(),
      pendingApprovals: [],
      pendingUserInputs: [],
      wsLastEventId: 0,
      wsRecentEventIds: new Set(),
      wsSubscribedEvents: false,
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      liveDebugEvents: [],
    };
    const module = createWsClientModule({
      state,
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "9"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: FakeWebSocket,
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
      setTimeoutRef(callback, delay) {
        timeouts.push({ callback, delay });
        return timeouts.length;
      },
      clearTimeoutRef() {},
      setIntervalRef() {
        return 1;
      },
      clearIntervalRef() {},
      WS_RECONNECT_BASE_MS: 25,
      WS_RECONNECT_MAX_MS: 25,
    });

    module.connectWs();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[0].onopen();
    FakeWebSocket.instances[0].readyState = 3;
    FakeWebSocket.instances[0].onclose({ code: 1006, reason: "", wasClean: false });

    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].delay).toBe(25);

    timeouts[0].callback();
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[1].onopen();

    expect(sent.filter((entry) => entry.type === "subscribe.events")).toHaveLength(2);
    expect(sent[sent.length - 1]).toMatchObject({
      type: "subscribe.events",
      payload: { events: true, lastEventId: 9, workspace: "windows" },
    });
  });

  it("invalidates the active thread open state after reconnecting websocket open", () => {
    const removedKeys = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static instances = [];
      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        FakeWebSocket.instances.push(this);
      }
      send() {}
    }
    const state = {
      token: "",
      ws: null,
      wsPingTimer: null,
      wsReconnectTimer: null,
      wsReconnectAttempt: 2,
      wsConnectSeq: 0,
      wsReqHandlers: new Map(),
      pendingApprovals: [],
      pendingUserInputs: [],
      wsLastEventId: 0,
      wsRecentEventIds: new Set(),
      wsSubscribedEvents: false,
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadOpenState: {
        threadId: "thread-1",
        threadStatusType: "idle",
        historyThreadId: "",
        historyStatusType: "",
        historyIncomplete: false,
        pendingTurnRunning: false,
        pendingThreadId: "",
        loaded: true,
        resumeRequired: false,
        resumeReason: "loaded",
      },
      workspaceTarget: "windows",
      liveDebugEvents: [],
    };
    const module = createWsClientModule({
      state,
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: FakeWebSocket,
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
      setTimeoutRef(callback, delay) {
        return { callback, delay };
      },
      clearTimeoutRef() {},
      setIntervalRef() {
        return 1;
      },
      clearIntervalRef() {},
      WS_RECONNECT_BASE_MS: 25,
      WS_RECONNECT_MAX_MS: 25,
    });

    module.connectWs();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[0].onopen();

    expect(state.wsReconnectAttempt).toBe(0);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadOpenState).toMatchObject({
      threadId: "thread-1",
      threadStatusType: "notloaded",
      loaded: false,
      resumeRequired: true,
      resumeReason: "thread-not-loaded",
    });
  });

  it("surfaces reconnecting activity and errors after reconnect retries are exhausted", () => {
    const activities = [];
    const statuses = [];
    const timeouts = [];
    const chatMessages = [];
    const removedKeys = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static instances = [];
      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        FakeWebSocket.instances.push(this);
      }
      send() {}
    }
    const state = {
      token: "",
      ws: null,
      wsPingTimer: null,
      wsReconnectTimer: null,
      wsReconnectAttempt: 0,
      wsConnectSeq: 0,
      wsReqHandlers: new Map(),
      pendingApprovals: [],
      pendingUserInputs: [],
      wsLastEventId: 0,
      wsRecentEventIds: new Set(),
      wsSubscribedEvents: false,
      activeThreadId: "",
      activeThreadWorkspace: "windows",
      activeThreadOpenState: {
        threadId: "thread-1",
        threadStatusType: "idle",
        historyThreadId: "",
        historyStatusType: "",
        historyIncomplete: false,
        pendingTurnRunning: false,
        pendingThreadId: "",
        loaded: true,
        resumeRequired: false,
        resumeReason: "loaded",
      },
      workspaceTarget: "windows",
      liveDebugEvents: [],
    };
    const module = createWsClientModule({
      state,
      setStatus(message, isWarn) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity(payload) {
        activities.push(payload);
      },
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat(role, text, options = {}) {
        chatMessages.push({ role, text, options });
      },
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: FakeWebSocket,
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
      setTimeoutRef(callback, delay) {
        timeouts.push({ callback, delay });
        return timeouts.length;
      },
      clearTimeoutRef() {},
      setIntervalRef() {
        return 1;
      },
      clearIntervalRef() {},
      WS_RECONNECT_BASE_MS: 25,
      WS_RECONNECT_MAX_MS: 25,
      WS_RECONNECT_MAX_ATTEMPTS: 1,
    });

    module.connectWs();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[0].readyState = 3;
    FakeWebSocket.instances[0].onclose({ code: 1006, reason: "server restart", wasClean: false });

    expect(statuses).toEqual(
      expect.arrayContaining([
        { message: "Reconnecting... 1/1", isWarn: true },
      ])
    );
    expect(chatMessages).toEqual([
      {
        role: "system",
        text: "Reconnecting... 1/1",
        options: {
          kind: "thinking",
          transient: false,
          animate: true,
          messageKey: "transport-connection-status",
        },
      },
    ]);

    expect(timeouts).toHaveLength(1);
    timeouts[0].callback();
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[1].readyState = 3;
    FakeWebSocket.instances[1].onclose({ code: 1006, reason: "server restart", wasClean: false });
    expect(statuses).toEqual(
      expect.arrayContaining([
        { message: "Live updates disconnected after 1 retry. Last error: server restart", isWarn: true },
      ])
    );
    expect(chatMessages.at(-1)).toEqual({
      role: "system",
      text: "Live updates disconnected after 1 retry. Last error: server restart",
      options: {
        kind: "error",
        transient: false,
        animate: true,
        messageKey: "transport-connection-status",
      },
    });
    expect(removedKeys).toEqual(["transport-connection-status"]);
  });

  it("records structured websocket close detail for diagnostics", () => {
    const recorded = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static instances = [];
      constructor() {
        this.readyState = FakeWebSocket.CONNECTING;
        FakeWebSocket.instances.push(this);
      }
      send() {}
    }
    const state = {
      token: "",
      ws: null,
      wsPingTimer: null,
      wsReconnectTimer: null,
      wsReconnectAttempt: 0,
      wsConnectSeq: 0,
      wsReqHandlers: new Map(),
      pendingApprovals: [],
      pendingUserInputs: [],
      wsLastEventId: 0,
      wsRecentEventIds: new Set(),
      wsSubscribedEvents: false,
      activeThreadId: "",
      activeThreadWorkspace: "windows",
      activeThreadOpenState: {
        threadId: "thread-1",
        threadStatusType: "idle",
        historyThreadId: "",
        historyStatusType: "",
        historyIncomplete: false,
        pendingTurnRunning: false,
        pendingThreadId: "",
        loaded: true,
        resumeRequired: false,
        resumeReason: "loaded",
      },
      workspaceTarget: "windows",
      liveDebugEvents: [],
    };
    const module = createWsClientModule({
      state,
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      recordWebTransportEvent(eventType, detail) {
        recorded.push({ eventType, detail });
      },
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: FakeWebSocket,
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
      setTimeoutRef(callback, delay) {
        return 1;
      },
      clearTimeoutRef() {},
      setIntervalRef() {
        return 1;
      },
      clearIntervalRef() {},
    });

    module.connectWs();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances[0].onclose({ code: 1006, reason: "server restart", wasClean: false });

    expect(recorded).toEqual([
      {
        eventType: "ws_close_observed",
        detail: JSON.stringify({ code: 1006, reason: "server restart", wasClean: false }),
      },
      {
        eventType: "ws_reconnect_scheduled",
        detail: "server restart",
      },
    ]);
  });

  it("sends heartbeat pings while websocket stays open", () => {
    const sent = [];
    const intervals = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      constructor() {
        this.readyState = FakeWebSocket.CONNECTING;
      }
      send(value) {
        sent.push(JSON.parse(value));
      }
    }
    const state = {
      token: "",
      ws: null,
      wsPingTimer: null,
      wsReconnectTimer: null,
      wsReconnectAttempt: 0,
      wsConnectSeq: 0,
      wsReqHandlers: new Map(),
      pendingApprovals: [],
      pendingUserInputs: [],
      wsLastEventId: 0,
      wsRecentEventIds: new Set(),
      wsSubscribedEvents: false,
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      liveDebugEvents: [],
    };
    const module = createWsClientModule({
      state,
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "";
      },
      shouldRefreshThreadsFromNotification() {
        return false;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: FakeWebSocket,
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
      setIntervalRef(callback, delay) {
        intervals.push({ callback, delay });
        return intervals.length;
      },
      clearIntervalRef() {},
      WS_PING_INTERVAL_MS: 1234,
    });

    module.connectWs();
    state.ws.readyState = FakeWebSocket.OPEN;
    state.ws.onopen();

    expect(intervals).toHaveLength(1);
    expect(intervals[0].delay).toBe(1234);

    intervals[0].callback();

    expect(sent.some((entry) => entry.type === "ping")).toBe(true);
  });

  it("does not schedule active-thread history refresh for assistant stream notifications", () => {
    const activeRefreshes = [];
    const notifications = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        wsLastEventId: 0,
        wsRecentEventIds: new Set(),
        wsSubscribedEvents: false,
      },
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "thread-1";
      },
      shouldRefreshThreadsFromNotification() {
        return true;
      },
      shouldRefreshActiveThreadFromNotification(method) {
        return method === "turn.completed";
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh(threadId) {
        activeRefreshes.push(threadId);
      },
      renderLiveNotification(notification) {
        notifications.push(notification);
      },
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.handleWsPayload({
      type: "rpc.notification",
      payload: {
        method: "item.updated",
        params: {
          item: {
            type: "agent_message_content_delta",
            thread_id: "thread-1",
            delta: "hello",
          },
        },
      },
    });
    module.handleWsPayload({
      type: "rpc.notification",
      payload: {
        method: "turn.completed",
        params: { threadId: "thread-1" },
      },
    });

    expect(notifications).toHaveLength(2);
    expect(activeRefreshes).toEqual(["thread-1"]);
  });

  it("schedules active-thread refresh for codex response-item snapshots", () => {
    const activeRefreshes = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        wsLastEventId: 0,
        wsRecentEventIds: new Set(),
        wsSubscribedEvents: false,
      },
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "thread-1";
      },
      shouldRefreshThreadsFromNotification() {
        return true;
      },
      shouldRefreshActiveThreadFromNotification(method) {
        return method === "codex/event/response_item";
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh(threadId) {
        activeRefreshes.push(threadId);
      },
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.handleWsPayload({
      type: "rpc.notification",
      payload: {
        method: "codex/event/response_item",
        params: {
          payload: {
            type: "message",
            role: "assistant",
            thread_id: "thread-1",
            phase: "final_answer",
            content: [{ type: "output_text", text: "live final" }],
          },
        },
      },
    });

    expect(activeRefreshes).toEqual(["thread-1"]);
  });

  it("upserts provisional thread items from rpc notifications before refresh", () => {
    const provisionalItems = [];
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
        wsLastEventId: 0,
        wsRecentEventIds: new Set(),
        wsSubscribedEvents: true,
        wsSubscribedWorkspaceTarget: "wsl2",
      },
      setStatus() {},
      toRecord(value) {
        return value && typeof value === "object" ? value : null;
      },
      readString(value) {
        const text = String(value ?? "").trim();
        return text || "";
      },
      readNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      resetEventReplayState() {},
      markEventIdSeen() {},
      extractNotificationEventId() {
        return null;
      },
      extractNotificationThreadId() {
        return "thread-live";
      },
      shouldRefreshThreadsFromNotification() {
        return true;
      },
      shouldRefreshActiveThreadFromNotification() {
        return false;
      },
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
      renderLiveNotification() {},
      applyPendingPayloads() {},
      addChat() {},
      upsertProvisionalThreadItem(item) {
        provisionalItems.push(item);
        return true;
      },
      LAST_EVENT_ID_KEY: "last",
      localStorageRef: { setItem() {}, getItem() { return "0"; } },
      windowRef: { location: { protocol: "http:", host: "example.com" } },
      WebSocketRef: class {},
      fetchRef: async () => ({ ok: true, json: async () => ({}) }),
    });

    module.handleWsPayload({
      type: "rpc.notification",
      payload: {
        method: "codex/event/response_item",
        params: {
          payload: {
            type: "message",
            role: "user",
            thread_id: "thread-live",
            content: [{ type: "input_text", text: "queued prompt" }],
          },
        },
      },
    });

    expect(provisionalItems).toHaveLength(1);
    expect(provisionalItems[0]).toMatchObject({
      id: "thread-live",
      workspace: "wsl2",
      preview: "queued prompt",
      provisional: true,
    });
  });
});
