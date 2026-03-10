import { describe, expect, it } from "vitest";

import { createLiveNotificationsModule, workspaceKeyOfThread } from "./liveNotifications.js";

describe("liveNotifications", () => {
  it("extracts workspace key from thread cwd", () => {
    expect(workspaceKeyOfThread({ cwd: "src/ui" })).toBe("ui");
  });

  it("formats command execution items", () => {
    const { toToolLikeMessage } = createLiveNotificationsModule({
      state: { activeThreadId: "" },
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) { return String(value || "").toLowerCase(); },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId() { return ""; },
    });
    expect(toToolLikeMessage({ type: "commandExecution", command: "pwd", exitCode: 0 })).toContain("pwd");
  });

  it("streams assistant deltas into the active thread", () => {
    const appended = [];
    const finalized = [];
    const created = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) { return String(value || "").toLowerCase(); },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.conversationId || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        const msg = { setAttribute() {} };
        const body = {};
        created.push({ msg, body });
        return { msg, body };
      },
      appendStreamingDelta(body, text) {
        appended.push({ body, text });
      },
      finalizeAssistantMessage(msg, body, text) {
        finalized.push({ msg, body, text });
      },
    });

    module.renderLiveNotification({
      method: "turn/assistant/delta",
      params: { threadId: "thread-1", delta: "hello" },
    });
    module.renderLiveNotification({
      method: "turn/assistant/delta",
      params: { threadId: "thread-1", delta: " world" },
    });
    module.renderLiveNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" },
    });

    expect(created).toHaveLength(1);
    expect(appended.map((item) => item.text)).toEqual(["hello", " world"]);
    expect(state.activeThreadMessages).toEqual([{ role: "assistant", text: "hello world", kind: "" }]);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].text).toBe("hello world");
  });
});
