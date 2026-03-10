import { describe, expect, it } from "vitest";

import { shouldOpenDrawerWithAnimation } from "./mobileShell.js";

describe("mobileShell", () => {
  it("animates only when opening thread drawer from closed state", () => {
    expect(shouldOpenDrawerWithAnimation("threads", false)).toBe(true);
    expect(shouldOpenDrawerWithAnimation("threads", true)).toBe(false);
    expect(shouldOpenDrawerWithAnimation("chat", false)).toBe(false);
  });
});
