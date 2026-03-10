import { beforeEach, describe, expect, it, vi } from "vitest";

import { createChatTimelineModule } from "./chatTimeline.js";

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.set = new Set();
  }

  add(...tokens) {
    for (const token of tokens) if (token) this.set.add(token);
    this.owner.className = [...this.set].join(" ");
  }

  remove(...tokens) {
    for (const token of tokens) this.set.delete(token);
    this.owner.className = [...this.set].join(" ");
  }

  contains(token) {
    return this.set.has(token);
  }

  toggle(token, force) {
    if (force === true) {
      this.add(token);
      return true;
    }
    if (force === false) {
      this.remove(token);
      return false;
    }
    if (this.contains(token)) {
      this.remove(token);
      return false;
    }
    this.add(token);
    return true;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.style = {
      values: new Map(),
      setProperty(name, value) {
        this.values.set(String(name), String(value));
      },
      removeProperty(name) {
        this.values.delete(String(name));
      },
    };
    this.dataset = {};
    this.attributes = new Map();
    this._className = "";
    this.classList = new FakeClassList(this);
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.__wiredLoadOlder = false;
    this._id = "";
    this._innerHTML = "";
  }

  set className(value) {
    this._className = String(value || "");
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  get className() {
    return this._className;
  }

  set id(value) {
    this._id = String(value || "");
    if (this._id) this.ownerDocument.ids.set(this._id, this);
  }

  get id() {
    return this._id;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    this.textContent = "";
    const divPattern = /<div class="([^"]+)">([\s\S]*?)<\/div>/g;
    let match = null;
    while ((match = divPattern.exec(this._innerHTML))) {
      const child = new FakeElement("div", this.ownerDocument);
      child.className = match[1];
      for (const token of match[1].split(/\s+/).filter(Boolean)) child.classList.add(token);
      child.textContent = match[2].replace(/<[^>]+>/g, "");
      child.parentElement = this;
      this.children.push(child);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  get childNodes() {
    return this.children;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  insertBefore(child, anchor) {
    child.parentElement = this;
    const index = anchor ? this.children.indexOf(anchor) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matcher = selector.startsWith(".")
      ? (node) => node.classList.contains(selector.slice(1))
      : selector.startsWith("#")
        ? (node) => node.id === selector.slice(1)
        : (node) => node.tagName.toLowerCase() === selector.toLowerCase();
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matcher(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  addEventListener() {}
}

class FakeDocument {
  constructor() {
    this.ids = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.ids.get(String(id)) || null;
  }
}

function createFakeDom() {
  const documentRef = new FakeDocument();
  const chatBox = documentRef.createElement("div");
  chatBox.id = "chatBox";
  const welcomeCard = documentRef.createElement("div");
  welcomeCard.id = "welcomeCard";
  const overlay = documentRef.createElement("div");
  overlay.id = "chatOpeningOverlay";
  chatBox.appendChild(welcomeCard);
  chatBox.appendChild(overlay);
  return { documentRef, chatBox, welcomeCard, overlay };
}

describe("chatTimeline", () => {
  let state;
  let refs;
  let module;
  let dom;

  beforeEach(() => {
    dom = createFakeDom();
    state = {
      chatShouldStickToBottom: false,
      chatUserScrolledAwayAt: 1,
      chatProgrammaticScrollUntil: 0,
      activeThreadRenderSig: "sig",
      activeThreadMessages: [{ role: "user", text: "x" }],
      historyWindowEnabled: true,
      historyWindowThreadId: "thread-1",
      historyWindowStart: 8,
      historyWindowLoading: true,
      historyAllMessages: [{ role: "user", text: "x" }],
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryHasMore: true,
      activeThreadHistoryIncomplete: true,
      activeThreadHistoryBeforeCursor: "cursor-1",
      activeThreadHistoryTotalTurns: 4,
      activeThreadHistoryReqSeq: 9,
      activeThreadHistoryInFlightPromise: Promise.resolve(),
      activeThreadHistoryInFlightThreadId: "thread-1",
      activeThreadHistoryPendingRefresh: { threadId: "thread-1" },
    };
    refs = {
      scheduleChatLiveFollow: vi.fn(),
      updateScrollToBottomBtn: vi.fn(),
      scrollChatToBottom: vi.fn(),
      requestAnimationFrameRef: (cb) => cb(),
    };
    module = createChatTimelineModule({
      byId: (id) => dom.documentRef.getElementById(id),
      state,
      escapeHtml: (value) => String(value || ""),
      renderMessageAttachments: (items = []) => (items.length ? `<div class="attachments">${items.length}</div>` : ""),
      renderMessageBody: (_role, text) => `<span>${String(text || "")}</span>`,
      wireMessageLinks: vi.fn(),
      wireMessageAttachments: vi.fn(),
      ...refs,
      documentRef: dom.documentRef,
    });
  });

  it("clears chat state while preserving persistent nodes", () => {
    const extra = dom.documentRef.createElement("div");
    extra.classList.add("msg");
    dom.chatBox.appendChild(extra);

    module.clearChatMessages();

    expect(dom.chatBox.children).toHaveLength(2);
    expect(dom.documentRef.getElementById("welcomeCard")).not.toBeNull();
    expect(dom.documentRef.getElementById("chatOpeningOverlay")).not.toBeNull();
    expect(state.activeThreadRenderSig).toBe("");
    expect(state.historyWindowEnabled).toBe(false);
    expect(state.activeThreadHistoryTurns).toEqual([]);
    expect(state.activeThreadHistoryPendingRefresh).toBeNull();
  });

  it("opens chat overlay and resets sticky state", () => {
    module.setChatOpening(true);

    expect(dom.overlay.classList.contains("show")).toBe(true);
    expect(state.chatShouldStickToBottom).toBe(true);
    expect(state.chatUserScrolledAwayAt).toBe(0);
  });

  it("buffers and flushes streaming chunks", () => {
    const { body } = module.createAssistantStreamingMessage();
    module.appendStreamingDelta(body, "hello\nworld");

    expect(body.querySelectorAll(".streamChunk")).toHaveLength(2);
    expect(body.querySelectorAll("br")).toHaveLength(1);
  });
});
