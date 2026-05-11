import { describe, expect, it, vi } from "vitest";

import { createUiHelpersModule, shouldSuppressSyntheticClickEvent } from "./uiHelpers.js";

describe("uiHelpers", () => {
  it("suppresses only click events inside the suppression window", () => {
    expect(shouldSuppressSyntheticClickEvent(100, 90, "click")).toBe(true);
    expect(shouldSuppressSyntheticClickEvent(100, 101, "click")).toBe(false);
    expect(shouldSuppressSyntheticClickEvent(100, 90, "pointerdown")).toBe(false);
  });

  it("reads embedded token when placeholder was replaced", () => {
    const helpers = createUiHelpersModule({
      state: {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      normalizeWorkspaceTarget: (value) => value,
      setStatus: () => {},
      documentRef: { body: { classList: { contains: () => false } }, getElementById: () => null },
      performanceRef: { now: () => 0 },
      windowRef: {
        __WEB_CODEX_EMBEDDED_TOKEN__: "token-123",
        getComputedStyle: () => ({ display: "block" }),
      },
    });
    expect(helpers.getEmbeddedToken()).toBe("token-123");
  });

  it("can close a backdrop on pointer release instead of pointer press", () => {
    const handlers = new Map();
    const backdrop = {
      __wiredBlurBackdropShield: false,
      addEventListener(name, handler) {
        handlers.set(name, handler);
      },
    };
    const onClose = vi.fn();
    const event = {
      target: backdrop,
      type: "pointerup",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const module = createUiHelpersModule({
      state: { suppressSyntheticClickUntil: 0 },
      threadAnimDebug: { enabled: false, seq: 0, events: [] },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      setStatus() {},
      documentRef: { body: { classList: { contains() { return false; } } } },
      performanceRef: { now() { return 0; } },
      windowRef: {},
    });

    module.wireBlurBackdropShield(backdrop, { closeEvent: "pointerup", onClose });

    expect(handlers.has("pointerdown")).toBe(false);
    expect(handlers.has("pointerup")).toBe(true);

    handlers.get("pointerup")(event);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("runs responsive click once when iOS dispatches a delayed click after pointerdown", () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map();
      const button = {
        addEventListener(name, handler) {
          listeners.set(name, handler);
        },
      };
      const module = createUiHelpersModule({
        state: { suppressSyntheticClickUntil: 0 },
        threadAnimDebug: { enabled: false, seq: 0, events: [] },
        normalizeWorkspaceTarget(value) {
          return value;
        },
        setStatus() {},
        documentRef: {
          body: { classList: { contains() { return false; } } },
          getElementById(id) {
            return id === "send" ? button : null;
          },
        },
        performanceRef: { now() { return 0; } },
        windowRef: {},
      });
      const handler = vi.fn();

      module.bindResponsiveClick("send", handler);
      listeners.get("pointerdown")({
        type: "pointerdown",
        preventDefault() {},
        stopPropagation() {},
      });
      vi.advanceTimersByTime(650);
      listeners.get("click")({
        type: "click",
        preventDefault() {},
        stopPropagation() {},
      });

      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a responsive click binding instead of stacking duplicate handlers", () => {
    const listeners = new Map();
    const button = {
      addEventListener(name, handler) {
        const items = listeners.get(name) || [];
        items.push(handler);
        listeners.set(name, items);
      },
    };
    const module = createUiHelpersModule({
      state: { suppressSyntheticClickUntil: 0 },
      threadAnimDebug: { enabled: false, seq: 0, events: [] },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      setStatus() {},
      documentRef: {
        body: { classList: { contains() { return false; } } },
        getElementById(id) {
          return id === "send" ? button : null;
        },
      },
      performanceRef: { now() { return 0; } },
      windowRef: {},
    });
    const first = vi.fn();
    const second = vi.fn();

    module.bindResponsiveClick("send", first);
    module.bindResponsiveClick("send", second);
    for (const handler of listeners.get("pointerdown") || []) {
      handler({
        type: "pointerdown",
        preventDefault() {},
        stopPropagation() {},
      });
    }

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a later intentional click after a missing synthetic click window expires", () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map();
      const button = {
        addEventListener(name, handler) {
          listeners.set(name, handler);
        },
      };
      const module = createUiHelpersModule({
        state: { suppressSyntheticClickUntil: 0 },
        threadAnimDebug: { enabled: false, seq: 0, events: [] },
        normalizeWorkspaceTarget(value) {
          return value;
        },
        setStatus() {},
        documentRef: {
          body: { classList: { contains() { return false; } } },
          getElementById(id) {
            return id === "send" ? button : null;
          },
        },
        performanceRef: { now() { return 0; } },
        windowRef: {},
      });
      const handler = vi.fn();

      module.bindResponsiveClick("send", handler);
      listeners.get("pointerdown")({
        type: "pointerdown",
        preventDefault() {},
        stopPropagation() {},
      });
      vi.advanceTimersByTime(2500);
      listeners.get("click")({
        type: "click",
        preventDefault() {},
        stopPropagation() {},
      });

      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
