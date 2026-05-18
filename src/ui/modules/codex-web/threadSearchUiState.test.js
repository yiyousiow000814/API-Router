import { describe, expect, it, vi } from "vitest";

import { resetThreadSearchUiState, syncThreadSearchUiState } from "./threadSearchUiState.js";

describe("threadSearchUiState", () => {
  it("syncs mobile search classes from state", () => {
    const panelClasses = new Set();
    const bodyClasses = new Set();
    const input = {
      attrs: new Map(),
      setAttribute(name, value) {
        this.attrs.set(name, value);
      },
    };
    const panel = {
      classList: {
        toggle(name, enabled) {
          if (enabled) panelClasses.add(name);
          else panelClasses.delete(name);
        },
      },
    };
    const body = {
      classList: {
        toggle(name, enabled) {
          if (enabled) bodyClasses.add(name);
          else bodyClasses.delete(name);
        },
      },
    };
    const state = {
      threadSearchOpen: true,
      threadSearchMobileMode: false,
      threadSearchTransitionPhase: "opening",
      threadSearchQuery: "abc",
    };

    const result = syncThreadSearchUiState({
      state,
      panel,
      input,
      body,
      isCompactViewport: () => true,
    });

    expect(result).toEqual({ open: true, mobileMode: true });
    expect(state.threadSearchMobileMode).toBe(true);
    expect(panelClasses.has("search-open")).toBe(true);
    expect(panelClasses.has("search-mobile-mode")).toBe(true);
    expect(panelClasses.has("search-has-query")).toBe(true);
    expect(panelClasses.has("search-transition-opening")).toBe(true);
    expect(panelClasses.has("search-transition-closing")).toBe(false);
    expect(bodyClasses.has("drawer-left-search-open")).toBe(true);
    expect(input.attrs.get("aria-expanded")).toBe("true");
  });

  it("resets mobile search state and dom through the shared helper", () => {
    const panelClasses = new Set([
      "search-open",
      "search-mobile-mode",
      "search-has-query",
      "search-transition-opening",
    ]);
    const bodyClasses = new Set(["drawer-left-search-open"]);
    const input = {
      value: "abc",
      attrs: new Map([["aria-expanded", "true"]]),
      setAttribute(name, value) {
        this.attrs.set(name, value);
      },
    };
    const panel = {
      classList: {
        toggle(name, enabled) {
          if (enabled) panelClasses.add(name);
          else panelClasses.delete(name);
        },
      },
    };
    const body = {
      classList: {
        toggle(name, enabled) {
          if (enabled) bodyClasses.add(name);
          else bodyClasses.delete(name);
        },
      },
    };
    const state = {
      threadSearchOpen: true,
      threadSearchMobileMode: true,
      threadSearchTransitionPhase: "opening",
      threadSearchQuery: "abc",
      threadSearchTransitionTimer: 123,
    };
    const clearTimeoutFn = vi.fn();

    resetThreadSearchUiState({
      state,
      panel,
      input,
      body,
      clearScheduledTimeout: clearTimeoutFn,
      isCompactViewport: () => true,
    });

    expect(clearTimeoutFn).toHaveBeenCalledWith(123);
    expect(state.threadSearchOpen).toBe(false);
    expect(state.threadSearchMobileMode).toBe(false);
    expect(state.threadSearchTransitionPhase).toBe("");
    expect(state.threadSearchQuery).toBe("");
    expect(state.threadSearchTransitionTimer).toBe(0);
    expect(input.value).toBe("");
    expect(input.attrs.get("aria-expanded")).toBe("false");
    expect(panelClasses.size).toBe(0);
    expect(bodyClasses.size).toBe(0);
  });
});
