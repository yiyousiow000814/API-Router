import { describe, expect, it } from "vitest";

import {
  bumpLiveTurnEpoch,
  clearActiveAssistantLiveState,
  clearPendingUserFallback,
  clearPendingTurnRuntimePlaceholder,
  finishPendingTurnRun,
  primePendingTurnRuntime,
  resetPendingTurnRuntime,
  resetTurnPresentationState,
  rememberFinalAssistant,
  restorePendingUserFallback,
  resolveCurrentThreadId,
  setPendingTurnRunning,
  syncPendingTurnRuntime,
  syncPendingAssistantState,
} from "./runtimeState.js";

describe("runtimeState", () => {
  it("resolves the current thread id from the best available state", () => {
    expect(
      resolveCurrentThreadId({
        activeThreadPendingTurnThreadId: "",
        activeThreadId: "",
        activeThreadOpenState: { threadId: "thread-open" },
        activeThreadActivity: { threadId: "thread-activity" },
        activeThreadCommentaryCurrent: { threadId: "thread-commentary" },
      })
    ).toBe("thread-open");

    expect(
      resolveCurrentThreadId({
        activeThreadPendingTurnThreadId: "thread-pending",
        activeThreadId: "thread-active",
        activeThreadOpenState: { threadId: "thread-open" },
        activeThreadActivity: { threadId: "thread-activity" },
      })
    ).toBe("thread-pending");
  });

  it("primes pending turn state from the active thread history baseline", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "a" }, { id: "b" }],
      activeThreadHistoryUserCount: 2,
      activeThreadMessages: [
        { role: "user", text: "before-1" },
        { role: "assistant", text: "reply-1" },
        { role: "user", text: "before-2" },
      ],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "stale",
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 0,
    };
    expect(primePendingTurnRuntime(state, "thread-1", "hello")).toBe(true);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("hello");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(2);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(2);
  });

  it("prefers the authoritative history user count over stale rendered messages", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryUserCount: 1,
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 0,
    };

    expect(primePendingTurnRuntime(state, "thread-1", "retry")).toBe(true);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(1);
  });

  it("finishes and clears pending placeholder state only for the matching thread", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 3,
      activeThreadPendingTurnBaselineUserCount: 2,
    };
    expect(finishPendingTurnRun(state, "thread-1")).toBe(true);
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(clearPendingTurnRuntimePlaceholder(state, "thread-1", { force: true })).toBe(true);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingUserMessage).toBe("");
  });

  it("can finish a pending turn without dropping its history baseline counts", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 3,
      activeThreadPendingTurnBaselineUserCount: 2,
    };

    expect(
      finishPendingTurnRun(state, "thread-1", {
        preserveBaselineTurnCount: true,
        preserveBaselineUserCount: true,
      })
    ).toBe(true);
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(3);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(2);
  });

  it("can finish a pending turn while preserving its turn id for terminal fallback ownership", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 3,
      activeThreadPendingTurnBaselineUserCount: 2,
    };

    expect(
      finishPendingTurnRun(state, "thread-1", {
        preserveTurnId: true,
        preserveBaselineTurnCount: true,
        preserveBaselineUserCount: true,
      })
    ).toBe(true);
    expect(state.activeThreadPendingTurnId).toBe("turn-2");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(3);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(2);
  });

  it("syncs pending assistant and remembers the final assistant snapshot", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveStateEpoch: 7,
      activeThreadLastFinalAssistantThreadId: "",
      activeThreadLastFinalAssistantText: "",
      activeThreadLastFinalAssistantAt: 0,
      activeThreadLastFinalAssistantEpoch: 0,
    };
    expect(syncPendingAssistantState(state, "thread-1", "done")).toBe(true);
    expect(state.activeThreadPendingAssistantMessage).toBe("done");
    rememberFinalAssistant(state, "thread-1", "done");
    expect(state.activeThreadLastFinalAssistantThreadId).toBe("thread-1");
    expect(state.activeThreadLastFinalAssistantText).toBe("done");
    expect(state.activeThreadLastFinalAssistantEpoch).toBe(7);
  });

  it("clears live assistant DOM/runtime pointers", () => {
    const state = {
      activeThreadLiveAssistantThreadId: "thread-1",
      activeThreadLiveAssistantIndex: 1,
      activeThreadLiveAssistantMsgNode: {},
      activeThreadLiveAssistantBodyNode: {},
      activeThreadLiveAssistantText: "hi",
    };
    clearActiveAssistantLiveState(state);
    expect(state.activeThreadLiveAssistantThreadId).toBe("");
    expect(state.activeThreadLiveAssistantIndex).toBe(-1);
    expect(state.activeThreadLiveAssistantMsgNode).toBeNull();
    expect(state.activeThreadLiveAssistantText).toBe("");
  });

  it("updates pending running state and user fallback for the matching thread", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "hello",
    };
    expect(setPendingTurnRunning(state, "thread-1", true, { turnId: "turn-1" })).toBe(true);
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingTurnId).toBe("turn-1");
    expect(clearPendingUserFallback(state, "thread-1")).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(restorePendingUserFallback(state, "thread-1", "hello")).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("hello");
  });

  it("syncs and fully resets pending turn runtime including turn ids", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 0,
    };

    expect(
      syncPendingTurnRuntime(state, "thread-1", {
        turnId: "turn-9",
        running: true,
        userMessage: "hello",
        assistantMessage: "working",
        baselineTurnCount: 4,
        baselineUserCount: 3,
      })
    ).toBe(true);
    expect(state.activeThreadPendingTurnId).toBe("turn-9");
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(4);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(3);

    expect(resetPendingTurnRuntime(state)).toBe(true);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(0);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(0);
  });

  it("bumps live turn epochs and clears final assistant dedupe state", () => {
    const state = {
      activeThreadLiveStateEpoch: 2,
      activeThreadLastFinalAssistantThreadId: "thread-1",
      activeThreadLastFinalAssistantText: "done",
      activeThreadLastFinalAssistantAt: 123,
      activeThreadLastFinalAssistantEpoch: 2,
    };

    bumpLiveTurnEpoch(state);

    expect(state.activeThreadLiveStateEpoch).toBe(3);
    expect(state.activeThreadLastFinalAssistantThreadId).toBe("");
    expect(state.activeThreadLastFinalAssistantText).toBe("");
    expect(state.activeThreadLastFinalAssistantAt).toBe(0);
    expect(state.activeThreadLastFinalAssistantEpoch).toBe(0);
  });

  it("resets commentary, runtime activity, and live assistant pointers together", () => {
    const state = {
      activeThreadLiveStateEpoch: 4,
      activeThreadLiveRuntimeEpoch: 9,
      activeThreadTransientToolText: "tool",
      activeThreadTransientThinkingText: "thinking",
      activeThreadCommentaryPendingPlan: { title: "plan" },
      activeThreadCommentaryPendingTools: ["Read file"],
      activeThreadCommentaryPendingToolKeys: ["tool-1"],
      activeThreadCommentaryCurrent: { key: "commentary-1" },
      activeThreadCommentaryArchive: [{ key: "commentary-0" }],
      activeThreadCommentaryArchiveVisible: true,
      activeThreadCommentaryArchiveExpanded: true,
      activeThreadInlineCommentaryArchiveCount: 3,
      activeThreadActivity: { title: "Working" },
      activeThreadActiveCommands: [{ key: "cmd-1" }],
      activeThreadPlan: { title: "Updated Plan" },
      activeThreadLiveAssistantThreadId: "thread-1",
      activeThreadLiveAssistantIndex: 1,
      activeThreadLiveAssistantMsgNode: {},
      activeThreadLiveAssistantBodyNode: {},
      activeThreadLiveAssistantText: "hello",
      activeThreadLastFinalAssistantThreadId: "thread-1",
      activeThreadLastFinalAssistantText: "done",
      activeThreadLastFinalAssistantAt: 9,
      activeThreadLastFinalAssistantEpoch: 4,
    };

    resetTurnPresentationState(state, { bumpLiveEpoch: true, resetLiveRuntimeEpoch: true });

    expect(state.activeThreadLiveStateEpoch).toBe(5);
    expect(state.activeThreadLiveRuntimeEpoch).toBe(0);
    expect(state.activeThreadTransientToolText).toBe("");
    expect(state.activeThreadTransientThinkingText).toBe("");
    expect(state.activeThreadCommentaryPendingPlan).toBeNull();
    expect(state.activeThreadCommentaryPendingTools).toEqual([]);
    expect(state.activeThreadCommentaryPendingToolKeys).toEqual([]);
    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchive).toEqual([]);
    expect(state.activeThreadCommentaryArchiveVisible).toBe(false);
    expect(state.activeThreadCommentaryArchiveExpanded).toBe(false);
    expect(state.activeThreadInlineCommentaryArchiveCount).toBe(0);
    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(state.activeThreadPlan).toBeNull();
    expect(state.activeThreadLiveAssistantThreadId).toBe("");
    expect(state.activeThreadLiveAssistantIndex).toBe(-1);
    expect(state.activeThreadLiveAssistantMsgNode).toBeNull();
    expect(state.activeThreadLiveAssistantBodyNode).toBeNull();
    expect(state.activeThreadLiveAssistantText).toBe("");
  });
});
