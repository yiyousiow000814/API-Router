import { describe, expect, it } from "vitest";

import {
  resolveActionErrorMessage,
  shouldSubmitPromptKey,
} from "./actionBindings.js";

describe("actionBindings", () => {
  it("submits only plain enter presses", () => {
    expect(shouldSubmitPromptKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(
      true
    );
    expect(shouldSubmitPromptKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(
      false
    );
    expect(shouldSubmitPromptKey({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });

  it("normalizes action error messages", () => {
    expect(resolveActionErrorMessage(new Error("boom"))).toBe("boom");
    expect(resolveActionErrorMessage(null, "fallback")).toBe("fallback");
  });
});
