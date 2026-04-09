import { describe, expect, it } from "vitest";

import {
  isTerminalInterruptedHistory,
  shouldSuppressStalePendingHistoryLiveState,
} from "./historyLiveCommentaryState.js";

describe("historyLiveCommentaryState", () => {
  it("treats interrupted history status as stale pending state even after refresh", () => {
    const thread = {
      id: "thread-1",
      status: { type: "interrupted" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "agentMessage", phase: "commentary", text: "thinking" },
            { type: "toolCall", tool: "request_user_input", status: "running" },
          ],
        },
      ],
    };

    expect(isTerminalInterruptedHistory(thread, {})).toBe(true);
    expect(
      shouldSuppressStalePendingHistoryLiveState(thread, {
        activeThreadId: "thread-1",
        activeThreadPendingTurnThreadId: "",
        activeThreadPendingTurnRunning: false,
        activeThreadPendingUserMessage: "",
      }, () => ({ text: "", images: [] }))
    ).toBe(true);
  });

  it("also uses persisted history status from state when thread status is absent", () => {
    const thread = {
      id: "thread-1",
      page: { incomplete: true },
      turns: [],
    };

    expect(isTerminalInterruptedHistory(thread, {
      activeThreadHistoryStatusType: "cancelled",
    })).toBe(true);
  });

  it("suppresses stale incomplete history when a local interrupt marker is active", () => {
    const thread = {
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "agentMessage", phase: "commentary", text: "thinking" },
          ],
        },
      ],
    };

    expect(
      shouldSuppressStalePendingHistoryLiveState(thread, {
        activeThreadId: "thread-1",
        suppressedIncompleteHistoryRuntimeByThreadId: { "thread-1": true },
      }, () => ({ text: "", images: [] }))
    ).toBe(true);
  });
});
