import { describe, expect, it } from "vitest";

import {
  extractNotificationEventId,
  extractNotificationThreadId,
  synthesizeProvisionalThreadItem,
  shouldRefreshActiveThreadFromNotification,
  shouldRefreshThreadsFromNotification,
} from "./notificationRouting.js";

describe("notificationRouting", () => {
  it("extracts event ids from both spellings", () => {
    expect(extractNotificationEventId({ eventId: 12.9 })).toBe(12);
    expect(extractNotificationEventId({ event_id: "7" })).toBe(7);
    expect(extractNotificationEventId({ eventId: 0 })).toBeNull();
  });

  it("extracts session_id from notification params", () => {
    expect(
      extractNotificationThreadId({
        method: "thread/status",
        params: { session_id: "session-1" },
      })
    ).toBe("session-1");
  });

  it("extracts nested sessionId from turn payloads", () => {
    expect(
      extractNotificationThreadId({
        method: "turn/status",
        params: { turn: { sessionId: "session-2" } },
      })
    ).toBe("session-2");
  });

  it("keeps existing thread and conversation id extraction", () => {
    expect(
      extractNotificationThreadId({
        method: "item/updated",
        params: { item: { threadId: "thread-1" } },
      })
    ).toBe("thread-1");
    expect(
      extractNotificationThreadId({
        method: "thread/status",
        params: { conversationId: "thread-2" },
      })
    ).toBe("thread-2");
  });

  it("matches refresh-worthy notification methods", () => {
    expect(shouldRefreshThreadsFromNotification("turn/completed")).toBe(true);
    expect(shouldRefreshThreadsFromNotification("turn.completed")).toBe(true);
    expect(shouldRefreshThreadsFromNotification("item_completed")).toBe(true);
    expect(shouldRefreshThreadsFromNotification("thread/status")).toBe(true);
    expect(shouldRefreshThreadsFromNotification("noop")).toBe(false);
    expect(shouldRefreshActiveThreadFromNotification("turn/started")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("turn/completed")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("turn.failed")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("thread/status")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("thread/status/changed")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("thread.status.changed")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("item.started")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("item_completed")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("codex/event/response_item")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("codex/event/agent_message")).toBe(true);
    expect(shouldRefreshActiveThreadFromNotification("turn/assistant/delta")).toBe(false);
    expect(shouldRefreshActiveThreadFromNotification("item.updated")).toBe(false);
    expect(shouldRefreshActiveThreadFromNotification("codex/event/agent_message_content_delta")).toBe(false);
    expect(shouldRefreshActiveThreadFromNotification("codex/event/agent_reasoning")).toBe(false);
  });

  it("synthesizes provisional thread items from live notifications", () => {
    const item = synthesizeProvisionalThreadItem(
      {
        method: "codex/event/response_item",
        params: {
          workspace: "wsl2",
          rolloutPath: "/home/yiyou/.codex/sessions/rollout.jsonl",
          payload: {
            type: "message",
            role: "user",
            thread_id: "thread-1",
            content: [{ type: "input_text", text: "build exe" }],
          },
        },
      },
      "windows",
      1742340000000
    );

    expect(item).toEqual({
      id: "thread-1",
      threadId: "thread-1",
      workspace: "wsl2",
      __workspaceQueryTarget: "wsl2",
      source: "live-provisional",
      provisional: true,
      updatedAt: 1742340000000,
      path: "/home/yiyou/.codex/sessions/rollout.jsonl",
      preview: "build exe",
      title: "build exe",
    });
  });
});
