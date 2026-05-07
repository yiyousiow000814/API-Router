import { renderMessageRichHtml } from "./messageRender.js";

const PDFJS_MODULE_URL = "/codex-web/modules/pdfjs/pdf.min.mjs";
const PDFJS_WORKER_URL = "/codex-web/modules/pdfjs/pdf.worker.min.mjs";

async function defaultLoadPdfJs() {
  const pdfjs = await import(PDFJS_MODULE_URL);
  if (pdfjs?.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  }
  return pdfjs;
}

export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(
    String(dataUrl || "")
  );
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const isBase64 = !!match[2];
  const data = match[3] || "";
  try {
    const bytes = isBase64
      ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(data));
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

export function clampNumber(value, lo, hi) {
  return Math.max(Number(lo), Math.min(Number(hi), Number(value)));
}

function attachmentDisplayLabel(label) {
  const text = String(label || "").trim();
  const match = /^Image\s*#(\d+)\s*$/i.exec(text);
  if (match) return `#${match[1]}`;
  return text || "image";
}

function fileExtension(value) {
  const text = String(value || "").trim().toLowerCase();
  const dot = text.lastIndexOf(".");
  return dot >= 0 ? text.slice(dot) : "";
}

function escapeHtmlText(value) {
  return String(value || "").replace(/[&<>"]/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch]
  ));
}

function parseDelimitedRows(value, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(value || "");
  for (let idx = 0; idx < source.length; idx += 1) {
    const ch = source[idx];
    if (quoted) {
      if (ch === "\"" && source[idx + 1] === "\"") {
        cell += "\"";
        idx += 1;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === "\"") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch !== "\r") cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((cells) => cells.some((item) => String(item || "").trim()));
}

function renderDelimitedTable(value, delimiter = ",") {
  const rows = parseDelimitedRows(value, delimiter).slice(0, 250);
  if (!rows.length) return "<pre></pre>";
  const width = Math.max(...rows.map((row) => row.length));
  const normalizeRow = (row) => Array.from({ length: width }, (_, idx) => row[idx] || "");
  const [head, ...body] = rows.map(normalizeRow);
  const headerHtml = head.map((cell) => `<th>${escapeHtmlText(cell)}</th>`).join("");
  const bodyHtml = body
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtmlText(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="filePreviewTableWrap"><table class="filePreviewTable"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function buildBrokenAttachmentCardHtml(label, overlayHtml = "", escapeHtmlRef = (value) => String(value || "")) {
  return (
    `<div class="msgAttachmentChip mono">[image]</div>` +
    `<div class="msgAttachmentLabelBadge mono">${escapeHtmlRef(attachmentDisplayLabel(label))}</div>` +
    `${String(overlayHtml || "")}`
  );
}

export function createImageViewerModule(deps) {
  const {
    byId,
    state,
    escapeHtml,
    wireBlurBackdropShield,
    scrollChatToBottom,
    updateScrollToBottomBtn,
    documentRef = document,
    navigatorRef = navigator,
    requestAnimationFrameRef = requestAnimationFrame,
    loadPdfJs = defaultLoadPdfJs,
  } = deps;

  let imageViewerState = null;
  let filePreviewRequestId = 0;
  let pdfPreviewState = null;

  function isPdfPreviewSrc(src) {
    try {
      const url = new URL(String(src || ""), "http://localhost");
      const path = url.searchParams.get("path") || "";
      return /\.pdf$/i.test(path) || /\.pdf$/i.test(url.pathname);
    } catch {
      return /\.pdf(?:$|[?#])/i.test(String(src || ""));
    }
  }

  function isAppleMobilePreview() {
    const ua = String(navigatorRef?.userAgent || "").toLowerCase();
    return /iphone|ipad|ipod/.test(ua);
  }

  function isMarkdownPreviewFile(fileName, mimeType) {
    const ext = fileExtension(fileName);
    const mime = String(mimeType || "").trim().toLowerCase();
    return ext === ".md" || ext === ".markdown" || mime === "text/markdown";
  }

  function isTextPreviewFile(fileName, mimeType) {
    const ext = fileExtension(fileName);
    const mime = String(mimeType || "").trim().toLowerCase();
    return (
      isMarkdownPreviewFile(fileName, mimeType) ||
      ext === ".txt" ||
      ext === ".log" ||
      ext === ".json" ||
      ext === ".jsonl" ||
      ext === ".csv" ||
      ext === ".tsv" ||
      ext === ".xml" ||
      ext === ".yaml" ||
      ext === ".yml" ||
      ext === ".toml" ||
      ext === ".js" ||
      ext === ".jsx" ||
      ext === ".ts" ||
      ext === ".tsx" ||
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml"
    );
  }

  function isDelimitedPreviewFile(fileName, mimeType) {
    const ext = fileExtension(fileName);
    const mime = String(mimeType || "").trim().toLowerCase();
    return ext === ".csv" || ext === ".tsv" || mime === "text/csv" || mime === "text/tab-separated-values";
  }

  function setViewerTransform({ scale, tx, ty }) {
    const img = byId("imageViewerImg");
    if (!img) return;
    const s = clampNumber(Number(scale || 1), 1, 5);
    const x = Number.isFinite(Number(tx)) ? Number(tx) : 0;
    const y = Number.isFinite(Number(ty)) ? Number(ty) : 0;
    img.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${s})`;
    if (imageViewerState) {
      imageViewerState.scale = s;
      imageViewerState.tx = x;
      imageViewerState.ty = y;
    }
  }

  function setViewerIndex(nextIndex) {
    const backdrop = byId("imageViewerBackdrop");
    const img = byId("imageViewerImg");
    const title = byId("imageViewerTitle");
    const prev = byId("imageViewerPrevBtn");
    const next = byId("imageViewerNextBtn");
    const film = byId("imageViewerFilmstrip");
    if (!backdrop || !img || !imageViewerState) return;

    const images = Array.isArray(imageViewerState.images) ? imageViewerState.images : [];
    const idx = clampNumber(Number(nextIndex || 0), 0, Math.max(0, images.length - 1));
    const item = images[idx] || {};
    imageViewerState.index = idx;

    const safeLabel = String(item.label || "").trim() || "image";
    const safeSrc = String(item.src || "").trim();
    if (title) title.textContent = safeLabel;
    img.src = safeSrc;
    img.alt = safeLabel;
    setViewerTransform({ scale: 1, tx: 0, ty: 0 });

    if (prev) prev.toggleAttribute("disabled", idx <= 0);
    if (next) next.toggleAttribute("disabled", idx >= images.length - 1);

    if (film) {
      const nodes = Array.from(film.querySelectorAll("[data-qa='image-viewer-thumb']"));
      for (const n of nodes) {
        const i = Number(n.getAttribute("data-index") || "0");
        n.classList.toggle("active", i === idx);
      }
      const active = film.querySelector(
        `[data-qa='image-viewer-thumb'][data-index='${idx}']`
      );
      if (active && typeof active.scrollIntoView === "function") {
        active.scrollIntoView({ block: "nearest", inline: "center" });
      }
      try {
        const fr = film.getBoundingClientRect();
        const ar = active?.getBoundingClientRect?.();
        if (fr && ar && Number.isFinite(ar.left) && Number.isFinite(fr.left)) {
          const filmCenter = fr.left + fr.width / 2;
          const activeCenter = ar.left + ar.width / 2;
          film.scrollLeft += activeCenter - filmCenter;
        }
      } catch {}
    }
  }

  function renderViewerFilmstrip() {
    const film = byId("imageViewerFilmstrip");
    if (!film || !imageViewerState) return;
    const images = Array.isArray(imageViewerState.images) ? imageViewerState.images : [];
    film.innerHTML = images
      .map((it, idx) => {
        const src = escapeHtml(String(it?.src || "").trim());
        const label = escapeHtml(String(it?.label || "image").trim());
        return (
          `<button class="imageViewerThumb" type="button" data-qa="image-viewer-thumb" data-index="${idx}" aria-label="${label}">` +
          `<img alt="${label}" src="${src}" />` +
          `</button>`
        );
      })
      .join("");

    for (const btn of Array.from(film.querySelectorAll("[data-qa='image-viewer-thumb']"))) {
      btn.onclick = () => setViewerIndex(Number(btn.getAttribute("data-index") || "0"));
    }
  }

  function wireViewerGestures() {
    const body = byId("imageViewerBody");
    if (!body || body.__wired) return;
    body.__wired = true;

    const active = new Map();
    let startDist = 0;
    let startScale = 1;
    let startTx = 0;
    let startTy = 0;
    let lastTapMs = 0;
    let swipeStart = null;

    const getDist = () => {
      const pts = Array.from(active.values());
      if (pts.length < 2) return 0;
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      return Math.hypot(dx, dy);
    };

    body.addEventListener(
      "pointerdown",
      (event) => {
        if (!imageViewerState) return;
        body.setPointerCapture?.(event.pointerId);
        active.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (active.size === 1) {
          swipeStart = { x: event.clientX, y: event.clientY, t: Date.now() };
          startTx = imageViewerState.tx || 0;
          startTy = imageViewerState.ty || 0;
        }
        if (active.size === 2) {
          startDist = getDist();
          startScale = imageViewerState.scale || 1;
          startTx = imageViewerState.tx || 0;
          startTy = imageViewerState.ty || 0;
          swipeStart = null;
        }
      },
      { passive: false }
    );

    body.addEventListener(
      "pointermove",
      (event) => {
        if (!imageViewerState) return;
        if (!active.has(event.pointerId)) return;
        active.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (active.size === 2) {
          const d = getDist();
          if (startDist > 0) {
            const nextScale = clampNumber(startScale * (d / startDist), 1, 5);
            setViewerTransform({ scale: nextScale, tx: startTx, ty: startTy });
          }
          event.preventDefault();
          return;
        }

        if (active.size === 1 && (imageViewerState.scale || 1) > 1) {
          const p = active.get(event.pointerId);
          if (!p || !swipeStart) return;
          const dx = p.x - swipeStart.x;
          const dy = p.y - swipeStart.y;
          setViewerTransform({
            scale: imageViewerState.scale,
            tx: startTx + dx,
            ty: startTy + dy,
          });
          event.preventDefault();
        }
      },
      { passive: false }
    );

    body.addEventListener(
      "pointerup",
      (event) => {
        if (!imageViewerState) return;
        active.delete(event.pointerId);
        if (active.size !== 0) return;
        const scale = imageViewerState.scale || 1;
        const now = Date.now();
        if (swipeStart && scale <= 1.02) {
          const dx = event.clientX - swipeStart.x;
          const dy = event.clientY - swipeStart.y;
          if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            if (dx < 0) setViewerIndex((imageViewerState.index || 0) + 1);
            else setViewerIndex((imageViewerState.index || 0) - 1);
          }
        }
        if (now - lastTapMs < 320) {
          const next = scale > 1.2 ? 1 : 2;
          setViewerTransform({ scale: next, tx: 0, ty: 0 });
          lastTapMs = 0;
        } else {
          lastTapMs = now;
        }
        swipeStart = null;
      },
      { passive: true }
    );

    body.addEventListener(
      "wheel",
      (event) => {
        if (!imageViewerState) return;
        const isZoomGesture =
          event.ctrlKey || event.metaKey || (imageViewerState.scale || 1) > 1.01;
        if (!isZoomGesture) return;
        const delta = -Math.sign(event.deltaY || 0) * 0.15;
        const nextScale = clampNumber((imageViewerState.scale || 1) + delta, 1, 5);
        setViewerTransform({
          scale: nextScale,
          tx: imageViewerState.tx || 0,
          ty: imageViewerState.ty || 0,
        });
        if (event.cancelable) event.preventDefault();
      },
      { passive: false }
    );
  }

  function ensureImageViewer() {
    if (byId("imageViewerBackdrop")) return;
    const backdrop = documentRef.createElement("div");
    backdrop.id = "imageViewerBackdrop";
    backdrop.className = "imageViewerBackdrop";
    backdrop.innerHTML =
      `<div class="imageViewer" role="dialog" aria-modal="true" aria-label="Image viewer">` +
      `<div class="imageViewerTop">` +
      `<button id="imageViewerBackBtn" class="imageViewerIconBtn" type="button" aria-label="Back">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>` +
      `</button>` +
      `<div id="imageViewerTitle" class="imageViewerTitle mono"></div>` +
      `<div class="grow"></div>` +
      `<button id="imageViewerShareBtn" class="imageViewerIconBtn" type="button" aria-label="Share">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16v-9"></path><path d="M8.5 10.5L12 7l3.5 3.5"></path><path d="M5 17.5v1a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18.5v-1"></path></svg>` +
      `</button>` +
      `<button id="imageViewerDownloadBtn" class="imageViewerIconBtn" type="button" aria-label="Download">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10"></path><path d="M8.5 10.5L12 14l3.5-3.5"></path><path d="M5 20h14"></path></svg>` +
      `</button>` +
      `</div>` +
      `<div id="imageViewerBody" class="imageViewerBody">` +
      `<img id="imageViewerImg" class="imageViewerImg" alt="" />` +
      `</div>` +
      `<button id="imageViewerPrevBtn" class="imageViewerIconBtn imageViewerNav prev" type="button" aria-label="Previous" data-qa="image-viewer-prev">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>` +
      `</button>` +
      `<button id="imageViewerNextBtn" class="imageViewerIconBtn imageViewerNav next" type="button" aria-label="Next" data-qa="image-viewer-next">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>` +
      `</button>` +
      `<div id="imageViewerFilmstrip" class="imageViewerFilmstrip" aria-label="Image list"></div>` +
      `</div>`;
    documentRef.body.appendChild(backdrop);

    const close = () => backdrop.classList.remove("show");
    wireBlurBackdropShield(backdrop, {
      onClose: close,
      modalSelector: ".imageViewer",
      suppressMs: 420,
    });
    const backBtn = byId("imageViewerBackBtn");
    if (backBtn) backBtn.onclick = close;
    if (!documentRef.__webCodexImageViewerEscWired) {
      documentRef.__webCodexImageViewerEscWired = true;
      documentRef.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && backdrop.classList.contains("show")) close();
      });
    }
  }

  function ensureFilePreview() {
    if (byId("filePreviewBackdrop")) return;
    const backdrop = documentRef.createElement("div");
    backdrop.id = "filePreviewBackdrop";
    backdrop.className = "filePreviewBackdrop";
    backdrop.innerHTML =
      `<div class="filePreview" role="dialog" aria-modal="true" aria-label="File preview">` +
      `<div class="filePreviewTop">` +
      `<button id="filePreviewBackBtn" class="imageViewerIconBtn" type="button" aria-label="Back">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>` +
      `</button>` +
      `<div id="filePreviewTitle" class="filePreviewTitle mono"></div>` +
      `<div class="grow"></div>` +
      `<button id="filePreviewDownloadBtn" class="imageViewerIconBtn" type="button" aria-label="Download">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10"></path><path d="M8.5 10.5L12 14l3.5-3.5"></path><path d="M5 20h14"></path></svg>` +
      `</button>` +
      `</div>` +
      `<div class="filePreviewStage">` +
      `<iframe id="filePreviewFrame" class="filePreviewFrame" title="File preview"></iframe>` +
      `<div id="filePreviewPdfJs" class="filePreviewPdfJs">` +
      `<div class="filePreviewPdfControls">` +
      `<button id="filePreviewPdfPrevBtn" class="filePreviewPdfBtn" type="button">Previous</button>` +
      `<span id="filePreviewPdfPage" class="filePreviewPdfPage mono"></span>` +
      `<button id="filePreviewPdfNextBtn" class="filePreviewPdfBtn" type="button">Next</button>` +
      `</div>` +
      `<div id="filePreviewPdfCanvasHost" class="filePreviewPdfCanvasHost"></div>` +
      `</div>` +
      `<div id="filePreviewText" class="filePreviewText"></div>` +
      `<div id="filePreviewUnsupported" class="filePreviewUnsupported"></div>` +
      `<div id="filePreviewLoading" class="filePreviewLoading">Loading preview...</div>` +
      `</div>` +
      `</div>`;
    documentRef.body.appendChild(backdrop);

    const close = () => {
      filePreviewRequestId += 1;
      const frame = byId("filePreviewFrame");
      const pdfJs = byId("filePreviewPdfJs");
      const pdfHost = byId("filePreviewPdfCanvasHost");
      const text = byId("filePreviewText");
      const unsupported = byId("filePreviewUnsupported");
      const loading = byId("filePreviewLoading");
      if (frame) frame.src = "about:blank";
      if (pdfPreviewState?.renderTask?.cancel) {
        try {
          pdfPreviewState.renderTask.cancel();
        } catch {}
      }
      pdfPreviewState = null;
      if (pdfJs) pdfJs.hidden = true;
      if (pdfHost) pdfHost.innerHTML = "";
      if (text) text.innerHTML = "";
      if (unsupported) unsupported.innerHTML = "";
      if (loading) loading.hidden = true;
      backdrop.classList.remove("show");
    };
    wireBlurBackdropShield(backdrop, {
      onClose: close,
      modalSelector: ".filePreview",
      suppressMs: 420,
    });
    const backBtn = byId("filePreviewBackBtn");
    if (backBtn) backBtn.onclick = close;
    if (!documentRef.__webCodexFilePreviewEscWired) {
      documentRef.__webCodexFilePreviewEscWired = true;
      documentRef.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && backdrop.classList.contains("show")) close();
      });
    }
  }

  function showUnsupportedFilePreview(titleText = "Preview unavailable", bodyText = "This file can be downloaded, but it cannot be rendered in the browser preview.") {
    const unsupported = byId("filePreviewUnsupported");
    const loading = byId("filePreviewLoading");
    if (!unsupported) return;
    unsupported.innerHTML =
      `<div class="filePreviewUnsupportedTitle">${escapeHtmlText(titleText)}</div>` +
      `<div class="filePreviewUnsupportedBody">${escapeHtmlText(bodyText)}</div>`;
    unsupported.hidden = false;
    if (loading) loading.hidden = true;
  }

  async function renderPdfJsPage(requestId, pageNum) {
    if (!pdfPreviewState || requestId !== filePreviewRequestId) return;
    const host = byId("filePreviewPdfCanvasHost");
    const pageLabel = byId("filePreviewPdfPage");
    const prev = byId("filePreviewPdfPrevBtn");
    const next = byId("filePreviewPdfNextBtn");
    if (!host) return;

    if (pdfPreviewState.renderTask?.cancel) {
      try {
        pdfPreviewState.renderTask.cancel();
      } catch {}
    }
    const pdf = pdfPreviewState.pdf;
    const safePageNum = clampNumber(pageNum, 1, pdf.numPages || 1);
    pdfPreviewState.pageNum = safePageNum;
    if (pageLabel) pageLabel.textContent = `${safePageNum} / ${pdf.numPages || 1}`;
    if (prev) prev.disabled = safePageNum <= 1;
    if (next) next.disabled = safePageNum >= (pdf.numPages || 1);

    const page = await pdf.getPage(safePageNum);
    if (requestId !== filePreviewRequestId) return;
    const baseViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(240, Number(host.clientWidth || 360) - 24);
    const scale = Math.min(2, Math.max(0.6, availableWidth / Math.max(1, baseViewport.width)));
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio || 1)));
    const canvas = documentRef.createElement("canvas");
    const context = canvas.getContext?.("2d");
    canvas.width = Math.ceil(viewport.width * dpr);
    canvas.height = Math.ceil(viewport.height * dpr);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    host.innerHTML = "";
    host.appendChild(canvas);
    const renderViewport = dpr === 1 ? viewport : page.getViewport({ scale: scale * dpr });
    const renderTask = page.render({ canvasContext: context, viewport: renderViewport });
    pdfPreviewState.renderTask = renderTask;
    await renderTask.promise;
  }

  async function renderPdfJsPreview(src, requestId) {
    const pdfJs = byId("filePreviewPdfJs");
    const loading = byId("filePreviewLoading");
    const prev = byId("filePreviewPdfPrevBtn");
    const next = byId("filePreviewPdfNextBtn");
    if (!pdfJs) return;
    try {
      const pdfjs = await loadPdfJs();
      if (requestId !== filePreviewRequestId) return;
      const loadingTask = pdfjs.getDocument({ url: src });
      const pdf = await loadingTask.promise;
      if (requestId !== filePreviewRequestId) return;
      pdfPreviewState = { pdf, pageNum: 1, renderTask: null };
      if (prev) prev.onclick = () => renderPdfJsPage(requestId, (pdfPreviewState?.pageNum || 1) - 1);
      if (next) next.onclick = () => renderPdfJsPage(requestId, (pdfPreviewState?.pageNum || 1) + 1);
      pdfJs.hidden = false;
      if (loading) loading.hidden = true;
      await renderPdfJsPage(requestId, 1);
    } catch {
      if (requestId !== filePreviewRequestId) return;
      showUnsupportedFilePreview(
        "PDF preview unavailable",
        "This PDF can be downloaded, but it could not be rendered in the in-app preview."
      );
    }
  }

  function openFilePreview(src, label, options = {}) {
    ensureFilePreview();
    const requestId = filePreviewRequestId + 1;
    filePreviewRequestId = requestId;
    const backdrop = byId("filePreviewBackdrop");
    const frame = byId("filePreviewFrame");
    const title = byId("filePreviewTitle");
    const download = byId("filePreviewDownloadBtn");
    const pdfJs = byId("filePreviewPdfJs");
    const pdfHost = byId("filePreviewPdfCanvasHost");
    const text = byId("filePreviewText");
    const unsupported = byId("filePreviewUnsupported");
    const loading = byId("filePreviewLoading");
    if (!backdrop || !frame || !text || !unsupported || !loading) return false;

    const safeSrc = String(src || "").trim();
    const safeLabel = String(label || "").trim() || "attachment";
    const safeFileName = String(options.fileName || safeLabel || "").trim();
    const safeMimeType = String(options.mimeType || "").trim();
    if (!safeSrc) return false;
    if (title) title.textContent = safeLabel;
    frame.src = "about:blank";
    frame.hidden = true;
    if (pdfPreviewState?.renderTask?.cancel) {
      try {
        pdfPreviewState.renderTask.cancel();
      } catch {}
    }
    pdfPreviewState = null;
    if (pdfJs) pdfJs.hidden = true;
    if (pdfHost) pdfHost.innerHTML = "";
    text.hidden = true;
    unsupported.hidden = true;
    loading.hidden = false;
    if (isPdfPreviewSrc(safeSrc) || /\.pdf$/i.test(safeFileName) || safeMimeType === "application/pdf") {
      if (isAppleMobilePreview()) {
        void renderPdfJsPreview(safeSrc, requestId);
      } else {
        frame.hidden = false;
        loading.hidden = true;
        frame.src = `${safeSrc}#view=FitH&zoom=page-width`;
      }
    } else if (isTextPreviewFile(safeFileName, safeMimeType)) {
      const renderText = async () => {
        try {
          const response = await fetch(safeSrc, { credentials: "same-origin" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const textValue = await response.text();
          if (isDelimitedPreviewFile(safeFileName, safeMimeType)) {
            text.innerHTML = renderDelimitedTable(
              textValue,
              fileExtension(safeFileName) === ".tsv" || safeMimeType === "text/tab-separated-values" ? "\t" : ","
            );
          } else if (isMarkdownPreviewFile(safeFileName, safeMimeType)) {
            text.innerHTML = renderMessageRichHtml(textValue);
          } else {
            text.innerHTML = `<pre>${escapeHtmlText(textValue)}</pre>`;
          }
          text.hidden = false;
        } catch {
          showUnsupportedFilePreview();
        } finally {
          loading.hidden = true;
        }
      };
      void renderText();
    } else {
      showUnsupportedFilePreview();
    }
    if (download) {
      download.onclick = () => {
        const a = documentRef.createElement("a");
        a.href = safeSrc;
        a.download = safeLabel.replace(/[^\w.-]+/g, "_") || "attachment";
        documentRef.body.appendChild(a);
        a.click();
        a.remove();
      };
    }
    backdrop.classList.add("show");
    return true;
  }

  function openImageViewer(src, label, options = {}) {
    ensureImageViewer();
    const backdrop = byId("imageViewerBackdrop");
    const img = byId("imageViewerImg");
    const prev = byId("imageViewerPrevBtn");
    const next = byId("imageViewerNextBtn");
    const download = byId("imageViewerDownloadBtn");
    const share = byId("imageViewerShareBtn");
    if (!backdrop || !img) return;

    const safeSrc = String(src || "").trim();
    const safeLabel = String(label || "").trim() || "image";
    const images =
      Array.isArray(options.images) && options.images.length
        ? options.images
            .map((it) => ({
              src: String(it?.src || "").trim(),
              label: String(it?.label || "").trim(),
            }))
            .filter((it) => it.src)
        : [{ src: safeSrc, label: safeLabel }];
    const startIndex = clampNumber(
      Number(options.index || 0),
      0,
      Math.max(0, images.length - 1)
    );

    imageViewerState = { images, index: startIndex, scale: 1, tx: 0, ty: 0 };
    renderViewerFilmstrip();
    setViewerIndex(startIndex);
    wireViewerGestures();

    if (prev) prev.onclick = () => setViewerIndex((imageViewerState?.index || 0) - 1);
    if (next) next.onclick = () => setViewerIndex((imageViewerState?.index || 0) + 1);
    if (!documentRef.__webCodexImageViewerArrowWired) {
      documentRef.__webCodexImageViewerArrowWired = true;
      documentRef.addEventListener(
        "keydown",
        (event) => {
          if (!byId("imageViewerBackdrop")?.classList.contains("show")) return;
          if (!imageViewerState) return;
          if (event.key === "ArrowLeft") setViewerIndex((imageViewerState.index || 0) - 1);
          if (event.key === "ArrowRight") setViewerIndex((imageViewerState.index || 0) + 1);
        },
        { passive: true }
      );
    }

    if (download) {
      download.onclick = () => {
        const current = imageViewerState?.images?.[imageViewerState?.index || 0];
        const curSrc = String(current?.src || safeSrc || "").trim();
        const curLabel = String(current?.label || safeLabel || "image").trim();
        if (!curSrc) return;
        const a = documentRef.createElement("a");
        a.href = curSrc;
        a.download = curLabel.replace(/[^\w.-]+/g, "_") || "image";
        documentRef.body.appendChild(a);
        a.click();
        a.remove();
      };
    }

    if (share) {
      share.onclick = async () => {
        const current = imageViewerState?.images?.[imageViewerState?.index || 0];
        const curSrc = String(current?.src || safeSrc || "").trim();
        const curLabel = String(current?.label || safeLabel || "image").trim();
        if (!curSrc) return;
        try {
          if (navigatorRef.share) {
            if (/^data:/i.test(curSrc)) {
              const blob = dataUrlToBlob(curSrc);
              if (blob) {
                const file = new File(
                  [blob],
                  `${curLabel.replace(/[^\w.-]+/g, "_") || "image"}.png`,
                  { type: blob.type || "image/png" }
                );
                const payload = { files: [file], title: curLabel };
                if (!navigatorRef.canShare || navigatorRef.canShare(payload)) {
                  await navigatorRef.share(payload);
                  return;
                }
              }
            }
            await navigatorRef.share({ title: curLabel, url: curSrc });
            return;
          }
        } catch {}
        download?.click?.();
      };
    }

    backdrop.classList.add("show");
  }

  function wireMessageAttachments(container) {
    const cards = container.querySelectorAll(".msgAttachmentCard");
    for (const card of cards) {
      if (card.__wired) continue;
      card.__wired = true;
      const open = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const src = card.getAttribute("data-image-src") || "";
        const label = card.getAttribute("data-image-label") || "";
        if (!src) return;
        const gallery = Array.from(documentRef.querySelectorAll("#chatBox .msgAttachmentCard"))
          .map((n) => ({
            src: String(n.getAttribute("data-image-src") || "").trim(),
            label: String(n.getAttribute("data-image-label") || "").trim(),
          }))
          .filter((it) => it.src);
        const idx = Math.max(
          0,
          gallery.findIndex((it) => it.src === src && (!label || it.label === label))
        );
        openImageViewer(src, label, { images: gallery, index: idx });
      };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") open(event);
      });
    }

    const markBrokenAttachment = (img) => {
      const card = img?.closest(".msgAttachmentCard");
      if (!card) return;
      if (card.__brokenAttachment === true) return;
      card.__brokenAttachment = true;
      const overlay = card.querySelector?.(".msgAttachmentMoreOverlay");
      const label = card.getAttribute?.("data-image-label") || "image";
      try {
        card.setAttribute?.("data-image-src", "");
      } catch {}
      try {
        card.classList?.add?.("msgAttachmentCard-missing");
      } catch {}
      card.innerHTML = buildBrokenAttachmentCardHtml(label, overlay?.outerHTML || "", escapeHtml);
    };

    const imgs = container.querySelectorAll("img.msgAttachmentImage");
    for (const img of imgs) {
      if (img.__wiredLoad) continue;
      img.__wiredLoad = true;
      const onSettled = (options = {}) => {
        const now = Date.now();
        if (now <= Number(state.chatSmoothScrollUntil || 0)) {
          updateScrollToBottomBtn();
          return;
        }
        if (options.forceScroll === true && state.chatShouldStickToBottom) {
          scrollChatToBottom({ force: true });
        }
        else updateScrollToBottomBtn();
      };
      img.addEventListener("load", () => onSettled({ forceScroll: true }), { once: true });
      img.addEventListener(
        "error",
        () => {
          markBrokenAttachment(img);
          onSettled({ forceScroll: false });
        },
        { once: true }
      );
      if (img.complete && !(img.naturalWidth > 0)) {
        markBrokenAttachment(img);
        onSettled({ forceScroll: false });
      }
    }
    updateScrollToBottomBtn();
  }

  return {
    ensureImageViewer,
    openImageViewer,
    openFilePreview,
    wireMessageAttachments,
  };
}
