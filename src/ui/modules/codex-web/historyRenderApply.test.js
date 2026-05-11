import { describe, expect, it } from "vitest";

import { applyFullHistoryRender } from "./historyRenderApply.js";

function createFakeNode({ className = "", id = "", text = "" } = {}) {
  const body = String(className || "").split(/\s+/).includes("msg")
    ? { innerHTML: "", parentElement: null }
    : null;
  const node = {
    className,
    id,
    textContent: text,
    parentElement: null,
    children: [],
    body,
    remove() {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    },
    setAttribute() {},
    querySelector(selector) {
      if (selector === ".msgBody") return this.body || null;
      return null;
    },
  };
  if (body) body.parentElement = node;
  node.classList = {
    contains(token) {
      return String(node.className || "").split(/\s+/).includes(token);
    },
  };
  return node;
}

function createFakeBox(children = []) {
  const box = {
    children: [],
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
    appendChild(child) {
      child.parentElement = box;
      box.children.push(child);
      return child;
    },
    insertBefore(child, anchor) {
      child.parentElement = box;
      const index = anchor ? box.children.indexOf(anchor) : -1;
      if (index < 0) box.children.push(child);
      else box.children.splice(index, 0, child);
      return child;
    },
    querySelector(selector) {
      if (selector === "#commentaryArchiveMount") {
        return box.children.find((child) => String(child.id || "") === "commentaryArchiveMount") || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".msg" || selector === ".assistant" || selector === ".commentaryArchiveMount") {
        return box.children.filter((child) => child.classList?.contains?.("msg") || child.classList?.contains?.("commentaryArchiveMount"));
      }
      return [];
    },
    replaceChildren(...nextChildren) {
      box.children = [];
      for (const child of nextChildren) box.appendChild(child);
    },
  };
  for (const child of children) box.appendChild(child);
  return box;
}

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

  it("keeps commentary above the final assistant when history catches up to a live assistant", async () => {
    const userNode = createFakeNode({ className: "msg user", text: "hi" });
    const liveAssistantNode = createFakeNode({ className: "msg assistant", text: "draft final" });
    const box = createFakeBox([userNode, liveAssistantNode]);
    const rendered = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadStarted: true,
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "assistant", text: "draft final", kind: "" },
      ],
      chatShouldStickToBottom: false,
    };

    await applyFullHistoryRender({
      state,
      threadId: "thread-1",
      messages: [
        { role: "user", text: "hi", kind: "" },
        { role: "system", kind: "commentaryArchive", archiveBlocks: [{ text: "tools ran" }] },
        { role: "assistant", text: "final answer", kind: "" },
      ],
      prevMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "assistant", text: "draft final", kind: "" },
      ],
      box,
      preservedScrollTop: null,
      inlineCommentaryArchiveCount: 0,
      renderSig: "thread-1::history",
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
          const className =
            options.kind === "commentaryArchive"
              ? "commentaryArchiveMount"
              : `msg ${role}${options.kind ? ` kind-${options.kind}` : ""}`;
          const node = createFakeNode({ className, text });
          if (options.kind === "commentaryArchive") {
            node.id = "commentaryArchiveMount";
          }
          box.appendChild(node);
          rendered.push({ role, text, options });
          return node;
        },
        buildMsgNode(msg) {
          return createFakeNode({
            className: msg?.kind === "commentaryArchive" ? "commentaryArchiveMount" : `msg ${msg?.role || ""}`,
            text: String(msg?.text || ""),
          });
        },
        clearChatMessages() {
          box.children = [];
        },
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

    expect(rendered.some((entry) => entry.options?.kind === "commentaryArchive")).toBe(false);
    expect(box.children.map((child) => child.className)).toEqual([
      "msg user",
      "commentaryArchiveMount",
      "msg assistant",
    ]);
  });
});
