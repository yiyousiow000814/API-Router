import { describe, expect, it } from "vitest";

import { clampNumber, dataUrlToBlob } from "./imageViewer.js";

describe("imageViewer", () => {
  it("clamps values into range", () => {
    expect(clampNumber(0, 1, 5)).toBe(1);
    expect(clampNumber(3, 1, 5)).toBe(3);
    expect(clampNumber(8, 1, 5)).toBe(5);
  });

  it("parses data urls into blobs", async () => {
    const blob = dataUrlToBlob("data:text/plain;base64,SGVsbG8=");
    expect(blob).not.toBeNull();
    expect(blob?.type).toBe("text/plain");
    expect(await blob?.text()).toBe("Hello");
  });
});
