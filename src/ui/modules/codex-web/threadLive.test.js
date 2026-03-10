import { describe, expect, it } from "vitest";

import { resolveThreadAutoRefreshInterval } from "./threadLive.js";

describe("threadLive", () => {
  it("prefers connected interval only when ws is open and subscribed", () => {
    expect(resolveThreadAutoRefreshInterval(true, true, 20000, 3500)).toBe(20000);
    expect(resolveThreadAutoRefreshInterval(true, false, 20000, 3500)).toBe(3500);
    expect(resolveThreadAutoRefreshInterval(false, true, 20000, 3500)).toBe(3500);
  });
});
