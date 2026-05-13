import { describe, expect, it, vi } from "vitest";

import { createImageViewerModule } from "./imageViewer.js";

function createClassList() {
  const classes = new Set();
  return {
    add(...names) {
      for (const name of names) classes.add(name);
    },
    remove(...names) {
      for (const name of names) classes.delete(name);
    },
    contains(name) {
      return classes.has(name);
    },
    toggle(name, force) {
      if (force === true) {
        classes.add(name);
        return true;
      }
      if (force === false) {
        classes.delete(name);
        return false;
      }
      if (classes.has(name)) {
        classes.delete(name);
        return false;
      }
      classes.add(name);
      return true;
    },
  };
}

function createEventTarget(props = {}) {
  const listeners = new Map();
  return {
    ...props,
    addEventListener(type, callback, options = {}) {
      const entries = listeners.get(type) || [];
      entries.push({ callback, once: options?.once === true });
      listeners.set(type, entries);
    },
    dispatchEvent(event) {
      const entries = [...(listeners.get(event.type) || [])];
      for (const entry of entries) {
        entry.callback(event);
      }
      listeners.set(
        event.type,
        (listeners.get(event.type) || []).filter((entry) => !entry.once)
      );
    },
  };
}

function createToggleButton() {
  const attrs = new Set();
  return {
    onclick: null,
    toggleAttribute(name, force) {
      if (force) attrs.add(name);
      else attrs.delete(name);
    },
    hasAttribute(name) {
      return attrs.has(name);
    },
  };
}

function createFilmstrip() {
  return {
    innerHTML: "",
    scrollLeft: 0,
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, width: 0 };
    },
  };
}

async function flushRafCallbacks(callbacks, limit = 8) {
  for (let i = 0; i < limit; i += 1) {
    callbacks.shift()?.();
    await Promise.resolve();
  }
}

function setupImageViewerTest({
  images,
  index = 0,
  imageComplete = true,
  imageDecode = null,
  incomingImageComplete = true,
  incomingImageDecode = null,
  requestAnimationFrameRef = (callback) => callback(),
}) {
  const elements = new Map();
  const backdrop = { classList: createClassList() };
  const body = createEventTarget({
    classList: createClassList(),
    __wired: false,
    clientWidth: 320,
    setPointerCapture() {},
    getBoundingClientRect() {
      return { width: 320 };
    },
  });
  const title = { textContent: "" };
  const img = createEventTarget({
    src: "",
    alt: "",
    style: {},
    complete: imageComplete,
    naturalWidth: imageComplete ? 1200 : 0,
  });
  if (imageDecode) img.decode = imageDecode;
  const incomingImg = createEventTarget({
    src: "",
    alt: "",
    style: {},
    complete: incomingImageComplete,
    naturalWidth: incomingImageComplete ? 1200 : 0,
  });
  if (incomingImageDecode) incomingImg.decode = incomingImageDecode;
  const currentLayer = createEventTarget({ classList: createClassList(), style: {} });
  const incomingLayer = createEventTarget({ classList: createClassList(), style: {} });
  const prev = createToggleButton();
  const next = createToggleButton();
  const download = createToggleButton();
  const share = createToggleButton();
  const film = createFilmstrip();

  elements.set("imageViewerBackdrop", backdrop);
  elements.set("imageViewerBody", body);
  elements.set("imageViewerTitle", title);
  elements.set("imageViewerImg", img);
  elements.set("imageViewerImgIncoming", incomingImg);
  elements.set("imageViewerCurrentLayer", currentLayer);
  elements.set("imageViewerIncomingLayer", incomingLayer);
  elements.set("imageViewerPrevBtn", prev);
  elements.set("imageViewerNextBtn", next);
  elements.set("imageViewerDownloadBtn", download);
  elements.set("imageViewerShareBtn", share);
  elements.set("imageViewerFilmstrip", film);

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
    requestAnimationFrameRef,
  });

  module.openImageViewer(images[index].src, images[index].label, {
    images,
    index,
  });

  return { body, title, img, incomingImg, currentLayer, incomingLayer };
}

describe("imageViewer", () => {
  it("animates a direct left swipe before committing to the next image", async () => {
    const { body, title, img, incomingImg, currentLayer, incomingLayer } = setupImageViewerTest({
      images: [
        { src: "/one.png", label: "Image #1" },
        { src: "/two.png", label: "Image #2" },
      ],
      index: 0,
    });

    body.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 280, clientY: 120 });
    body.dispatchEvent({
      type: "pointermove",
      pointerId: 1,
      clientX: 80,
      clientY: 122,
      preventDefault() {},
    });
    body.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 80, clientY: 122 });
    await Promise.resolve();

    expect(img.src).toBe("/one.png");
    expect(incomingImg.src).toBe("/two.png");
    expect(body.classList.contains("is-slide-transitioning")).toBe(true);
    expect(currentLayer.style.transform).toBe("translate3d(-320px, 0px, 0)");
    expect(incomingLayer.style.transform).toBe("translate3d(0px, 0px, 0)");

    incomingLayer.dispatchEvent({ type: "transitionend" });

    expect(img.src).toBe("/two.png");
    expect(body.classList.contains("is-slide-transitioning")).toBe(false);
    expect(title.textContent).toBe("Image #2");
  });

  it("animates a direct right swipe from the middle image before committing to the previous image", async () => {
    const { body, title, img, incomingImg, currentLayer, incomingLayer } = setupImageViewerTest({
      images: [
        { src: "/left.png", label: "Image #1" },
        { src: "/middle.png", label: "Image #2" },
        { src: "/right.png", label: "Image #3" },
      ],
      index: 1,
    });

    body.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 80, clientY: 120 });
    let prevented = false;
    body.dispatchEvent({
      type: "pointermove",
      pointerId: 1,
      clientX: 280,
      clientY: 122,
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(incomingImg.src).toBe("/left.png");
    body.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 280, clientY: 122 });
    await Promise.resolve();

    expect(img.src).toBe("/middle.png");
    expect(incomingImg.src).toBe("/left.png");
    expect(body.classList.contains("is-slide-transitioning")).toBe(true);
    expect(currentLayer.style.transform).toBe("translate3d(320px, 0px, 0)");
    expect(incomingLayer.style.transform).toBe("translate3d(0px, 0px, 0)");

    incomingLayer.dispatchEvent({ type: "transitionend" });

    expect(img.src).toBe("/left.png");
    expect(body.classList.contains("is-slide-transitioning")).toBe(false);
    expect(title.textContent).toBe("Image #1");
  });

  it("switches the prepared slide when a small opposite drag is followed by a committed previous-image swipe", async () => {
    const { body, img, incomingImg, currentLayer, incomingLayer } = setupImageViewerTest({
      images: [
        { src: "/left.png", label: "Image #1" },
        { src: "/middle.png", label: "Image #2" },
        { src: "/right.png", label: "Image #3" },
      ],
      index: 1,
    });

    body.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 160, clientY: 120 });
    body.dispatchEvent({
      type: "pointermove",
      pointerId: 1,
      clientX: 140,
      clientY: 122,
      preventDefault() {},
    });
    expect(incomingImg.src).toBe("/right.png");

    body.dispatchEvent({
      type: "pointermove",
      pointerId: 1,
      clientX: 280,
      clientY: 122,
      preventDefault() {},
    });
    body.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 280, clientY: 122 });
    await Promise.resolve();

    expect(img.src).toBe("/middle.png");
    expect(incomingImg.src).toBe("/left.png");
    expect(currentLayer.style.transform).toBe("translate3d(320px, 0px, 0)");
    expect(incomingLayer.style.transform).toBe("translate3d(0px, 0px, 0)");

    incomingLayer.dispatchEvent({ type: "transitionend" });

    expect(img.src).toBe("/left.png");
  });

  it("keeps the incoming image visible until the promoted image finishes loading", async () => {
    const rafCallbacks = [];
    const { body, img, incomingImg, incomingLayer } = setupImageViewerTest({
      images: [
        { src: "/middle.png", label: "Image #2" },
        { src: "/right.png", label: "Image #3" },
      ],
      index: 0,
      imageComplete: false,
      requestAnimationFrameRef(callback) {
        rafCallbacks.push(callback);
      },
    });

    body.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 280, clientY: 120 });
    body.dispatchEvent({
      type: "pointermove",
      pointerId: 1,
      clientX: 80,
      clientY: 122,
      preventDefault() {},
    });
    expect(incomingImg.src).toBe("/right.png");

    body.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 80, clientY: 122 });
    rafCallbacks.shift()?.();
    await Promise.resolve();
    incomingLayer.dispatchEvent({ type: "transitionend" });
    await Promise.resolve();
    await Promise.resolve();

    expect(img.src).toBe("/right.png");
    expect(incomingImg.src).toBe("/right.png");
    expect(incomingLayer.style.opacity).toBe("1");

    img.complete = true;
    img.naturalWidth = 1200;
    img.dispatchEvent({ type: "load" });
    await flushRafCallbacks(rafCallbacks);

    expect(incomingImg.src).toBe("");
    expect(incomingLayer.style.opacity).toBe("");
  });

  it("waits for image decode before clearing the incoming image when the promoted image is cached", async () => {
    const rafCallbacks = [];
    let resolveDecode;
    const decodePromise = new Promise((resolve) => {
      resolveDecode = resolve;
    });
    const { body, img, incomingImg, incomingLayer } = setupImageViewerTest({
      images: [
        { src: "/middle.png", label: "Image #2" },
        { src: "/right.png", label: "Image #3" },
      ],
      index: 0,
      imageComplete: true,
      imageDecode: () => decodePromise,
      requestAnimationFrameRef(callback) {
        rafCallbacks.push(callback);
      },
    });

    body.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 280, clientY: 120 });
    body.dispatchEvent({
      type: "pointermove",
      pointerId: 1,
      clientX: 80,
      clientY: 122,
      preventDefault() {},
    });
    body.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 80, clientY: 122 });
    rafCallbacks.shift()?.();
    await Promise.resolve();
    incomingLayer.dispatchEvent({ type: "transitionend" });

    expect(img.src).toBe("/right.png");
    expect(incomingImg.src).toBe("/right.png");

    rafCallbacks.shift()?.();
    await Promise.resolve();
    expect(incomingImg.src).toBe("/right.png");

    resolveDecode();
    await Promise.resolve();
    await flushRafCallbacks(rafCallbacks, 1);
    expect(incomingImg.src).toBe("/right.png");

    await flushRafCallbacks(rafCallbacks);
    expect(incomingImg.src).toBe("");
  });

  it("keeps an opaque incoming-slide placeholder until the slide is promoted", async () => {
    const rafCallbacks = [];
    const { body, img, incomingLayer } = setupImageViewerTest({
      images: [
        { src: "/middle.png", label: "Image #2" },
        { src: "/right.png", label: "Image #3" },
      ],
      index: 0,
      requestAnimationFrameRef(callback) {
        rafCallbacks.push(callback);
      },
    });

    body.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 280, clientY: 120 });
    body.dispatchEvent({
      type: "pointermove",
      pointerId: 1,
      clientX: 80,
      clientY: 122,
      preventDefault() {},
    });

    expect(incomingLayer.classList.contains("is-image-loading")).toBe(true);

    body.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 80, clientY: 122 });
    await flushRafCallbacks(rafCallbacks, 1);
    expect(incomingLayer.classList.contains("is-image-loading")).toBe(true);

    incomingLayer.dispatchEvent({ type: "transitionend" });
    await flushRafCallbacks(rafCallbacks);

    expect(img.src).toBe("/right.png");
    expect(incomingLayer.classList.contains("is-image-loading")).toBe(false);
  });

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

  it("closes file previews when browser history goes back", () => {
    const elements = new Map();
    const classes = new Set();
    const backdrop = {
      classList: {
        add(name) {
          classes.add(name);
        },
        remove(name) {
          classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        },
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
    const pdfJs = { hidden: false };
    const pdfHost = { innerHTML: "" };
    const history = {
      state: { route: "chat" },
      pushState: vi.fn((nextState) => {
        history.state = nextState;
      }),
      replaceState: vi.fn((nextState) => {
        history.state = nextState;
      }),
      back: vi.fn(() => {
        history.state = { route: "chat" };
        popstateHandler?.({ state: history.state });
      }),
    };
    let popstateHandler = null;
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
        body: {
          appendChild() {
            elements.set("filePreviewBackdrop", backdrop);
            elements.set("filePreviewFrame", frame);
            elements.set("filePreviewTitle", title);
            elements.set("filePreviewText", text);
            elements.set("filePreviewUnsupported", unsupported);
            elements.set("filePreviewLoading", loading);
            elements.set("filePreviewDownloadBtn", download);
            elements.set("filePreviewBackBtn", backBtn);
            elements.set("filePreviewPdfJs", pdfJs);
            elements.set("filePreviewPdfCanvasHost", pdfHost);
          },
        },
        createElement() {
          return backdrop;
        },
        addEventListener() {},
      },
      windowRef: {
        location: { href: "http://localhost/codex-web/" },
        history,
        addEventListener(type, handler) {
          if (type === "popstate") popstateHandler = handler;
        },
      },
      navigatorRef: {},
      requestAnimationFrameRef: (callback) => callback(),
    });

    expect(module.openFilePreview("/codex/file?path=C%3A%5Cuploads%5Creport.pdf", "report.pdf", { fileName: "report.pdf", mimeType: "application/pdf" })).toBe(true);

    expect(history.pushState).toHaveBeenCalledTimes(1);
    expect(history.state.webCodexPreview).toMatchObject({ kind: "file" });
    expect(backdrop.classList.contains("show")).toBe(true);

    history.state = { route: "chat" };
    popstateHandler?.({ state: history.state });

    expect(backdrop.classList.contains("show")).toBe(false);
    expect(frame.src).toBe("about:blank");
    expect(history.back).not.toHaveBeenCalled();
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

  it("renders iPhone pdf previews with PDF.js instead of a frame", async () => {
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
    const pdfJs = { hidden: false };
    const pdfHost = {
      innerHTML: "",
      clientWidth: 360,
      appendChild(node) {
        this.node = node;
      },
    };
    const pdfPage = { textContent: "" };
    const pdfPrev = {
      disabled: false,
      onclick: null,
    };
    const pdfNext = {
      disabled: false,
      onclick: null,
    };
    const download = { onclick: null };
    elements.set("filePreviewBackdrop", backdrop);
    elements.set("filePreviewFrame", frame);
    elements.set("filePreviewTitle", title);
    elements.set("filePreviewText", text);
    elements.set("filePreviewUnsupported", unsupported);
    elements.set("filePreviewLoading", loading);
    elements.set("filePreviewPdfJs", pdfJs);
    elements.set("filePreviewPdfCanvasHost", pdfHost);
    elements.set("filePreviewPdfPage", pdfPage);
    elements.set("filePreviewPdfPrevBtn", pdfPrev);
    elements.set("filePreviewPdfNextBtn", pdfNext);
    elements.set("filePreviewDownloadBtn", download);
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const getPage = vi.fn(async () => ({
      getViewport: ({ scale }) => ({ width: 200 * scale, height: 300 * scale }),
      render,
    }));
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({ numPages: 2, getPage }),
    }));
    const loadPdfJs = vi.fn(async () => ({
      GlobalWorkerOptions: {},
      AnnotationMode: {
        ENABLE: 1,
        ENABLE_FORMS: 2,
      },
      getDocument,
    }));
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
        createElement(tag) {
          if (tag === "canvas") {
            return {
              style: {},
              getContext: () => ({ canvasContext: true }),
            };
          }
          return {
            className: "",
            style: {},
            children: [],
            appendChild(node) {
              this.children.push(node);
            },
          };
        },
        addEventListener() {},
      },
      navigatorRef: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      },
      loadPdfJs,
      requestAnimationFrameRef: (callback) => callback(),
    });

    expect(module.openFilePreview("/codex/file?path=C%3A%5Cuploads%5Creport.pdf", "report.pdf", { fileName: "report.pdf", mimeType: "application/pdf" })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadPdfJs).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledWith({
      url: "/codex/file?path=C%3A%5Cuploads%5Creport.pdf",
      disableFontFace: false,
      useSystemFonts: true,
      wasmUrl: "/codex-web/modules/pdfjs/wasm/",
    });
    expect(getPage).toHaveBeenCalledWith(1);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ annotationMode: 2 }));
    expect(frame.hidden).toBe(true);
    expect(frame.src).toBe("about:blank");
    expect(pdfJs.hidden).toBe(false);
    expect(pdfHost.node).toBeTruthy();
    expect(pdfPage.textContent).toBe("1 / 2");
    expect(unsupported.hidden).toBe(true);
    expect(loading.hidden).toBe(true);
  });

  it("fits wide iphone pdf previews to the available width", async () => {
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
    const pdfJs = { hidden: false };
    const pdfHost = {
      innerHTML: "",
      clientWidth: 360,
      appendChild(node) {
        this.node = node;
      },
    };
    const pdfPage = { textContent: "" };
    const pdfPrev = { disabled: false, onclick: null };
    const pdfNext = { disabled: false, onclick: null };
    const download = { onclick: null };
    elements.set("filePreviewBackdrop", backdrop);
    elements.set("filePreviewFrame", frame);
    elements.set("filePreviewTitle", title);
    elements.set("filePreviewText", text);
    elements.set("filePreviewUnsupported", unsupported);
    elements.set("filePreviewLoading", loading);
    elements.set("filePreviewPdfJs", pdfJs);
    elements.set("filePreviewPdfCanvasHost", pdfHost);
    elements.set("filePreviewPdfPage", pdfPage);
    elements.set("filePreviewPdfPrevBtn", pdfPrev);
    elements.set("filePreviewPdfNextBtn", pdfNext);
    elements.set("filePreviewDownloadBtn", download);
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const getPage = vi.fn(async () => ({
      getViewport: ({ scale }) => ({ width: 1000 * scale, height: 793 * scale }),
      render,
    }));
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({ numPages: 4, getPage }),
    }));
    const loadPdfJs = vi.fn(async () => ({
      GlobalWorkerOptions: {},
      AnnotationMode: {
        ENABLE: 1,
        ENABLE_FORMS: 2,
      },
      getDocument,
    }));
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
        createElement(tag) {
          if (tag === "canvas") {
            return {
              style: {},
              getContext: () => ({ canvasContext: true }),
            };
          }
          return {};
        },
        addEventListener() {},
      },
      navigatorRef: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      },
      loadPdfJs,
      requestAnimationFrameRef: (callback) => callback(),
    });

    expect(module.openFilePreview("/codex/file?path=C%3A%5Cuploads%5CA81975.pdf", "A81975.pdf", { fileName: "A81975.pdf", mimeType: "application/pdf" })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getPage).toHaveBeenCalledWith(1);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ annotationMode: 2 }));
    expect(pdfHost.node.style.width).toBe("336px");
    expect(pdfHost.node.style.height).toBe("267px");
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
