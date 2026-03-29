import { describe, expect, it } from "vitest";

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
});
