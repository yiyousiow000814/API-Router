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

  it("mounts the jump button inside chatBox instead of the outer panel", () => {
    const chatBox = {
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
      documentRef: { querySelector() { return null; } },
      windowRef: {},
      requestAnimationFrameRef(callback) { return callback(0); },
      cancelAnimationFrameRef() {},
      CHAT_LIVE_FOLLOW_MAX_STEP_PX: 64,
      CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS: 66,
    });

    expect(module.ensureScrollToBottomBtn()).toBe(btn);
    expect(btn.parentElement).toBe(chatBox);
  });
});
