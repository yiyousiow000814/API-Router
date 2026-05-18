function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

const FLOATING_COMPOSER_BREAKPOINT_PX = 1080;

export function shouldUseAppleMobileMotionTuning(windowRef = globalThis.window) {
  const nav = windowRef?.navigator || {};
  const ua = String(nav.userAgent || "");
  const platform = String(nav.platform || "");
  return /iPhone|iPad|iPod/i.test(ua) || (platform === "MacIntel" && Number(nav.maxTouchPoints || 0) > 1);
}

function isTouchTabletViewport(windowRef = globalThis.window) {
  const nav = windowRef?.navigator || {};
  const appleTouch = shouldUseAppleMobileMotionTuning(windowRef);
  const hasTouchPoints = Number(nav.maxTouchPoints || 0) > 0;
  if (windowRef?.matchMedia?.("(pointer: coarse)")?.matches) return appleTouch || hasTouchPoints;
  if (windowRef?.matchMedia?.("(hover: none)")?.matches) return appleTouch || hasTouchPoints;
  return appleTouch;
}

export function isComposerTextEntryActive(node) {
  if (!isEditableElement(node)) return false;
  return String(node?.id || "").trim() === "mobilePromptInput";
}

export function shouldUseFloatingComposerLayout(windowRef = globalThis.window) {
  if (!windowRef || typeof windowRef !== "object") return false;
  const viewportWidth = Math.max(
    0,
    Number(windowRef.innerWidth || 0),
    Number(windowRef.document?.documentElement?.clientWidth || 0)
  );
  if (viewportWidth > 0 && viewportWidth <= FLOATING_COMPOSER_BREAKPOINT_PX) return true;
  if (!isTouchTabletViewport(windowRef)) return false;
  return isComposerTextEntryActive(windowRef.document?.activeElement);
}

export function isEditableElement(node) {
  if (!node || typeof node !== "object") return false;
  if (node.isContentEditable === true) return true;
  const tagName = String(node.tagName || "").trim().toLowerCase();
  if (tagName === "textarea") return true;
  if (tagName !== "input") return false;
  const type = String(node.type || "").trim().toLowerCase();
  return type !== "button" &&
    type !== "checkbox" &&
    type !== "color" &&
    type !== "file" &&
    type !== "hidden" &&
    type !== "image" &&
    type !== "radio" &&
    type !== "range" &&
    type !== "reset" &&
    type !== "submit";
}

export function computeViewportMetrics({
  innerHeight,
  clientHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
  isTextEntryActive = false,
} = {}) {
  const layoutHeight = Math.max(
    toFiniteNumber(innerHeight),
    toFiniteNumber(clientHeight),
    0
  );
  const visualHeight = Math.max(toFiniteNumber(visualViewportHeight), 0);
  const viewportHeight = visualHeight > 0 ? visualHeight : layoutHeight;
  const viewportOffsetTop = Math.max(toFiniteNumber(visualViewportOffsetTop), 0);
  const occludedBottom = layoutHeight > 0
    ? Math.max(layoutHeight - viewportHeight - viewportOffsetTop, 0)
    : 0;
  return {
    layoutHeight,
    viewportHeight,
    viewportOffsetTop,
    keyboardOffset: isTextEntryActive ? occludedBottom : 0,
  };
}

export function installMobileViewportSync({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  updateMobileComposerState = () => {},
} = {}) {
  const root = documentRef?.documentElement;
  if (!root || !windowRef) return () => {};
  const visualViewport = windowRef.visualViewport;
  let scheduled = false;
  let disposed = false;
  let lastSignature = "";
  let stableLayoutHeight = 0;

  const applyMetrics = () => {
    scheduled = false;
    if (disposed) return;
    const floatingComposerLayout = shouldUseFloatingComposerLayout(windowRef);
    const viewportWidth = Math.max(
      0,
      Number(windowRef.innerWidth || 0),
      Number(documentRef.documentElement?.clientWidth || 0)
    );
    const metrics = computeViewportMetrics({
      innerHeight: windowRef.innerHeight,
      clientHeight: documentRef.documentElement?.clientHeight,
      visualViewportHeight: visualViewport?.height,
      visualViewportOffsetTop: visualViewport?.offsetTop,
      isTextEntryActive: isEditableElement(documentRef.activeElement),
    });
    if (metrics.keyboardOffset <= 0 || metrics.layoutHeight > stableLayoutHeight) {
      stableLayoutHeight = metrics.layoutHeight;
    }
    const appHeight = stableLayoutHeight || metrics.layoutHeight || metrics.viewportHeight;
    const signature = [
      floatingComposerLayout ? "floating" : "inline",
      Math.round(viewportWidth),
      Math.round(appHeight),
      Math.round(metrics.viewportHeight),
      Math.round(metrics.keyboardOffset),
      Math.round(metrics.viewportOffsetTop),
    ].join(":");
    if (signature === lastSignature) return;
    lastSignature = signature;
    root.style.setProperty("--app-height", `${Math.round(appHeight)}px`);
    root.style.setProperty("--visual-viewport-height", `${Math.round(metrics.viewportHeight)}px`);
    root.style.setProperty("--keyboard-offset", `${Math.round(metrics.keyboardOffset)}px`);
    documentRef.body?.classList?.toggle?.("mobile-keyboard-open", metrics.keyboardOffset > 0);
    documentRef.body?.classList?.toggle?.("floating-composer-layout", floatingComposerLayout);
    documentRef.body?.classList?.toggle?.("apple-mobile-motion", shouldUseAppleMobileMotionTuning(windowRef));
    if (floatingComposerLayout && typeof windowRef.scrollTo === "function") {
      windowRef.scrollTo(0, 0);
    }
    updateMobileComposerState();
  };

  const scheduleApply = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    const schedule = typeof windowRef.requestAnimationFrame === "function"
      ? windowRef.requestAnimationFrame.bind(windowRef)
      : (cb) => setTimeout(cb, 0);
    schedule(applyMetrics);
  };

  windowRef.addEventListener?.("resize", scheduleApply);
  visualViewport?.addEventListener?.("resize", scheduleApply);
  visualViewport?.addEventListener?.("scroll", scheduleApply);
  documentRef.addEventListener?.("focusin", scheduleApply, true);
  documentRef.addEventListener?.("focusout", scheduleApply, true);
  scheduleApply();

  return () => {
    disposed = true;
    windowRef.removeEventListener?.("resize", scheduleApply);
    visualViewport?.removeEventListener?.("resize", scheduleApply);
    visualViewport?.removeEventListener?.("scroll", scheduleApply);
    documentRef.removeEventListener?.("focusin", scheduleApply, true);
    documentRef.removeEventListener?.("focusout", scheduleApply, true);
  };
}
