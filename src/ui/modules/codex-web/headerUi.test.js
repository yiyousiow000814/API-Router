import { describe, expect, it } from "vitest";

import { compactModelLabel, parseModelRankParts, pickLatestModelId } from "./headerUi.js";

describe("headerUi", () => {
  it("compacts gpt prefixes", () => {
    expect(compactModelLabel("gpt-5.3-codex")).toBe("5.3-codex");
    expect(compactModelLabel("claude")).toBe("claude");
  });

  it("prefers latest codex model id", () => {
    expect(
      pickLatestModelId([
        { id: "gpt-5.2-codex" },
        { id: "gpt-5.3-codex" },
        { id: "gpt-5.3-2026-01-01" },
      ])
    ).toBe("gpt-5.3-codex");
  });

  it("parses dated model ranks", () => {
    expect(parseModelRankParts("gpt-5.2-2025-12-11")).toMatchObject({
      major: 5,
      minor: 2,
      date: 20251211,
    });
  });
});
