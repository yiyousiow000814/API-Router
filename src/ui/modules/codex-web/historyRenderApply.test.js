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
        text: "done",
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
});
