import { describe, expect, it } from "vitest";

import { applyFullHistoryRender } from "./historyRenderApply.js";

function createFakeNode({ className = "", id = "", text = "" } = {}) {
  const body = String(className || "").split(/\s+/).includes("msg")
    ? { innerHTML: "", parentElement: null }
    : null;
  const attrs = new Map();
  const node = {
    className,
    id,
    attrs,
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
    getAttribute(name) {
      return this.attrs.get(String(name)) || "";
    },
    setAttribute(name, value) {
      this.attrs.set(String(name), String(value));
    },
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
      const currentIndex = box.children.indexOf(child);
      if (currentIndex >= 0) box.children.splice(currentIndex, 1);
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

  it("renders a large newly opened history through the async full-render path", async () => {
    const rendered = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadStarted: true,
      activeThreadMessages: [],
      chatShouldStickToBottom: true,
    };
    const messages = Array.from({ length: 90 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index}`,
      kind: "",
      id: `message:${index}`,
    }));

    await applyFullHistoryRender({
      state,
      threadId: "thread-1",
      messages,
      prevMessages: [],
      box: null,
      preservedScrollTop: null,
      inlineCommentaryArchiveCount: 0,
      renderSig: "thread-1::large",
      toolCount: 0,
      forceFullRender: false,
      options: {},
      historyCommentary: null,
      liveCommentarySnapshot: null,
      deps: {
        renderMessageBody() {
          return "";
        },
        addChat() {
          throw new Error("expected async renderChatFull instead of synchronous append");
        },
        buildMsgNode() {
          return {};
        },
        clearChatMessages() {},
        async renderChatFull(nextMessages, options = {}) {
          rendered.push({ messages: nextMessages.length, options });
        },
        pushLiveDebugEvent() {},
        scrollChatToBottom() {},
        canStartChatLiveFollow() {
          return false;
        },
        maybeScheduleChatFollow() {},
        replayAssistantHistoryMessage() {
          return false;
        },
        scrollToBottomReliable() {},
        scheduleChatLiveFollow() {},
        finalizeThreadRenderEffects() {},
      },
    });

    expect(rendered).toEqual([
      expect.objectContaining({
        messages: 90,
        options: expect.objectContaining({ preserveScroll: true }),
      }),
    ]);
    expect(state.activeThreadMessages).toHaveLength(90);
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
        { role: "assistant", text: "final answer", kind: "", id: "assistant:turn-1:item-1" },
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

  it("does not append a duplicate final when the DOM has a live assistant that state missed", async () => {
    const userNode = createFakeNode({ className: "msg user", text: "hi" });
    const liveAssistantNode = createFakeNode({ className: "msg assistant", text: "final answer" });
    const box = createFakeBox([userNode, liveAssistantNode]);
    const appended = [];
    const clearCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadStarted: true,
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      chatShouldStickToBottom: false,
    };

    await applyFullHistoryRender({
      state,
      threadId: "thread-1",
      messages: [
        { role: "user", text: "hi", kind: "" },
        { role: "system", kind: "commentaryArchive", archiveBlocks: [{ text: "tools ran" }] },
        { role: "assistant", text: "final answer", kind: "", id: "assistant:turn-1:item-1" },
      ],
      prevMessages: [{ role: "user", text: "hi", kind: "" }],
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
          appended.push({ role, text, options });
          return node;
        },
        buildMsgNode(msg) {
          return createFakeNode({
            className: msg?.kind === "commentaryArchive" ? "commentaryArchiveMount" : `msg ${msg?.role || ""}`,
            text: String(msg?.text || ""),
          });
        },
        clearChatMessages(options = {}) {
          clearCalls.push(options);
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

    expect(appended).toEqual([]);
    expect(clearCalls).toEqual([]);
    expect(box.children.map((child) => child.className)).toEqual([
      "msg user",
      "commentaryArchiveMount",
      "msg assistant",
    ]);
    expect(box.children.filter((child) => child.classList.contains("assistant"))).toHaveLength(1);
    expect(box.children[2]).toBe(liveAssistantNode);
    expect(liveAssistantNode.getAttribute("data-msg-key")).toBe("assistant:turn-1:item-1");
    expect(state.activeThreadMessages).toEqual([
      expect.objectContaining({ role: "user", text: "hi" }),
      expect.objectContaining({ role: "system", kind: "commentaryArchive" }),
      expect.objectContaining({ role: "assistant", text: "final answer", id: "assistant:turn-1:item-1" }),
    ]);
  });
});
