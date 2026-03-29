import { describe, expect, it } from "vitest";

import {
  CONTEXT_LEFT_BASELINE_TOKENS,
  contextLeftPercentDigits,
  formatContextLeftDisplay,
  normalizeThreadTokenUsage,
  renderComposerContextLeft,
} from "./contextLeft.js";

function createFakeElement(tagName = "span") {
  const node = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    textContent: "",
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    isConnected: true,
    appendChild(child) {
      if (!child) return child;
      if (child.__isFragment) {
        for (const grandchild of child.children) {
          grandchild.parentNode = this;
          this.children.push(grandchild);
        }
        return child;
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    append(...children) {
      for (const child of children) this.appendChild(child);
    },
    replaceChildren(...children) {
      this.children = [];
      this.textContent = "";
      for (const child of children) this.appendChild(child);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    querySelector(selector) {
      return findFirstMatching(this, selector);
    },
    querySelectorAll(selector) {
      const matches = [];
      collectMatches(this, selector, matches);
      return matches;
    },
  };
  return node;
}

function createFakeDocument() {
  return {
    createElement(tagName) {
      return createFakeElement(tagName);
    },
    createDocumentFragment() {
      const fragment = createFakeElement("#fragment");
      fragment.__isFragment = true;
      return fragment;
    },
  };
}

function matchesSelector(node, selector) {
  if (!selector.startsWith(".")) return false;
  const className = selector.slice(1);
  return String(node.className || "")
    .split(/\s+/)
    .filter(Boolean)
    .includes(className);
}

function findFirstMatching(node, selector) {
  for (const child of node.children || []) {
    if (matchesSelector(child, selector)) return child;
    const nested = findFirstMatching(child, selector);
    if (nested) return nested;
  }
  return null;
}

function collectMatches(node, selector, matches) {
  for (const child of node.children || []) {
    if (matchesSelector(child, selector)) matches.push(child);
    collectMatches(child, selector, matches);
  }
}

function readViewportDigits(node) {
  const viewport = node.querySelector(".mobileContextLeftNumberViewport");
  return (viewport?.children || []).map((slot) => slot.children?.[0]?.textContent ?? "");
}

function readNodeText(node) {
  if (!node) return "";
  const own = String(node.textContent || "");
  const childText = (node.children || []).map((child) => readNodeText(child)).join("");
  return `${own}${childText}`;
}

describe("contextLeft", () => {
  it("normalizes token usage payloads from snake_case and camelCase", () => {
    expect(
      normalizeThreadTokenUsage({
        total_token_usage: { total_tokens: "1250" },
        last: { totalTokens: 12800 },
        model_context_window: 20000,
      })
    ).toEqual({
      total: {
        totalTokens: 1250,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
      },
      last: {
        totalTokens: 12800,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
      },
      modelContextWindow: 20000,
    });
  });

  it("formats percent-left display when context window is available", () => {
    expect(
      formatContextLeftDisplay({
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 4000 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      })
    ).toEqual({
      kind: "percent",
      value: 60,
      suffix: "% context left",
      text: "60% context left",
    });
  });

  it("falls back to total token summary when percent data is unavailable", () => {
    expect(formatContextLeftDisplay({ total: { totalTokens: 1530 } })).toEqual({
      kind: "text",
      value: null,
      suffix: "",
      text: "1.5K used",
    });
    expect(formatContextLeftDisplay(null)).toEqual({
      kind: "percent",
      value: 100,
      suffix: "% context left",
      text: "100% context left",
    });
  });

  it("pads percent digits for stable width", () => {
    expect(contextLeftPercentDigits(7)).toEqual([" ", " ", "7"]);
    expect(contextLeftPercentDigits(45)).toEqual([" ", "4", "5"]);
    expect(contextLeftPercentDigits(100)).toEqual(["1", "0", "0"]);
  });

  it("renders static and updated percent displays without losing state", () => {
    const documentRef = createFakeDocument();
    const node = createFakeElement("div");

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 2000 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef
    );
    expect(node.dataset.contextKind).toBe("percent");
    expect(node.dataset.contextText).toBe("80% context left");
    expect(readViewportDigits(node)).toEqual([" ", "8", "0"]);

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 6000 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef
    );
    expect(node.dataset.contextText).toBe("40% context left");
    expect(readViewportDigits(node)).toEqual([" ", "4", "0"]);
  });

  it("renders text mode when only total usage exists", () => {
    const documentRef = createFakeDocument();
    const node = createFakeElement("div");

    renderComposerContextLeft(node, { total: { totalTokens: 900 } }, documentRef);

    expect(node.dataset.contextKind).toBe("text");
    expect(node.dataset.contextText).toBe("900 used");
    expect(node.textContent).toBe("900 used");
  });

  it("appends the plan mode annotation when requested", () => {
    const documentRef = createFakeDocument();
    const node = createFakeElement("div");

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 2000 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef,
      { annotation: "plan mode" }
    );

    expect(node.dataset.contextText).toBe("80% context left · plan mode");
    expect(node.getAttribute ? node.getAttribute("aria-label") : node.attributes["aria-label"]).toBe(
      "80% context left · plan mode"
    );
    const suffix = node.querySelector(".mobileContextLeftSuffix");
    expect(readNodeText(suffix)).toBe("% context left · plan mode");
  });

  it("appends multiple status annotations in order", () => {
    const documentRef = createFakeDocument();
    const node = createFakeElement("div");

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 2000 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef,
      { annotation: "full access · fast · plan mode" }
    );

    expect(node.dataset.contextText).toBe("80% context left · full access · fast · plan mode");
    expect(node.getAttribute ? node.getAttribute("aria-label") : node.attributes["aria-label"]).toBe(
      "80% context left · full access · fast · plan mode"
    );
    const suffix = node.querySelector(".mobileContextLeftSuffix");
    expect(readNodeText(suffix)).toBe("% context left · full access · fast · plan mode");
  });

  it("updates the visible suffix during animated percent rerenders", () => {
    const documentRef = createFakeDocument();
    const node = createFakeElement("div");

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 3900 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef
    );

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 4000 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef,
      { annotation: "full access · fast" }
    );

    expect(node.dataset.contextText).toBe("60% context left · full access · fast");
    const suffix = node.querySelector(".mobileContextLeftSuffix");
    expect(readNodeText(suffix)).toBe("% context left · full access · fast");
  });

  it("animates only changed annotation tokens", () => {
    const documentRef = createFakeDocument();
    const node = createFakeElement("div");

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 3900 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef
    );

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 3900 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef,
      { annotation: "fast · plan mode" }
    );

    const suffix = node.querySelector(".mobileContextLeftSuffix");
    expect(String(suffix?.className || "")).not.toContain("is-annotation-transition");
    const tokens = node.querySelectorAll(".mobileContextLeftAnnotationToken");
    expect(tokens).toHaveLength(2);
    expect(readNodeText(tokens[0])).toBe("fast");
    expect(readNodeText(tokens[1])).toBe("plan mode");
    expect(String(tokens[0]?.className || "")).toContain("is-annotation-transition");
    expect(String(tokens[1]?.className || "")).toContain("is-annotation-transition");
  });

  it("preserves unchanged annotation tokens without animating them again", () => {
    const documentRef = createFakeDocument();
    const node = createFakeElement("div");

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 3900 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef,
      { annotation: "full access · fast" }
    );

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 3900 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef,
      { annotation: "full access · plan mode" }
    );

    const tokens = node.querySelectorAll(".mobileContextLeftAnnotationToken");
    expect(tokens).toHaveLength(2);
    expect(readNodeText(tokens[0])).toBe("full access");
    expect(readNodeText(tokens[1])).toBe("plan mode");
    expect(String(tokens[0]?.className || "")).not.toContain("is-annotation-transition");
    expect(String(tokens[1]?.className || "")).toContain("is-annotation-transition");
  });

  it("animates removed trailing annotation tokens on exit", () => {
    const documentRef = createFakeDocument();
    const node = createFakeElement("div");

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 3900 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef,
      { annotation: "full access · fast" }
    );

    renderComposerContextLeft(
      node,
      {
        last: { totalTokens: CONTEXT_LEFT_BASELINE_TOKENS + 3900 },
        modelContextWindow: CONTEXT_LEFT_BASELINE_TOKENS + 10000,
      },
      documentRef,
      { annotation: "full access" }
    );

    const exitingTokens = node.querySelectorAll(".is-annotation-exit");
    expect(exitingTokens).toHaveLength(2);
    expect(readNodeText(exitingTokens[0])).toBe(" · ");
    expect(readNodeText(exitingTokens[1])).toBe("fast");
  });
});
