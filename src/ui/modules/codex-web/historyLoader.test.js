import { describe, expect, it } from "vitest";

import {
  buildThreadHistoryUrl,
  mergePendingLiveMessages,
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

  it("includes rolloutPath in history urls when provided", () => {
    expect(
      buildThreadHistoryUrl("thread-1", {
        workspace: "windows",
        rolloutPath: "C:\\Users\\yiyou\\.codex\\sessions\\rollout.jsonl",
        limit: 60,
      })
    ).toBe(
      "/codex/threads/thread-1/history?workspace=windows&rolloutPath=C%3A%5CUsers%5Cyiyou%5C.codex%5Csessions%5Crollout.jsonl&limit=60"
    );
  });

  it("merges history turns without duplicates", () => {
    expect(
      mergeHistoryTurns(
        [{ id: "turn-1", value: 1 }, { id: "turn-2", value: 2 }],
        [{ id: "turn-2", value: 99 }, { id: "turn-3", value: 3 }]
      )
    ).toEqual([
      { id: "turn-1", value: 1 },
      { id: "turn-2", value: 99 },
      { id: "turn-3", value: 3 },
    ]);
  });

  it("replaces an existing turn when polled history has the same turn id with newer content", () => {
    expect(
      mergeHistoryTurns(
        [
          { id: "turn-1", items: [{ type: "userMessage", text: "hi" }] },
          { id: "turn-2", items: [{ type: "userMessage", text: "follow up" }] },
        ],
        [
          {
            id: "turn-2",
            items: [
              { type: "userMessage", text: "follow up" },
              { type: "assistantMessage", text: "new reply" },
            ],
          },
        ]
      )
    ).toEqual([
      { id: "turn-1", items: [{ type: "userMessage", text: "hi" }] },
      {
        id: "turn-2",
        items: [
          { type: "userMessage", text: "follow up" },
          { type: "assistantMessage", text: "new reply" },
        ],
      },
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

  it("keeps locally pending turn messages when history is stale", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "world",
    };
    expect(
      mergePendingLiveMessages([{ role: "user", text: "older", kind: "" }], state, "thread-1")
    ).toEqual([
      { role: "user", text: "older", kind: "" },
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "world", kind: "" },
    ]);
  });

  it("clears pending turn state once history catches up", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "world",
    };
    expect(
      mergePendingLiveMessages(
        [
          { role: "user", text: "older", kind: "" },
          { role: "user", text: "hello", kind: "" },
          { role: "assistant", text: "world", kind: "" },
        ],
        state,
        "thread-1"
      )
    ).toEqual([
      { role: "user", text: "older", kind: "" },
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "world", kind: "" },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
  });

  it("keeps pending turn ownership after history catches up to the user message only", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
    };

    expect(
      mergePendingLiveMessages([{ role: "user", text: "hello", kind: "" }], state, "thread-1")
    ).toEqual([{ role: "user", text: "hello", kind: "" }]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");

    state.activeThreadPendingAssistantMessage = "world";
    expect(
      mergePendingLiveMessages([{ role: "user", text: "hello", kind: "" }], state, "thread-1")
    ).toEqual([
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "world", kind: "" },
    ]);
  });
});
