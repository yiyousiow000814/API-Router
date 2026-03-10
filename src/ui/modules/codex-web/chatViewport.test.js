import { describe, expect, it } from "vitest";

import {
  chatDistanceFromMetrics,
  isNearBottomForJumpButton,
} from "./chatViewport.js";

describe("chatViewport", () => {
  it("computes distance from bottom", () => {
    expect(chatDistanceFromMetrics(1200, 900, 250)).toBe(50);
    expect(chatDistanceFromMetrics(1200, 980, 250)).toBe(0);
  });

  it("uses threshold for jump button visibility", () => {
    expect(isNearBottomForJumpButton(1200, 820, 250, 180)).toBe(true);
    expect(isNearBottomForJumpButton(1200, 600, 250, 180)).toBe(false);
  });
});
