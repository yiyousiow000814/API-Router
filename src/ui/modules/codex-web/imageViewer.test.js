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

  it("opens pdf previews at page width inside the app", () => {
    const elements = new Map();
    const backdrop = {
      classList: {
        add() {},
        remove() {},
      },
      appendChild() {},
      innerHTML: "",
      ownerDocument: null,
    };
    const frame = { src: "" };
    const title = { textContent: "" };
    const text = { hidden: false, innerHTML: "" };
    const unsupported = { hidden: false, innerHTML: "" };
    const loading = { hidden: false };
    const download = { onclick: null };
    const backBtn = { onclick: null };
    elements.set("filePreviewBackdrop", backdrop);
    elements.set("filePreviewFrame", frame);
    elements.set("filePreviewTitle", title);
    elements.set("filePreviewText", text);
    elements.set("filePreviewUnsupported", unsupported);
    elements.set("filePreviewLoading", loading);
    elements.set("filePreviewDownloadBtn", download);
    elements.set("filePreviewBackBtn", backBtn);
    const module = createImageViewerModule({
      byId: (id) => elements.get(id) || null,
      state: {
        chatSmoothScrollUntil: 0,
        chatShouldStickToBottom: true,
      },
      escapeHtml: (value) => String(value || ""),
      wireBlurBackdropShield: () => {},
      scrollChatToBottom: () => {},
      updateScrollToBottomBtn: () => {},
      documentRef: {
        body: { appendChild() {} },
        createElement() {
          return {};
        },
        addEventListener() {},
      },
      navigatorRef: {},
      requestAnimationFrameRef: (callback) => callback(),
    });

    expect(module.openFilePreview("/codex/file?path=C%3A%5Cuploads%5Creport.pdf", "report.pdf", { fileName: "report.pdf", mimeType: "application/pdf" })).toBe(true);
    expect(frame.src).toBe("/codex/file?path=C%3A%5Cuploads%5Creport.pdf#view=FitH&zoom=page-width");
    expect(title.textContent).toBe("report.pdf");
    expect(frame.hidden).toBe(false);
    expect(text.hidden).toBe(true);
    expect(unsupported.hidden).toBe(true);
    expect(loading.hidden).toBe(true);
  });

  it("renders markdown file previews without using a frame", async () => {
    const elements = new Map();
    const backdrop = {
      classList: {
        add() {},
        remove() {},
      },
      innerHTML: "",
    };
    const frame = { src: "" };
    const title = { textContent: "" };
    const text = { hidden: false, innerHTML: "" };
    const unsupported = { hidden: false, innerHTML: "" };
    const loading = { hidden: false };
    const download = { onclick: null };
    const backBtn = { onclick: null };
    elements.set("filePreviewBackdrop", backdrop);
    elements.set("filePreviewFrame", frame);
    elements.set("filePreviewTitle", title);
    elements.set("filePreviewText", text);
    elements.set("filePreviewUnsupported", unsupported);
    elements.set("filePreviewLoading", loading);
    elements.set("filePreviewDownloadBtn", download);
    elements.set("filePreviewBackBtn", backBtn);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "# Notes\n\nhello",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const module = createImageViewerModule({
      byId: (id) => elements.get(id) || null,
      state: {
        chatSmoothScrollUntil: 0,
        chatShouldStickToBottom: true,
      },
      escapeHtml: (value) => String(value || ""),
      wireBlurBackdropShield: () => {},
      scrollChatToBottom: () => {},
      updateScrollToBottomBtn: () => {},
      documentRef: {
        body: { appendChild() {} },
        createElement() {
          return {};
        },
        addEventListener() {},
      },
      navigatorRef: {},
      requestAnimationFrameRef: (callback) => callback(),
    });

    expect(module.openFilePreview("/codex/file?path=C%3A%5Cuploads%5Cnotes.md", "notes.md", { fileName: "notes.md", mimeType: "text/markdown" })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith("/codex/file?path=C%3A%5Cuploads%5Cnotes.md", { credentials: "same-origin" });
    expect(frame.hidden).toBe(true);
    expect(frame.src).toBe("about:blank");
    expect(text.hidden).toBe(false);
    expect(text.innerHTML).toContain("<h1");
    expect(text.innerHTML).toContain("Notes");
    expect(unsupported.hidden).toBe(true);
    expect(loading.hidden).toBe(true);
    vi.unstubAllGlobals();
  });

  it("shows an in-app unsupported preview state for binary files", () => {
    const elements = new Map();
    const backdrop = {
      classList: {
        add() {},
        remove() {},
      },
      innerHTML: "",
    };
    const frame = { src: "" };
    const title = { textContent: "" };
    const text = { hidden: false, innerHTML: "" };
    const unsupported = { hidden: false, innerHTML: "" };
    const loading = { hidden: false };
    const download = { onclick: null };
    const backBtn = { onclick: null };
    elements.set("filePreviewBackdrop", backdrop);
    elements.set("filePreviewFrame", frame);
    elements.set("filePreviewTitle", title);
    elements.set("filePreviewText", text);
    elements.set("filePreviewUnsupported", unsupported);
    elements.set("filePreviewLoading", loading);
    elements.set("filePreviewDownloadBtn", download);
    elements.set("filePreviewBackBtn", backBtn);
    const module = createImageViewerModule({
      byId: (id) => elements.get(id) || null,
      state: {
        chatSmoothScrollUntil: 0,
        chatShouldStickToBottom: true,
      },
      escapeHtml: (value) => String(value || ""),
      wireBlurBackdropShield: () => {},
      scrollChatToBottom: () => {},
      updateScrollToBottomBtn: () => {},
      documentRef: {
        body: { appendChild() {} },
        createElement() {
          return {};
        },
        addEventListener() {},
      },
      navigatorRef: {},
      requestAnimationFrameRef: (callback) => callback(),
    });

    expect(module.openFilePreview("/codex/file?path=C%3A%5Cuploads%5Csheet.xlsx", "sheet.xlsx", { fileName: "sheet.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe(true);
    expect(frame.hidden).toBe(true);
    expect(frame.src).toBe("about:blank");
    expect(text.hidden).toBe(true);
    expect(unsupported.hidden).toBe(false);
    expect(unsupported.innerHTML).toContain("Preview unavailable");
    expect(loading.hidden).toBe(true);
  });

  it("shows an in-app unavailable state for pdf previews on iPhone", () => {
    const elements = new Map();
    const backdrop = {
      classList: {
        add() {},
        remove() {},
      },
      innerHTML: "",
    };
    const frame = { src: "" };
    const title = { textContent: "" };
    const text = { hidden: false, innerHTML: "" };
    const unsupported = { hidden: false, innerHTML: "" };
    const loading = { hidden: false };
    const download = { onclick: null };
    elements.set("filePreviewBackdrop", backdrop);
    elements.set("filePreviewFrame", frame);
    elements.set("filePreviewTitle", title);
    elements.set("filePreviewText", text);
    elements.set("filePreviewUnsupported", unsupported);
    elements.set("filePreviewLoading", loading);
    elements.set("filePreviewDownloadBtn", download);
    const module = createImageViewerModule({
      byId: (id) => elements.get(id) || null,
      state: {
        chatSmoothScrollUntil: 0,
        chatShouldStickToBottom: true,
      },
      escapeHtml: (value) => String(value || ""),
      wireBlurBackdropShield: () => {},
      scrollChatToBottom: () => {},
      updateScrollToBottomBtn: () => {},
      documentRef: {
        body: { appendChild() {} },
        createElement() {
          return {};
        },
        addEventListener() {},
      },
      navigatorRef: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      },
      requestAnimationFrameRef: (callback) => callback(),
    });

    expect(module.openFilePreview("/codex/file?path=C%3A%5Cuploads%5Creport.pdf", "report.pdf", { fileName: "report.pdf", mimeType: "application/pdf" })).toBe(true);
    expect(frame.hidden).toBe(true);
    expect(frame.src).toBe("about:blank");
    expect(unsupported.hidden).toBe(false);
    expect(unsupported.innerHTML).toContain("PDF");
    expect(loading.hidden).toBe(true);
  });

  it("renders csv file previews as a table", async () => {
    const elements = new Map();
    const backdrop = {
      classList: {
        add() {},
        remove() {},
      },
      innerHTML: "",
    };
    const frame = { src: "" };
    const title = { textContent: "" };
    const text = { hidden: false, innerHTML: "" };
    const unsupported = { hidden: false, innerHTML: "" };
    const loading = { hidden: false };
    const download = { onclick: null };
    elements.set("filePreviewBackdrop", backdrop);
    elements.set("filePreviewFrame", frame);
    elements.set("filePreviewTitle", title);
    elements.set("filePreviewText", text);
    elements.set("filePreviewUnsupported", unsupported);
    elements.set("filePreviewLoading", loading);
    elements.set("filePreviewDownloadBtn", download);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "name,age\nAlice,2\nBob,3",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const module = createImageViewerModule({
      byId: (id) => elements.get(id) || null,
      state: {
        chatSmoothScrollUntil: 0,
        chatShouldStickToBottom: true,
      },
      escapeHtml: (value) => String(value || ""),
      wireBlurBackdropShield: () => {},
      scrollChatToBottom: () => {},
      updateScrollToBottomBtn: () => {},
      documentRef: {
        body: { appendChild() {} },
        createElement() {
          return {};
        },
        addEventListener() {},
      },
      navigatorRef: {},
      requestAnimationFrameRef: (callback) => callback(),
    });

    expect(module.openFilePreview("/codex/file?path=C%3A%5Cuploads%5Cdata.csv", "data.csv", { fileName: "data.csv", mimeType: "text/csv" })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(text.hidden).toBe(false);
    expect(text.innerHTML).toContain("<table");
    expect(text.innerHTML).toContain("<th>name</th>");
    expect(text.innerHTML).toContain("<td>Alice</td>");
    expect(frame.hidden).toBe(true);
    expect(unsupported.hidden).toBe(true);
    vi.unstubAllGlobals();
  });
});
