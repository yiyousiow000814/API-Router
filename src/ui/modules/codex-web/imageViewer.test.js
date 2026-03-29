import { describe, expect, it, vi } from "vitest";

import { createImageViewerModule } from "./imageViewer.js";

describe("imageViewer", () => {
  it("keeps a missing attachment placeholder and avoids force scrolling on image errors", () => {
    const scrollChatToBottom = vi.fn();
    const updateScrollToBottomBtn = vi.fn();
    const card = {
      __wired: false,
      __brokenAttachment: false,
      innerHTML: "",
      _attrs: new Map([
        ["data-image-src", "/codex/file?path=%2Fmnt%2Fc%2Ftmp.png"],
        ["data-image-label", "Image #1"],
      ]),
      listeners: {},
      addEventListener(type, callback) {
        this.listeners[type] = callback;
      },
      getAttribute(name) {
        return this._attrs.get(name) || "";
      },
      setAttribute(name, value) {
        this._attrs.set(name, String(value));
      },
      querySelector(selector) {
        if (selector === ".msgAttachmentMoreOverlay") {
          return { outerHTML: '<div class="msgAttachmentMoreOverlay">+2</div>' };
        }
        return null;
      },
      classList: {
        added: [],
        add(name) {
          this.added.push(name);
        },
      },
    };
    const img = {
      __wiredLoad: false,
      complete: false,
      naturalWidth: 0,
      listeners: {},
      addEventListener(type, callback) {
        this.listeners[type] = callback;
      },
      closest(selector) {
        if (selector === ".msgAttachmentCard") return card;
        return null;
      },
    };
    const container = {
      querySelectorAll(selector) {
        if (selector === ".msgAttachmentCard") return [card];
        if (selector === "img.msgAttachmentImage") return [img];
        return [];
      },
    };
    const module = createImageViewerModule({
      byId: () => null,
      state: {
        chatSmoothScrollUntil: 0,
        chatShouldStickToBottom: true,
      },
      escapeHtml: (value) => String(value || ""),
      wireBlurBackdropShield: () => {},
      scrollChatToBottom,
      updateScrollToBottomBtn,
      documentRef: {
        querySelectorAll() {
          return [];
        },
      },
      navigatorRef: {},
      requestAnimationFrameRef: (callback) => callback(),
    });

    module.wireMessageAttachments(container);
    img.listeners.error();

    expect(card.getAttribute("data-image-src")).toBe("");
    expect(card.innerHTML).toContain("[image]");
    expect(card.innerHTML).toContain("#1");
    expect(card.innerHTML).toContain("msgAttachmentMoreOverlay");
    expect(card.classList.added).toContain("msgAttachmentCard-missing");
    expect(scrollChatToBottom).not.toHaveBeenCalled();
    expect(updateScrollToBottomBtn).toHaveBeenCalled();
  });
});
