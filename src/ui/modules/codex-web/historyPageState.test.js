import { describe, expect, it } from "vitest";

import { applyHistoryPageToState } from "./historyPageState.js";

describe("historyPageState", () => {
  it("replaces or appends turns for the active history thread", () => {
    const state = {
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryIncomplete: false,
    };

    const result = applyHistoryPageToState(state, "thread-1", {
      page: { hasMore: false, incomplete: false, beforeCursor: "cursor-1", totalTurns: 2 },
      thread: {
        id: "thread-1",
        status: { type: "running" },
        turns: [{ id: "turn-2" }],
      },
    });

    expect(result.mergedTurns).toEqual([{ id: "turn-1" }, { id: "turn-2" }]);
    expect(state.activeThreadHistoryStatusType).toBe("running");
    expect(state.activeThreadHistoryBeforeCursor).toBe("cursor-1");
    expect(state.activeThreadHistoryTotalTurns).toBe(2);
  });

  it("prepends older turns when loading older history chunks", () => {
    const state = {
      activeThreadHistoryTurns: [{ id: "turn-2" }, { id: "turn-3" }],
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryIncomplete: false,
    };

    const result = applyHistoryPageToState(
      state,
      "thread-1",
      {
        page: { hasMore: true, incomplete: false, beforeCursor: "cursor-0", totalTurns: 3 },
        thread: {
          id: "thread-1",
          status: { type: "completed" },
          turns: [{ id: "turn-1" }],
        },
      },
      { mergeDirection: "prepend" }
    );

    expect(result.mergedTurns).toEqual([{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }]);
    expect(state.activeThreadHistoryHasMore).toBe(true);
    expect(state.activeThreadHistoryStatusType).toBe("completed");
  });

  it("treats terminal failed history as complete even when the page is still incomplete", () => {
    const state = {
      activeThreadHistoryTurns: [],
      activeThreadHistoryThreadId: "",
      activeThreadHistoryIncomplete: false,
    };

    applyHistoryPageToState(state, "thread-1", {
      page: { hasMore: false, incomplete: true, beforeCursor: "", totalTurns: 1 },
      thread: {
        id: "thread-1",
        status: { type: "failed" },
        turns: [{ id: "turn-1" }],
      },
    });

    expect(state.activeThreadHistoryIncomplete).toBe(false);
    expect(state.activeThreadHistoryStatusType).toBe("failed");
  });

  it("treats systemError history as complete even when the page is still incomplete", () => {
    const state = {
      activeThreadHistoryTurns: [],
      activeThreadHistoryThreadId: "",
      activeThreadHistoryIncomplete: false,
    };

    applyHistoryPageToState(state, "thread-1", {
      page: { hasMore: false, incomplete: true, beforeCursor: "", totalTurns: 1 },
      thread: {
        id: "thread-1",
        status: { type: "systemError" },
        turns: [{ id: "turn-1" }],
      },
    });

    expect(state.activeThreadHistoryIncomplete).toBe(false);
    expect(state.activeThreadHistoryStatusType).toBe("systemerror");
  });

  it("deduplicates duplicate incoming turns before storing authoritative history state", () => {
    const state = {
      activeThreadHistoryTurns: [],
      activeThreadHistoryThreadId: "",
      activeThreadHistoryIncomplete: false,
    };
    const duplicateTurn = { id: "turn-1", items: [{ type: "userMessage" }] };

    const result = applyHistoryPageToState(state, "thread-1", {
      page: { hasMore: false, incomplete: false, beforeCursor: "", totalTurns: 1 },
      thread: {
        id: "thread-1",
        status: { type: "completed" },
        turns: [duplicateTurn, duplicateTurn],
      },
    });

    expect(result.mergedTurns).toEqual([duplicateTurn]);
    expect(state.activeThreadHistoryTurns).toEqual([duplicateTurn]);
  });
});
