import { describe, expect, it } from "vitest";

import {
  buildThreadHistoryUrl,
  mergeHistoryTurns,
  normalizeSessionAssistantText,
  shouldUseHistoryWindow,
} from "./historyLoader.js";

describe("historyLoader", () => {
  it("builds history urls with workspace and cursor params", () => {
    expect(
      buildThreadHistoryUrl("thread 1", {
        workspace: "wsl2",
        before: "cursor-1",
        limit: 80,
      })
    ).toBe("/codex/threads/thread%201/history?workspace=wsl2&before=cursor-1&limit=80");
  });

  it("merges history turns without duplicates", () => {
    expect(
      mergeHistoryTurns(
        [{ id: "turn-1", value: 1 }, { id: "turn-2", value: 2 }],
        [{ id: "turn-2", value: 99 }, { id: "turn-3", value: 3 }]
      )
    ).toEqual([
      { id: "turn-1", value: 1 },
      { id: "turn-2", value: 2 },
      { id: "turn-3", value: 3 },
    ]);
  });

  it("normalizes assistant text blocks from session history", () => {
    expect(
      normalizeSessionAssistantText(
        [
          { type: "output_text", text: " first " },
          { type: "image", text: "skip" },
          { type: "input_text", text: "second" },
        ],
        {
          normalizeType: (value) => String(value || "").replace(/[^a-z]/gi, "").toLowerCase(),
          stripCodexImageBlocks: (value) => value,
        }
      )
    ).toBe("first\nsecond");
  });

  it("enables history windowing only when threshold or flags require it", () => {
    expect(shouldUseHistoryWindow(new Array(10).fill({}), {}, { HISTORY_WINDOW_THRESHOLD: 20 })).toBe(false);
    expect(shouldUseHistoryWindow(new Array(20).fill({}), {}, { HISTORY_WINDOW_THRESHOLD: 20 })).toBe(true);
    expect(shouldUseHistoryWindow([], { forceHistoryWindow: true }, { HISTORY_WINDOW_THRESHOLD: 20 })).toBe(true);
    expect(shouldUseHistoryWindow([], {}, { HISTORY_WINDOW_THRESHOLD: 20, activeThreadHistoryHasMore: true })).toBe(true);
  });
});
