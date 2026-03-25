import { describe, expect, it } from "vitest";

import {
  chatDistanceFromMetrics,
  createChatViewportModule,
  isNearBottomForJumpButton,
} from "./chatViewport.js";

describe("chatViewport", () => {
  it("computes distance from bottom", () => {
    expect(chatDistanceFromMetrics(1200, 900, 250)).toBe(50);
    expect(chatDistanceFromMetrics(1200, 980, 250)).toBe(0);
  });

  it("uses threshold for jump button visibility", () => {
    expect(isNearBottomForJumpButton(1200, 820, 250, 180)).toBe(true);
    expect(isNearBottomForJumpButton(1200, 600, 250, 180)).toBe(false);
  });

  it("mounts the jump button on the chat panel overlay instead of inside the scrollable chat body", () => {
    const panel = {
      children: [],
      appendChild(node) {
        node.parentElement = this;
        this.children.push(node);
      },
    };
    const chatBox = {
      children: [],
      parentElement: panel,
      appendChild(node) {
        node.parentElement = this;
        this.children.push(node);
      },
    };
    const btn = {
      __wired: false,
      parentElement: null,
      onclick: null,
      style: {},
      classList: { toggle() {} },
      setAttribute() {},
    };
    const module = createChatViewportModule({
      state: {},
      byId(id) {
        if (id === "chatBox") return chatBox;
        if (id === "scrollToBottomBtn") return btn;
        return null;
      },
      dbgSet() {},
      documentRef: {
        querySelector() { return null; },
        createElement() {
          return {
            id: "",
            className: "",
            parentElement: null,
            children: [],
            appendChild(node) {
              node.parentElement = this;
              this.children.push(node);
            },
          };
        },
      },
      windowRef: {},
      requestAnimationFrameRef(callback) { return callback(0); },
      cancelAnimationFrameRef() {},
      CHAT_LIVE_FOLLOW_MAX_STEP_PX: 64,
      CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS: 66,
    });

    expect(module.ensureScrollToBottomBtn()).toBe(btn);
    expect(btn.parentElement).toBe(panel);
  });

  it("shows the jump button when chat is non-sticky and meaningfully away from bottom", () => {
    const toggles = [];
    const attrs = [];
    const chatBox = {
      scrollHeight: 1200,
      scrollTop: 600,
      clientHeight: 250,
      children: [],
      appendChild(node) {
        node.parentElement = this;
        this.children.push(node);
      },
    };
    const btn = {
      __wired: false,
      parentElement: null,
      onclick: null,
      style: {},
      disabled: true,
      tabIndex: -1,
      classList: {
        toggle(name, value) {
          toggles.push([name, value]);
        },
      },
      setAttribute(name, value) {
        attrs.push([name, value]);
      },
      blur() {},
    };
    const state = {
      chatShouldStickToBottom: false,
    };
    const module = createChatViewportModule({
      state,
      byId(id) {
        if (id === "chatBox") return chatBox;
        if (id === "scrollToBottomBtn") return btn;
        return null;
      },
      dbgSet() {},
      documentRef: {
        activeElement: null,
        createElement() {
          return {
            id: "",
            className: "",
            parentElement: null,
            children: [],
            appendChild(node) {
              node.parentElement = this;
              this.children.push(node);
            },
          };
        },
      },
      windowRef: {},
      requestAnimationFrameRef(callback) {
        return callback(0);
      },
      cancelAnimationFrameRef() {},
      CHAT_LIVE_FOLLOW_MAX_STEP_PX: 64,
      CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS: 66,
    });

    module.updateScrollToBottomBtn();

    expect(toggles).toContainEqual(["show", true]);
    expect(attrs).toContainEqual(["aria-hidden", "false"]);
    expect(btn.disabled).toBe(false);
    expect(btn.tabIndex).toBe(0);
  });

  it("hides the jump button when chat is already near bottom even if sticky mode is off", () => {
    const toggles = [];
    const attrs = [];
    const chatBox = {
      scrollHeight: 1200,
      scrollTop: 820,
      clientHeight: 250,
      children: [],
      appendChild(node) {
        node.parentElement = this;
        this.children.push(node);
      },
    };
    const btn = {
      __wired: false,
      parentElement: null,
      onclick: null,
      style: {},
      disabled: false,
      tabIndex: 0,
      classList: {
        toggle(name, value) {
          toggles.push([name, value]);
        },
      },
      setAttribute(name, value) {
        attrs.push([name, value]);
      },
      blur() {},
    };
    const state = {
      chatShouldStickToBottom: false,
    };
    const module = createChatViewportModule({
      state,
      byId(id) {
        if (id === "chatBox") return chatBox;
        if (id === "scrollToBottomBtn") return btn;
        return null;
      },
      dbgSet() {},
      documentRef: {
        activeElement: null,
        createElement() {
          return {
            id: "",
            className: "",
            parentElement: null,
            children: [],
            appendChild(node) {
              node.parentElement = this;
              this.children.push(node);
            },
          };
        },
      },
      windowRef: {},
      requestAnimationFrameRef(callback) {
        return callback(0);
      },
      cancelAnimationFrameRef() {},
      CHAT_LIVE_FOLLOW_MAX_STEP_PX: 64,
      CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS: 66,
    });

    module.updateScrollToBottomBtn();

    expect(toggles).toContainEqual(["show", false]);
    expect(attrs).toContainEqual(["aria-hidden", "true"]);
    expect(btn.disabled).toBe(true);
    expect(btn.tabIndex).toBe(-1);
  });
});
