export const CONTEXT_LEFT_BASELINE_TOKENS = 12000;
const CONTEXT_LEFT_DIGIT_ANIMATION_MS = 640;
const CONTEXT_LEFT_DIGIT_STAGGER_MS = 112;
const CONTEXT_LEFT_DIGIT_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const CONTEXT_LEFT_DIGIT_TRAVEL_PERCENT = 104;
const CONTEXT_LEFT_ANNOTATION_ANIMATION_MS = 260;
const CONTEXT_LEFT_ANNOTATION_SEPARATOR = " · ";

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function splitContextAnnotations(value) {
  return String(value || "")
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
}

function compactTokenUsageCount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const units = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const scaled = n / size;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
      const rounded = Number(scaled.toFixed(digits));
      return `${rounded % 1 === 0 ? String(Math.trunc(rounded)) : rounded.toFixed(1)}${suffix}`;
    }
  }
  return String(Math.round(n));
}

export function normalizeThreadTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const readStats = (value) => {
    if (!value || typeof value !== "object") return null;
    const totalTokens = readNumber(value.totalTokens ?? value.total_tokens);
    const inputTokens = readNumber(value.inputTokens ?? value.input_tokens);
    const cachedInputTokens = readNumber(value.cachedInputTokens ?? value.cached_input_tokens);
    const outputTokens = readNumber(value.outputTokens ?? value.output_tokens);
    const reasoningOutputTokens = readNumber(value.reasoningOutputTokens ?? value.reasoning_output_tokens);
    if (
      totalTokens === null &&
      inputTokens === null &&
      cachedInputTokens === null &&
      outputTokens === null &&
      reasoningOutputTokens === null
    ) {
      return null;
    }
    return {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    };
  };
  const total = readStats(usage.total ?? usage.total_token_usage);
  const last = readStats(usage.last ?? usage.last_token_usage);
  const modelContextWindow = readNumber(usage.modelContextWindow ?? usage.model_context_window);
  if (!total && !last && modelContextWindow === null) return null;
  return { total, last, modelContextWindow };
}

export function formatContextLeftDisplay(tokenUsage) {
  const usage = normalizeThreadTokenUsage(tokenUsage);
  const totalTokens = readNumber(usage?.total?.totalTokens);
  const lastTokens = readNumber(usage?.last?.totalTokens);
  const modelContextWindow = readNumber(usage?.modelContextWindow);
  if (modelContextWindow !== null && modelContextWindow > CONTEXT_LEFT_BASELINE_TOKENS && lastTokens !== null) {
    const effectiveWindow = modelContextWindow - CONTEXT_LEFT_BASELINE_TOKENS;
    const used = Math.max(0, lastTokens - CONTEXT_LEFT_BASELINE_TOKENS);
    const remaining = Math.max(0, effectiveWindow - used);
    const percentLeft = clamp(Math.round((remaining / effectiveWindow) * 100), 0, 100);
    return {
      kind: "percent",
      value: percentLeft,
      suffix: "% context left",
      text: `${percentLeft}% context left`,
    };
  }
  if (totalTokens !== null && totalTokens >= 0) {
    return {
      kind: "text",
      value: null,
      suffix: "",
      text: `${compactTokenUsageCount(totalTokens)} used`,
    };
  }
  return {
    kind: "percent",
    value: 100,
    suffix: "% context left",
    text: "100% context left",
  };
}

function withContextAnnotation(display, annotation = "") {
  const annotationTokens = splitContextAnnotations(annotation);
  if (!annotationTokens.length) {
    return {
      ...display,
      annotation: "",
      annotationTokens: [],
      suffixBase: display.suffix,
    };
  }
  const suffix = annotationTokens.join(CONTEXT_LEFT_ANNOTATION_SEPARATOR);
  return {
    ...display,
    suffix: display.kind === "percent" ? `${display.suffix}${CONTEXT_LEFT_ANNOTATION_SEPARATOR}${suffix}` : display.suffix,
    text: `${display.text}${CONTEXT_LEFT_ANNOTATION_SEPARATOR}${suffix}`,
    annotation: suffix,
    annotationTokens,
    suffixBase: display.suffix,
  };
}

export function contextLeftPercentDigits(value) {
  const text = String(Math.max(0, Math.min(100, Number(value || 0) | 0))).padStart(3, " ");
  return text.split("").map((ch) => (ch === " " ? " " : ch));
}

function createContextLeftDigitSlot(char, documentRef, className = "mobileContextLeftDigitCurrent") {
  const slot = documentRef.createElement("span");
  slot.className = "mobileContextLeftDigitSlot";
  const inner = documentRef.createElement("span");
  inner.className = className;
  inner.textContent = char;
  slot.appendChild(inner);
  return slot;
}

function readContextLeftDocument(node, fallbackDocument = null) {
  return node?.__contextLeftDocumentRef || node?.ownerDocument || fallbackDocument || document;
}

function createContextLeftSuffixNode(display, documentRef) {
  const suffixNode = documentRef.createElement("span");
  suffixNode.className = "mobileContextLeftSuffix";
  const baseNode = documentRef.createElement("span");
  baseNode.className = "mobileContextLeftSuffixBase";
  baseNode.textContent = String(display.suffixBase || display.suffix || "");
  suffixNode.appendChild(baseNode);
  for (const token of display.annotationTokens || []) {
    const separatorNode = documentRef.createElement("span");
    separatorNode.className = "mobileContextLeftSeparator";
    separatorNode.textContent = CONTEXT_LEFT_ANNOTATION_SEPARATOR;
    const tokenNode = documentRef.createElement("span");
    tokenNode.className = "mobileContextLeftAnnotationToken";
    tokenNode.textContent = token;
    suffixNode.append(separatorNode, tokenNode);
  }
  return suffixNode;
}

function createStaticContextLeftPercentMarkup(value, display, documentRef) {
  const viewport = documentRef.createElement("span");
  viewport.className = "mobileContextLeftNumberViewport";
  for (const char of contextLeftPercentDigits(value)) {
    viewport.appendChild(createContextLeftDigitSlot(char, documentRef));
  }
  const frag = documentRef.createDocumentFragment();
  frag.appendChild(viewport);
  frag.appendChild(createContextLeftSuffixNode(display, documentRef));
  return frag;
}

function removeClassName(node, className) {
  if (!node || !className) return;
  if (node.classList?.remove) {
    node.classList.remove(className);
    return;
  }
  const next = String(node.className || "")
    .split(/\s+/)
    .filter((part) => part && part !== className)
    .join(" ");
  node.className = next;
}

function addClassName(node, className) {
  if (!node || !className) return;
  if (node.classList?.add) {
    node.classList.add(className);
    return;
  }
  const parts = String(node.className || "").split(/\s+/).filter(Boolean);
  if (!parts.includes(className)) parts.push(className);
  node.className = parts.join(" ");
}

function renderContextLeftSuffixNode(suffixNode, display, documentRef) {
  if (!suffixNode) return;
  suffixNode.replaceChildren(...createContextLeftSuffixNode(display, documentRef).children);
}

function triggerContextLeftAnnotationAnimation(node, suffixNode, prevAnnotationTokens, nextAnnotationTokens) {
  if (!node || !suffixNode) return;
  if (node.__contextLeftAnnotationTimer) {
    clearTimeout(node.__contextLeftAnnotationTimer);
    node.__contextLeftAnnotationTimer = 0;
  }
  const tokens = Array.from(suffixNode.querySelectorAll(".mobileContextLeftAnnotationToken"));
  const changedTokenNodes = tokens.filter((tokenNode, index) => prevAnnotationTokens[index] !== nextAnnotationTokens[index]);
  const removedTokenPairs = [];
  if (Array.isArray(prevAnnotationTokens) && prevAnnotationTokens.length > nextAnnotationTokens.length) {
    const documentRef = readContextLeftDocument(node, suffixNode?.ownerDocument || null);
    for (let index = nextAnnotationTokens.length; index < prevAnnotationTokens.length; index += 1) {
      const removedToken = String(prevAnnotationTokens[index] || "").trim();
      if (!removedToken) continue;
      const separatorNode = documentRef?.createElement?.("span") || null;
      const tokenNode = documentRef?.createElement?.("span") || null;
      if (!separatorNode || !tokenNode) continue;
      separatorNode.className = "mobileContextLeftSeparator is-annotation-exit";
      separatorNode.textContent = CONTEXT_LEFT_ANNOTATION_SEPARATOR;
      tokenNode.className = "mobileContextLeftAnnotationToken is-annotation-exit";
      tokenNode.textContent = removedToken;
      suffixNode.append(separatorNode, tokenNode);
      removedTokenPairs.push([separatorNode, tokenNode]);
    }
  }
  if (!changedTokenNodes.length && !removedTokenPairs.length) return;
  for (const tokenNode of changedTokenNodes) {
    removeClassName(tokenNode, "is-annotation-transition");
    try {
      void tokenNode.offsetWidth;
    } catch {}
    addClassName(tokenNode, "is-annotation-transition");
  }
  node.__contextLeftAnnotationTimer = setTimeout(() => {
    for (const tokenNode of changedTokenNodes) {
      if (!tokenNode.isConnected) continue;
      removeClassName(tokenNode, "is-annotation-transition");
    }
    for (const pair of removedTokenPairs) {
      for (const ghostNode of pair) ghostNode.remove?.();
    }
    node.__contextLeftAnnotationTimer = 0;
  }, CONTEXT_LEFT_ANNOTATION_ANIMATION_MS);
}

export function renderStaticComposerContextLeft(node, display, documentRef = document) {
  node.__contextLeftDocumentRef = documentRef;
  node.__contextLeftRenderSeq = (Number(node.__contextLeftRenderSeq || 0) + 1) | 0;
  if (display.kind === "percent") {
    node.replaceChildren(createStaticContextLeftPercentMarkup(display.value, display, documentRef));
  } else {
    node.textContent = display.text;
  }
  node.setAttribute("aria-label", display.text);
  node.dataset.contextKind = display.kind;
  node.dataset.contextText = display.text;
  node.dataset.contextValue = display.value === null ? "" : String(display.value);
  node.dataset.contextAnnotation = String(display.annotation || "");
}

export function renderAnimatedComposerContextLeftPercent(node, nextDisplay, prevValue, documentRef = document) {
  node.__contextLeftDocumentRef = documentRef;
  const viewport = node.querySelector(".mobileContextLeftNumberViewport");
  const suffixNode = node.querySelector(".mobileContextLeftSuffix");
  if (!viewport) {
    renderStaticComposerContextLeft(node, nextDisplay, documentRef);
    return;
  }
  const renderSeq = (Number(node.__contextLeftRenderSeq || 0) + 1) | 0;
  node.__contextLeftRenderSeq = renderSeq;
  node.setAttribute("aria-label", nextDisplay.text);
  node.dataset.contextKind = "percent";
  node.dataset.contextText = nextDisplay.text;
  node.dataset.contextValue = String(nextDisplay.value);
  node.dataset.contextAnnotation = String(nextDisplay.annotation || "");
  if (suffixNode) renderContextLeftSuffixNode(suffixNode, nextDisplay, documentRef);
  const prevDigits = contextLeftPercentDigits(prevValue);
  const nextDigits = contextLeftPercentDigits(nextDisplay.value);
  if (typeof viewport.animate !== "function") {
    viewport.replaceChildren(...nextDigits.map((char) => createContextLeftDigitSlot(char, documentRef)));
    return;
  }
  try {
    const animations = [];
    if (typeof viewport.getAnimations === "function") animations.push(...viewport.getAnimations());
    const activeDigits = viewport.querySelectorAll(".mobileContextLeftDigit");
    for (const digit of activeDigits) {
      if (typeof digit.getAnimations === "function") animations.push(...digit.getAnimations());
    }
    for (const animation of animations) animation.cancel();
  } catch {}
  const direction = nextDisplay.value >= prevValue ? 1 : -1;
  const travel = `${CONTEXT_LEFT_DIGIT_TRAVEL_PERCENT}%`;
  const incomingFrom = direction > 0 ? travel : `-${travel}`;
  const outgoingTo = direction > 0 ? `-${travel}` : travel;
  const slotNodes = [];
  const animationPromises = [];
  for (let i = 0; i < nextDigits.length; i += 1) {
    const prevChar = prevDigits[i];
    const nextChar = nextDigits[i];
    const slot = documentRef.createElement("span");
    slot.className = "mobileContextLeftDigitSlot";
    const delay = (nextDigits.length - 1 - i) * CONTEXT_LEFT_DIGIT_STAGGER_MS;
    if (prevChar === nextChar) {
      const current = documentRef.createElement("span");
      current.className = "mobileContextLeftDigitCurrent";
      current.textContent = nextChar;
      slot.appendChild(current);
      slotNodes.push(slot);
      continue;
    }
    const outgoing = documentRef.createElement("span");
    outgoing.className = "mobileContextLeftDigit";
    outgoing.textContent = prevChar;
    outgoing.style.transform = "translateY(0%)";
    outgoing.style.opacity = "1";
    const incoming = documentRef.createElement("span");
    incoming.className = "mobileContextLeftDigit";
    incoming.textContent = nextChar;
    incoming.style.transform = `translateY(${incomingFrom})`;
    incoming.style.opacity = "0.24";
    slot.append(outgoing, incoming);
    slotNodes.push(slot);
    outgoing.animate(
      [
        { transform: "translateY(0%)", opacity: 1 },
        { transform: `translateY(${outgoingTo})`, opacity: 0.24 },
      ],
      {
        duration: CONTEXT_LEFT_DIGIT_ANIMATION_MS,
        delay,
        easing: CONTEXT_LEFT_DIGIT_EASING,
        fill: "both",
      }
    );
    const incomingAnimation = incoming.animate(
      [
        { transform: `translateY(${incomingFrom})`, opacity: 0.24 },
        { transform: "translateY(0%)", opacity: 1 },
      ],
      {
        duration: CONTEXT_LEFT_DIGIT_ANIMATION_MS,
        delay,
        easing: CONTEXT_LEFT_DIGIT_EASING,
        fill: "both",
      }
    );
    if (incomingAnimation && typeof incomingAnimation.finished?.then === "function") {
      animationPromises.push(incomingAnimation.finished.catch(() => null));
    }
  }
  viewport.replaceChildren(...slotNodes);
  const finalize = () => {
    if (!viewport.isConnected) return;
    if (Number(node.__contextLeftRenderSeq || 0) != renderSeq) return;
    viewport.replaceChildren(...nextDigits.map((char) => createContextLeftDigitSlot(char, documentRef)));
  };
  if (animationPromises.length) {
    Promise.allSettled(animationPromises).then(finalize);
  } else {
    finalize();
  }
}

export function renderComposerContextLeft(node, tokenUsage, documentRef = document, options = {}) {
  if (!node) return;
  const annotation = String(options.annotation || "").trim();
  const display = withContextAnnotation(formatContextLeftDisplay(tokenUsage), annotation);
  const prevKind = String(node.dataset.contextKind || "");
  const prevText = String(node.dataset.contextText || node.textContent || "").trim();
  const prevAnnotation = String(node.dataset.contextAnnotation || "").trim();
  const prevAnnotationTokens = splitContextAnnotations(prevAnnotation);
  const prevValue = readNumber(node.dataset.contextValue);
  if (prevText === display.text && prevKind === display.kind) {
    if (!prevText) renderStaticComposerContextLeft(node, display, documentRef);
    return;
  }
  if (display.kind !== "percent") {
    renderStaticComposerContextLeft(node, display, documentRef);
    return;
  }
  if (prevKind !== "percent" || prevValue === null) {
    renderStaticComposerContextLeft(node, display, documentRef);
    if (prevAnnotation !== annotation) {
      triggerContextLeftAnnotationAnimation(
        node,
        node.querySelector(".mobileContextLeftSuffix"),
        prevAnnotationTokens,
        display.annotationTokens || []
      );
    }
    return;
  }
  renderAnimatedComposerContextLeftPercent(node, display, prevValue, documentRef);
  if (prevAnnotation !== annotation) {
    triggerContextLeftAnnotationAnimation(
      node,
      node.querySelector(".mobileContextLeftSuffix"),
      prevAnnotationTokens,
      display.annotationTokens || []
    );
  }
}
