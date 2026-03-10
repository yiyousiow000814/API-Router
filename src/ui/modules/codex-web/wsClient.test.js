import { describe, expect, it } from "vitest";

import {
  buildCodexWsUrl,
  createWsClientModule,
  ensureArrayItems,
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

  it("prefers structured api errors", () => {
    expect(resolveApiErrorMessage({ error: { detail: "boom" } }, 500)).toBe("boom");
    expect(resolveApiErrorMessage({}, 404)).toBe("HTTP 404");
  });

  it("preserves conversation id on ui assistant delta notifications", () => {
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
  });
});
