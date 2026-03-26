import { describe, expect, it, vi } from "vitest";

import {
  computeViewportMetrics,
  installMobileViewportSync,
  isEditableElement,
  shouldUseFloatingComposerLayout,
} from "./mobileViewport.js";

describe("mobileViewport", () => {
  it("derives keyboard offset only while text entry is active", () => {
    expect(computeViewportMetrics({
      innerHeight: 844,
      clientHeight: 844,
      visualViewportHeight: 544,
      visualViewportOffsetTop: 0,
      isTextEntryActive: true,
    })).toMatchObject({
      viewportHeight: 544,
      keyboardOffset: 300,
    });

    expect(computeViewportMetrics({
      innerHeight: 844,
      clientHeight: 844,
      visualViewportHeight: 544,
      visualViewportOffsetTop: 0,
      isTextEntryActive: false,
    })).toMatchObject({
      viewportHeight: 544,
      keyboardOffset: 0,
    });
  });

  it("treats textarea and text-like inputs as editable", () => {
    expect(isEditableElement({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableElement({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isEditableElement({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isEditableElement({ tagName: "INPUT", type: "file" })).toBe(false);
    expect(isEditableElement({ tagName: "BUTTON" })).toBe(false);
  });

  it("uses pointer capabilities instead of a width breakpoint for floating composer mode", () => {
    expect(shouldUseFloatingComposerLayout({
      matchMedia(query) {
        return { matches: query === "(pointer: coarse)" };
      },
      navigator: { maxTouchPoints: 0 },
    })).toBe(true);
    expect(shouldUseFloatingComposerLayout({
      matchMedia() {
        return { matches: false };
      },
      navigator: { maxTouchPoints: 5 },
    })).toBe(true);
    expect(shouldUseFloatingComposerLayout({
      matchMedia() {
        return { matches: false };
      },
      navigator: { maxTouchPoints: 0 },
    })).toBe(false);
  });

  it("syncs viewport CSS variables from visualViewport changes", () => {
    const rootStyle = { setProperty: vi.fn() };
    const bodyClassList = { toggle: vi.fn() };
    const docHandlers = new Map();
    const winHandlers = new Map();
    const vvHandlers = new Map();
    const visualViewport = {
      height: 520,
      offsetTop: 0,
      addEventListener(event, handler) { vvHandlers.set(event, handler); },
      removeEventListener(event) { vvHandlers.delete(event); },
    };
    const documentRef = {
      activeElement: { tagName: "TEXTAREA" },
      documentElement: { clientHeight: 820, style: rootStyle },
      body: { classList: bodyClassList },
      addEventListener(event, handler) { docHandlers.set(event, handler); },
      removeEventListener(event) { docHandlers.delete(event); },
    };
    const windowRef = {
      innerHeight: 820,
      visualViewport,
      addEventListener(event, handler) { winHandlers.set(event, handler); },
      removeEventListener(event) { winHandlers.delete(event); },
      matchMedia(query) {
        return { matches: query === "(pointer: coarse)" };
      },
      scrollTo: vi.fn(),
      requestAnimationFrame(callback) {
        callback();
        return 1;
      },
    };
    const updateMobileComposerState = vi.fn();

    installMobileViewportSync({ windowRef, documentRef, updateMobileComposerState });

    expect(rootStyle.setProperty).toHaveBeenCalledWith("--app-height", "520px");
    expect(rootStyle.setProperty).toHaveBeenCalledWith("--visual-viewport-height", "520px");
    expect(rootStyle.setProperty).toHaveBeenCalledWith("--keyboard-offset", "300px");
    expect(bodyClassList.toggle).toHaveBeenCalledWith("mobile-keyboard-open", true);
    expect(bodyClassList.toggle).toHaveBeenCalledWith("floating-composer-layout", true);
    expect(windowRef.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(updateMobileComposerState).toHaveBeenCalledTimes(1);
    expect(vvHandlers.has("resize")).toBe(true);
    expect(vvHandlers.has("scroll")).toBe(true);
    expect(docHandlers.has("focusin")).toBe(true);
    expect(winHandlers.has("resize")).toBe(true);
  });
});
