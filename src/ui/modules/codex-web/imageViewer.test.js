import { describe, expect, it, vi } from "vitest";

import { createImageViewerModule } from "./imageViewer.js";

function createClassList() {
  const tokens = new Set();
  return {
    add(...names) {
      for (const name of names) if (name) tokens.add(String(name));
    },
    remove(...names) {
      for (const name of names) tokens.delete(String(name));
    },
    contains(name) {
      return tokens.has(String(name));
    },
    toggle(name, force) {
      if (force === true) {
        tokens.add(String(name));
        return true;
      }
      if (force === false) {
        tokens.delete(String(name));
        return false;
      }
      if (tokens.has(String(name))) {
        tokens.delete(String(name));
        return false;
      }
      tokens.add(String(name));
      return true;
    },
  };
}

function createEventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, handler) {
      const key = String(type || "");
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(handler);
    },
    dispatchEvent(event) {
      const payload = event && typeof event === "object" ? event : { type: String(event || "") };
      const handlers = listeners.get(String(payload.type || "")) || [];
      for (const handler of handlers) {
        handler({
          ...payload,
          currentTarget: this,
          target: this,
          preventDefault() {},
          stopPropagation() {},
        });
      }
      return handlers.length > 0;
    },
  };
}

function createToggleButton(index = null) {
  const attrs = new Map();
  const button = createEventTarget({
    classList: createClassList(),
    onclick: null,
    scrollIntoView() {},
    getBoundingClientRect() {
      const left = Number(index ?? 0) * 44;
      return { left, width: 36 };
    },
    toggleAttribute(name, force) {
      if (force === false) attrs.delete(String(name));
      else attrs.set(String(name), "");
    },
    setAttribute(name, value) {
      attrs.set(String(name), String(value));
    },
    getAttribute(name) {
      return attrs.has(String(name)) ? attrs.get(String(name)) : null;
    },
  });
  return button;
}

function createFilmstrip() {
  const film = {
    classList: createClassList(),
    scrollLeft: 0,
    _buttons: [],
    _innerHTML: "",
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(value) {
      this._innerHTML = String(value || "");
      this._buttons = Array.from(
        this._innerHTML.matchAll(
          /data-index="(\d+)"[\s\S]*?aria-label="([^"]*)"[\s\S]*?<img alt="[^"]*" src="([^"]*)"/g
        )
      ).map((match) => {
        const button = createToggleButton(Number(match[1]));
        button.setAttribute("data-qa", "image-viewer-thumb");
        button.setAttribute("data-index", match[1]);
        button.setAttribute("aria-label", match[2]);
        button.src = match[3];
        return button;
      });
    },
    querySelectorAll(selector) {
      if (selector === "[data-qa='image-viewer-thumb']") return this._buttons;
      return [];
    },
    querySelector(selector) {
      const match = /\[data-index='(\d+)'\]/.exec(String(selector || ""));
      if (!match) return null;
      return this._buttons.find((button) => button.getAttribute("data-index") === match[1]) || null;
    },
    getBoundingClientRect() {
      return { left: 0, width: 180 };
    },
  };
  return film;
}

describe("imageViewer", () => {
  it("slides to the next image before replacing the current source", async () => {
    const elements = new Map();
    const backdrop = { classList: createClassList() };
    const body = createEventTarget({
      classList: createClassList(),
      __wired: false,
      setPointerCapture() {},
    });
    const title = { textContent: "" };
    const img = { src: "", alt: "", style: {} };
    const incomingImg = { src: "", alt: "", style: {} };
    const currentLayer = createEventTarget({ classList: createClassList() });
    const incomingLayer = createEventTarget({ classList: createClassList() });
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
      requestAnimationFrameRef: (callback) => callback(),
    });

    module.openImageViewer("/one.png", "Image #1", {
      images: [
        { src: "/one.png", label: "Image #1" },
        { src: "/two.png", label: "Image #2" },
      ],
      index: 0,
    });

    expect(img.src).toBe("/one.png");

    next.onclick();
    await Promise.resolve();
    await Promise.resolve();

    expect(body.classList.contains("is-slide-transitioning")).toBe(true);
    expect(body.classList.contains("is-slide-running")).toBe(true);
    expect(incomingImg.src).toBe("/two.png");
    expect(img.src).toBe("/one.png");

    incomingLayer.dispatchEvent({ type: "transitionend" });

    expect(body.classList.contains("is-slide-transitioning")).toBe(false);
    expect(img.src).toBe("/two.png");
    expect(title.textContent).toBe("Image #2");
  });

  it("follows the finger while preparing the next image slide", () => {
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
    const img = { src: "", alt: "", style: {} };
    const incomingImg = { src: "", alt: "", style: {} };
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
      requestAnimationFrameRef: (callback) => callback(),
    });

    module.openImageViewer("/one.png", "Image #1", {
      images: [
        { src: "/one.png", label: "Image #1" },
        { src: "/two.png", label: "Image #2" },
      ],
      index: 0,
    });

    body.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 240, clientY: 100 });
    body.dispatchEvent({ type: "pointermove", pointerId: 1, clientX: 160, clientY: 104 });

    expect(body.classList.contains("is-slide-prepared")).toBe(true);
    expect(body.classList.contains("is-slide-forward")).toBe(true);
    expect(incomingImg.src).toBe("/two.png");
    expect(currentLayer.style.transform).toBe("translate3d(-80px, 0px, 0)");
    expect(incomingLayer.style.transform).toBe("translate3d(240px, 0px, 0)");
    expect(img.src).toBe("/one.png");
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
