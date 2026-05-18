import { describe, expect, it, vi } from "vitest";

import {
  advanceKeyboardMotionOffset,
  computeViewportMetrics,
  installMobileViewportSync,
  isComposerTextEntryActive,
  isEditableElement,
  shouldUseAppleMobileMotionTuning,
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

  it("only treats the main chat composer as a floating-composer text target", () => {
    expect(isComposerTextEntryActive({ id: "mobilePromptInput", tagName: "TEXTAREA" })).toBe(true);
    expect(isComposerTextEntryActive({ id: "threadSearchInput", tagName: "INPUT", type: "search" })).toBe(false);
    expect(isComposerTextEntryActive({ id: "tokenInput", tagName: "INPUT", type: "text" })).toBe(false);
  });

  it("uses compact width or an active iPad composer for floating composer mode", () => {
    expect(shouldUseFloatingComposerLayout({
      innerWidth: 900,
      matchMedia() {
        return { matches: false };
      },
      navigator: { maxTouchPoints: 0 },
    })).toBe(true);
    expect(shouldUseFloatingComposerLayout({
      matchMedia(query) {
        return { matches: query === "(pointer: coarse)" };
      },
      innerWidth: 1400,
      navigator: { maxTouchPoints: 0 },
      document: {
        activeElement: { id: "mobilePromptInput", tagName: "TEXTAREA" },
      },
    })).toBe(false);
    expect(shouldUseFloatingComposerLayout({
      matchMedia() {
        return { matches: false };
      },
      innerWidth: 1400,
      navigator: { maxTouchPoints: 5 },
      document: {
        activeElement: { id: "mobilePromptInput", tagName: "TEXTAREA" },
      },
    })).toBe(false);
    expect(shouldUseFloatingComposerLayout({
      innerWidth: 1194,
      document: {
        documentElement: { clientWidth: 1194 },
        activeElement: { id: "mobilePromptInput", tagName: "TEXTAREA" },
      },
      navigator: {
        userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
        platform: "iPad",
        maxTouchPoints: 5,
      },
      matchMedia(query) {
        return { matches: query === "(pointer: coarse)" || query === "(hover: none)" };
      },
    })).toBe(true);
    expect(shouldUseFloatingComposerLayout({
      innerWidth: 1194,
      document: {
        documentElement: { clientWidth: 1194 },
        activeElement: { id: "threadSearchInput", tagName: "INPUT", type: "search" },
      },
      navigator: {
        userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
        platform: "iPad",
        maxTouchPoints: 5,
      },
      matchMedia(query) {
        return { matches: query === "(pointer: coarse)" || query === "(hover: none)" };
      },
    })).toBe(false);
    expect(shouldUseFloatingComposerLayout({
      innerWidth: 1280,
      document: {
        documentElement: { clientWidth: 1280 },
        activeElement: { id: "mobilePromptInput", tagName: "TEXTAREA" },
      },
      navigator: {
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel Tablet Build/UP1A.231005.007)",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
      matchMedia(query) {
        return { matches: query === "(pointer: coarse)" || query === "(hover: none)" };
      },
    })).toBe(true);
    expect(shouldUseFloatingComposerLayout({
      innerWidth: 1280,
      document: {
        documentElement: { clientWidth: 1280 },
        activeElement: { id: "threadSearchInput", tagName: "INPUT", type: "search" },
      },
      navigator: {
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel Tablet Build/UP1A.231005.007)",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
      matchMedia(query) {
        return { matches: query === "(pointer: coarse)" || query === "(hover: none)" };
      },
    })).toBe(false);
    expect(shouldUseFloatingComposerLayout({
      matchMedia() {
        return { matches: false };
      },
      innerWidth: 1400,
      navigator: { maxTouchPoints: 0 },
    })).toBe(false);
  });

  it("advances keyboard motion toward the target in smooth steps", () => {
    const opening = advanceKeyboardMotionOffset(0, 300);
    const closing = advanceKeyboardMotionOffset(300, 0);

    expect(opening).toBeGreaterThan(0);
    expect(opening).toBeLessThan(300);
    expect(closing).toBeGreaterThan(0);
    expect(closing).toBeLessThan(300);
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
      innerWidth: 390,
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
    installMobileViewportSync({ windowRef, documentRef });

    expect(rootStyle.setProperty).toHaveBeenCalledWith("--app-height", "820px");
    expect(rootStyle.setProperty).toHaveBeenCalledWith("--visual-viewport-height", "520px");
    expect(rootStyle.setProperty).toHaveBeenCalledWith("--keyboard-offset", "0px");
    expect(bodyClassList.toggle).toHaveBeenCalledWith("mobile-keyboard-open", true);
    expect(bodyClassList.toggle).toHaveBeenCalledWith("floating-composer-layout", true);
    expect(bodyClassList.toggle).toHaveBeenCalledWith("apple-mobile-motion", false);
    expect(windowRef.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(vvHandlers.has("resize")).toBe(true);
    expect(vvHandlers.has("scroll")).toBe(true);
    expect(docHandlers.has("focusin")).toBe(true);
    expect(winHandlers.has("resize")).toBe(true);
  });

  it("animates keyboard offset changes instead of jumping directly", () => {
    vi.useFakeTimers();
    const rootStyle = { setProperty: vi.fn() };
    const vvHandlers = new Map();
    const documentRef = {
      activeElement: { tagName: "TEXTAREA" },
      documentElement: { clientHeight: 820, style: rootStyle },
      body: { classList: { toggle() {} } },
      addEventListener() {},
      removeEventListener() {},
    };
    const visualViewport = {
      height: 520,
      offsetTop: 0,
      addEventListener(event, handler) { vvHandlers.set(event, handler); },
      removeEventListener(event) { vvHandlers.delete(event); },
    };
    const windowRef = {
      innerHeight: 820,
      innerWidth: 390,
      visualViewport,
      addEventListener() {},
      removeEventListener() {},
      matchMedia(query) {
        return { matches: query === "(pointer: coarse)" };
      },
      requestAnimationFrame(callback) {
        callback();
        return 1;
      },
      scrollTo() {},
      setTimeout,
      clearTimeout,
    };

    installMobileViewportSync({ windowRef, documentRef });
    const initialCalls = rootStyle.setProperty.mock.calls
      .filter(([name]) => name === "--keyboard-offset")
      .map(([, value]) => value);
    expect(initialCalls).toContain("0px");

    visualViewport.height = 610;
    vvHandlers.get("resize")?.();

    const afterResizeCalls = rootStyle.setProperty.mock.calls
      .filter(([name]) => name === "--keyboard-offset")
      .map(([, value]) => value);
    expect(afterResizeCalls).not.toContain("300px");

    vi.advanceTimersByTime(32);

    const animatedCalls = rootStyle.setProperty.mock.calls
      .filter(([name]) => name === "--keyboard-offset")
      .map(([, value]) => value);
    expect(animatedCalls.some((value) => value !== "0px")).toBe(true);
    vi.useRealTimers();
  });

  it("eases the keyboard offset back down when the keyboard closes", () => {
    vi.useFakeTimers();
    const rootStyle = { setProperty: vi.fn() };
    const vvHandlers = new Map();
    const documentRef = {
      activeElement: { tagName: "TEXTAREA" },
      documentElement: { clientHeight: 820, style: rootStyle },
      body: { classList: { toggle() {} } },
      addEventListener() {},
      removeEventListener() {},
    };
    const visualViewport = {
      height: 520,
      offsetTop: 0,
      addEventListener(event, handler) { vvHandlers.set(event, handler); },
      removeEventListener(event) { vvHandlers.delete(event); },
    };
    const windowRef = {
      innerHeight: 820,
      innerWidth: 390,
      visualViewport,
      addEventListener() {},
      removeEventListener() {},
      matchMedia(query) {
        return { matches: query === "(pointer: coarse)" };
      },
      requestAnimationFrame(callback) {
        callback();
        return 1;
      },
      scrollTo() {},
      setTimeout,
      clearTimeout,
    };

    installMobileViewportSync({ windowRef, documentRef });
    vi.advanceTimersByTime(160);
    rootStyle.setProperty.mockClear();

    visualViewport.height = 820;
    vvHandlers.get("resize")?.();

    const closeStartCalls = rootStyle.setProperty.mock.calls
      .filter(([name]) => name === "--keyboard-offset")
      .map(([, value]) => value);
    expect(Number.parseInt(closeStartCalls.at(-1) || "0", 10)).toBeGreaterThan(200);

    vi.advanceTimersByTime(16);

    const closeFrameCalls = rootStyle.setProperty.mock.calls
      .filter(([name]) => name === "--keyboard-offset")
      .map(([, value]) => value);
    expect(closeFrameCalls).not.toContain("0px");

    vi.advanceTimersByTime(420);

    const closeEndCalls = rootStyle.setProperty.mock.calls
      .filter(([name]) => name === "--keyboard-offset")
      .map(([, value]) => value);
    expect(closeEndCalls.at(-1)).toBe("0px");
    vi.useRealTimers();
  });

  it("recomputes floating composer mode when only the viewport width changes", () => {
    const rootStyle = { setProperty: vi.fn() };
    const bodyClassList = { toggle: vi.fn() };
    const winHandlers = new Map();
    const documentRef = {
      activeElement: null,
      documentElement: { clientHeight: 820, clientWidth: 1320, style: rootStyle },
      body: { classList: bodyClassList },
      addEventListener() {},
      removeEventListener() {},
    };
    const windowRef = {
      innerHeight: 820,
      innerWidth: 1320,
      addEventListener(event, handler) { winHandlers.set(event, handler); },
      removeEventListener(event) { winHandlers.delete(event); },
      matchMedia() {
        return { matches: false };
      },
      navigator: { maxTouchPoints: 0 },
      requestAnimationFrame(callback) {
        callback();
        return 1;
      },
    };

    installMobileViewportSync({ windowRef, documentRef });
    expect(bodyClassList.toggle).toHaveBeenCalledWith("floating-composer-layout", false);

    bodyClassList.toggle.mockClear();
    rootStyle.setProperty.mockClear();
    windowRef.innerWidth = 900;
    documentRef.documentElement.clientWidth = 900;
    const resizeHandler = winHandlers.get("resize");
    expect(resizeHandler).toBeTypeOf("function");
    resizeHandler();

    expect(bodyClassList.toggle).toHaveBeenCalledWith("floating-composer-layout", true);
    expect(rootStyle.setProperty).toHaveBeenCalledWith("--app-height", "820px");
  });

  it("enables apple mobile motion tuning only on iPhone-like devices", () => {
    expect(shouldUseAppleMobileMotionTuning({
      navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 },
    })).toBe(true);
    expect(shouldUseAppleMobileMotionTuning({
      navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 0 },
    })).toBe(false);
  });

  it("applies the apple mobile motion class during viewport sync for iPhone-like devices", () => {
    const rootStyle = { setProperty: vi.fn() };
    const bodyClassList = { toggle: vi.fn() };
    const visualViewport = {
      height: 520,
      offsetTop: 0,
      addEventListener() {},
      removeEventListener() {},
    };
    const documentRef = {
      activeElement: { tagName: "INPUT", type: "search" },
      documentElement: { clientHeight: 820, style: rootStyle },
      body: { classList: bodyClassList },
      addEventListener() {},
      removeEventListener() {},
    };
    const windowRef = {
      innerHeight: 820,
      innerWidth: 390,
      visualViewport,
      navigator: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        platform: "iPhone",
        maxTouchPoints: 5,
      },
      addEventListener() {},
      removeEventListener() {},
      requestAnimationFrame(callback) {
        callback();
        return 1;
      },
      scrollTo() {},
    };

    installMobileViewportSync({ windowRef, documentRef });

    expect(bodyClassList.toggle).toHaveBeenCalledWith("apple-mobile-motion", true);
  });

  it("does not force floating composer layout when iPad search input owns the keyboard", () => {
    const bodyClassList = { toggle: vi.fn() };
    const documentRef = {
      activeElement: { id: "threadSearchInput", tagName: "INPUT", type: "search" },
      documentElement: { clientHeight: 834, clientWidth: 1194, style: { setProperty() {} } },
      body: { classList: bodyClassList },
      addEventListener() {},
      removeEventListener() {},
    };
    const windowRef = {
      innerHeight: 834,
      innerWidth: 1194,
      visualViewport: { height: 534, offsetTop: 0, addEventListener() {}, removeEventListener() {} },
      navigator: {
        userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
        platform: "iPad",
        maxTouchPoints: 5,
      },
      addEventListener() {},
      removeEventListener() {},
      requestAnimationFrame(callback) {
        callback();
        return 1;
      },
    };

    installMobileViewportSync({ windowRef, documentRef });

    expect(bodyClassList.toggle).toHaveBeenCalledWith("mobile-keyboard-open", true);
    expect(bodyClassList.toggle).toHaveBeenCalledWith("floating-composer-layout", false);
  });
});
