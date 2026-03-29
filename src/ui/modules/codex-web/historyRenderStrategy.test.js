import { describe, expect, it } from "vitest";

import { decideHistoryRenderStrategy } from "./historyRenderStrategy.js";

describe("historyRenderStrategy", () => {
  it("uses full render when windowed mode is entering or message count shrinks", () => {
    expect(
      decideHistoryRenderStrategy({
        previousMessages: [{ role: "assistant", kind: "", text: "older" }],
        nextMessages: [{ role: "assistant", kind: "", text: "newer" }],
        windowed: true,
        alreadyWindowed: false,
      })
    ).toBe("window_full");

    expect(
      decideHistoryRenderStrategy({
        previousMessages: [
          { role: "user", kind: "", text: "1" },
          { role: "assistant", kind: "", text: "2" },
        ],
        nextMessages: [{ role: "user", kind: "", text: "1" }],
        windowed: true,
        alreadyWindowed: true,
      })
    ).toBe("window_full");
  });

  it("updates only the last windowed message when shape matches and text changed", () => {
    expect(
      decideHistoryRenderStrategy({
        previousMessages: [
          { role: "user", kind: "", text: "hello" },
          { role: "assistant", kind: "", text: "draft" },
        ],
        nextMessages: [
          { role: "user", kind: "", text: "hello" },
          { role: "assistant", kind: "", text: "final" },
        ],
        windowed: true,
        alreadyWindowed: true,
      })
    ).toBe("window_update_last");
  });

  it("keeps windowed render unchanged when the sequence is identical", () => {
    expect(
      decideHistoryRenderStrategy({
        previousMessages: [
          { role: "user", kind: "", text: "hello" },
          { role: "assistant", kind: "", text: "same" },
        ],
        nextMessages: [
          { role: "user", kind: "", text: "hello" },
          { role: "assistant", kind: "", text: "same" },
        ],
        windowed: true,
        alreadyWindowed: true,
      })
    ).toBe("window_unchanged");
  });

  it("appends in windowed mode when only new suffix messages arrive", () => {
    expect(
      decideHistoryRenderStrategy({
        previousMessages: [{ role: "user", kind: "", text: "hello" }],
        nextMessages: [
          { role: "user", kind: "", text: "hello" },
          { role: "assistant", kind: "", text: "world" },
        ],
        windowed: true,
        alreadyWindowed: true,
      })
    ).toBe("window_append");
  });

  it("updates only the last full-render message when stable prefix and shape remain", () => {
    expect(
      decideHistoryRenderStrategy({
        previousMessages: [
          { role: "user", kind: "", text: "hello" },
          { role: "assistant", kind: "", text: "draft" },
        ],
        nextMessages: [
          { role: "user", kind: "", text: "hello" },
          { role: "assistant", kind: "", text: "final" },
        ],
      })
    ).toBe("full_update_last");
  });

  it("appends in full-render mode when the old list is a strict prefix", () => {
    expect(
      decideHistoryRenderStrategy({
        previousMessages: [{ role: "user", kind: "", text: "hello" }],
        nextMessages: [
          { role: "user", kind: "", text: "hello" },
          { role: "assistant", kind: "", text: "world" },
        ],
      })
    ).toBe("full_append");
  });

  it("falls back to full rerender when history shape diverges", () => {
    expect(
      decideHistoryRenderStrategy({
        previousMessages: [
          { role: "user", kind: "", text: "hello" },
          { role: "assistant", kind: "", text: "world" },
        ],
        nextMessages: [
          { role: "assistant", kind: "", text: "world" },
          { role: "user", kind: "", text: "hello" },
        ],
      })
    ).toBe("full_rerender");
  });
});
