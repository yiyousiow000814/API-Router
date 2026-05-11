import { describe, expect, it } from "vitest";

import { applyFullHistoryRender } from "./historyRenderApply.js";

describe("historyRenderApply", () => {
  it("passes canonical message ids as render keys for history messages", async () => {
    const added = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadStarted: true,
      activeThreadMessages: [],
      chatShouldStickToBottom: false,
    };

    await applyFullHistoryRender({
      state,
      threadId: "thread-1",
      messages: [
        {
          id: "assistant:turn-1:item-1",
          role: "assistant",
          text: "done",
          kind: "",
        },
      ],
      prevMessages: [],
      box: null,
      preservedScrollTop: null,
      inlineCommentaryArchiveCount: 0,
      renderSig: "thread-1::assistant",
      toolCount: 0,
      forceFullRender: false,
      options: {},
      historyCommentary: null,
      liveCommentarySnapshot: null,
      deps: {
        renderMessageBody() {
          return "";
        },
        addChat(role, text, options = {}) {
          added.push({ role, text, options });
          return {};
        },
        buildMsgNode() {
          return {};
        },
        clearChatMessages() {},
        renderChatFull: async () => {},
        pushLiveDebugEvent() {},
        scrollChatToBottom() {},
        canStartChatLiveFollow() {
          return false;
        },
        maybeScheduleChatFollow() {},
        replayAssistantHistoryMessage() {
          return false;
        },
        finalizeThreadRenderEffects() {},
      },
    });

    expect(added).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "",
        options: expect.objectContaining({
          messageKey: "assistant:turn-1:item-1",
          source: "historyRender",
        }),
      }),
    ]);
    expect(state.activeThreadMessages).toEqual([
      expect.objectContaining({ id: "assistant:turn-1:item-1", text: "done" }),
    ]);
  });

  it("starts replayable assistant history appends from an empty body instead of the final text", async () => {
    const added = [];
    const replayed = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadStarted: true,
      activeThreadMessages: [],
      chatShouldStickToBottom: false,
    };

    await applyFullHistoryRender({
      state,
      threadId: "thread-1",
      messages: [
        { role: "user", text: "hi", kind: "" },
        { role: "assistant", text: "done", kind: "" },
      ],
      prevMessages: [{ role: "user", text: "hi", kind: "" }],
      box: null,
      preservedScrollTop: null,
      inlineCommentaryArchiveCount: 0,
      renderSig: "thread-1::assistant",
      toolCount: 0,
      forceFullRender: false,
      options: {},
      historyCommentary: null,
      liveCommentarySnapshot: null,
      deps: {
        renderMessageBody() {
          return "";
        },
        addChat(role, text, options = {}) {
          added.push({ role, text, options });
          return {};
        },
        buildMsgNode() {
          return {};
        },
        clearChatMessages() {},
        renderChatFull: async () => {},
        pushLiveDebugEvent() {},
        scrollChatToBottom() {},
        canStartChatLiveFollow() {
          return false;
        },
        maybeScheduleChatFollow() {},
        scrollToBottomReliable() {},
        scheduleChatLiveFollow() {},
        replayAssistantHistoryMessage(node, message, options = {}) {
          replayed.push({
            text: String(message?.text || ""),
            fromText: String(options.fromText || ""),
          });
          return true;
        },
        finalizeThreadRenderEffects() {},
      },
    });

    expect(added).toEqual([
      expect.objectContaining({ role: "assistant", text: "" }),
    ]);
    expect(replayed).toEqual([
      expect.objectContaining({ text: "done", fromText: "" }),
    ]);
  });

  it("restores the previous assistant text before replaying a last-message update", async () => {
    const userNode = {
      classList: { contains(token) { return token === "user"; } },
      querySelector() { return null; },
      setAttribute() {},
    };
    const assistantBody = {
      innerHTML: "",
      setAttribute() {},
      removeAttribute() {},
    };
    const assistantNode = {
      classList: { contains(token) { return token === "assistant"; } },
      querySelector(selector) {
        return selector === ".msgBody" ? assistantBody : null;
      },
      setAttribute() {},
      removeAttribute() {},
    };
    const box = {
      querySelectorAll(selector) {
        return selector === ".msg" ? [userNode, assistantNode] : [];
      },
      scrollHeight: 0,
      clientHeight: 0,
      scrollTop: 0,
    };
    const replayed = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadStarted: true,
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "assistant", text: "draft", kind: "" },
      ],
      chatShouldStickToBottom: false,
    };

    await applyFullHistoryRender({
      state,
      threadId: "thread-1",
      messages: [
        { role: "user", text: "hi", kind: "" },
        { role: "assistant", text: "done", kind: "" },
      ],
      prevMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "assistant", text: "draft", kind: "" },
      ],
      box,
      preservedScrollTop: null,
      inlineCommentaryArchiveCount: 0,
      renderSig: "thread-1::assistant",
      toolCount: 0,
      forceFullRender: false,
      options: {},
      historyCommentary: null,
      liveCommentarySnapshot: null,
      deps: {
        renderMessageBody: (_role, text) => String(text || ""),
        addChat() {
          throw new Error("unexpected addChat call");
        },
        buildMsgNode() {
          return {};
        },
        clearChatMessages() {},
        renderChatFull: async () => {},
        pushLiveDebugEvent() {},
        scrollChatToBottom() {},
        canStartChatLiveFollow() {
          return false;
        },
        maybeScheduleChatFollow() {},
        scrollToBottomReliable() {},
        scheduleChatLiveFollow() {},
        replayAssistantHistoryMessage(node, message, options = {}) {
          replayed.push({
            text: String(message?.text || ""),
            fromText: String(options.fromText || ""),
          });
          return true;
        },
        finalizeThreadRenderEffects() {},
      },
    });

    expect(assistantBody.innerHTML).toBe("draft");
    expect(replayed).toEqual([
      expect.objectContaining({ text: "done", fromText: "draft" }),
    ]);
  });
});
