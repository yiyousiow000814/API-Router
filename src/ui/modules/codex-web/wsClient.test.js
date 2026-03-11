import { describe, expect, it } from "vitest";

import {
  buildCodexWsUrl,
  createWsClientModule,
  ensureArrayItems,
  normalizeLiveWorkspaceTarget,
  resolveApiErrorMessage,
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

  it("prefers structured api errors", () => {
    expect(resolveApiErrorMessage({ error: { detail: "boom" } }, 500)).toBe("boom");
    expect(resolveApiErrorMessage({}, 404)).toBe("HTTP 404");
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
  });

  it("resets replay cursor when backend asks for resync", () => {
    const statuses = [];
    let resetCalls = 0;
    const module = createWsClientModule({
      state: {
        token: "",
        ws: null,
        wsReqHandlers: new Map(),
        pendingApprovals: [],
        pendingUserInputs: [],
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
      scheduleThreadRefresh() {},
      scheduleActiveThreadRefresh() {},
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
});
