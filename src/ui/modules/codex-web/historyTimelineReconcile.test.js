import { describe, expect, it } from "vitest";

import { reconcileTimelineMessages } from "./historyTimelineReconcile.js";

function createFakeNode({ className = "", id = "", text = "" } = {}) {
  const body = String(className || "").split(/\s+/).includes("msg")
    ? { innerHTML: "", parentElement: null }
    : null;
  const node = {
    className,
    id,
    textContent: text,
    parentElement: null,
    body,
    remove() {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    },
    querySelector(selector) {
      if (selector === ".msgBody") return this.body || null;
      return null;
    },
    setAttribute() {},
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
  };
  for (const child of children) box.appendChild(child);
  return box;
}

describe("historyTimelineReconcile", () => {
  it("does not mutate the DOM when an archive patch cannot be completed", () => {
    const userNode = createFakeNode({ className: "msg user", text: "hi" });
    const box = createFakeBox([userNode]);

    const result = reconcileTimelineMessages({
      box,
      previousMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "assistant", text: "draft", kind: "" },
      ],
      nextMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "system", kind: "commentaryArchive", archiveBlocks: [{ text: "tools ran" }] },
        { role: "assistant", text: "final", kind: "" },
      ],
      buildMsgNode(msg) {
        return createFakeNode({
          className: msg?.kind === "commentaryArchive" ? "commentaryArchiveMount" : `msg ${msg?.role || ""}`,
          text: String(msg?.text || ""),
        });
      },
      renderMessageBody(_role, text) {
        return String(text || "");
      },
    });

    expect(result).toBeNull();
    expect(box.children).toEqual([userNode]);
  });

  it("replaces the live archive mount when applying a canonical archive patch", () => {
    const userNode = createFakeNode({ className: "msg user", text: "hi" });
    const liveArchiveNode = createFakeNode({ className: "commentaryArchiveMount", id: "commentaryArchiveMount", text: "live tools" });
    const assistantNode = createFakeNode({ className: "msg assistant", text: "final" });
    const box = createFakeBox([userNode, liveArchiveNode, assistantNode]);

    const result = reconcileTimelineMessages({
      box,
      previousMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "assistant", text: "final", kind: "" },
      ],
      nextMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "system", kind: "commentaryArchive", archiveBlocks: [{ text: "tools ran" }] },
        { role: "assistant", text: "final", kind: "" },
      ],
      buildMsgNode(msg) {
        return createFakeNode({
          className: msg?.kind === "commentaryArchive" ? "commentaryArchiveMount" : `msg ${msg?.role || ""}`,
          text: String(msg?.text || ""),
        });
      },
      renderMessageBody(_role, text) {
        return String(text || "");
      },
    });

    expect(result).toEqual(expect.objectContaining({ inserted: 1, updated: 0 }));
    expect(box.children).toHaveLength(3);
    expect(box.children[0]).toBe(userNode);
    expect(box.children[1]).not.toBe(liveArchiveNode);
    expect(box.children[1].className).toBe("commentaryArchiveMount");
    expect(box.children[2]).toBe(assistantNode);
  });
});
