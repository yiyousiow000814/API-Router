import { describe, expect, it } from "vitest";

import { relativeTimeLabel, truncateLabel } from "./appPersistence.js";

describe("appPersistence", () => {
  it("truncates labels with ellipsis", () => {
    expect(truncateLabel("123456", 5)).toBe("1234â€¦");
  });

  it("formats relative time labels", () => {
    expect(relativeTimeLabel(Date.now() - 2 * 86400 * 1000)).toBe("2d");
  });
});
