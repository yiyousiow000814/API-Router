import { describe, expect, it } from "vitest";

import {
  isTerminalInterruptedHistory,
  latestTurnContainsPendingUserEcho,
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

  it("treats failed history status as terminal too", () => {
    const thread = {
      id: "thread-1",
      status: { type: "failed" },
      page: { incomplete: true },
      turns: [],
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

  it("treats systemError history status as terminal too", () => {
    const thread = {
      id: "thread-1",
      status: { type: "systemError" },
      page: { incomplete: true },
      turns: [],
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

  it("does not suppress pending history runtime while reconnecting is active", () => {
    const thread = {
      id: "thread-1",
      status: { type: "active" },
      page: { incomplete: true },
      turns: [],
    };

    expect(
      shouldSuppressStalePendingHistoryLiveState(thread, {
        activeThreadId: "thread-1",
        activeThreadPendingTurnThreadId: "thread-1",
        activeThreadPendingTurnRunning: true,
        activeThreadPendingUserMessage: "hi",
        activeThreadConnectionStatusKind: "reconnecting",
      }, () => ({ text: "", images: [] }))
    ).toBe(false);
  });

  it("does not let a stale failed history status suppress a newly started second send on the same thread", () => {
    const thread = {
      id: "thread-1",
      status: { type: "failed" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hi" }] },
            { type: "userMessage", content: [{ type: "input_text", text: "hi" }] },
          ],
        },
      ],
    };

    expect(
      shouldSuppressStalePendingHistoryLiveState(thread, {
        activeThreadId: "thread-1",
        activeThreadPendingTurnThreadId: "thread-1",
        activeThreadPendingTurnRunning: true,
        activeThreadPendingUserMessage: "hi",
        activeThreadPendingTurnBaselineTurnCount: 0,
        activeThreadPendingTurnBaselineUserCount: 1,
      }, (item) => ({ text: String(item?.content?.[0]?.text || ""), images: [] }))
    ).toBe(false);
  });

  it("does not let a stale terminal connection error latch suppress an active reconnecting retry", () => {
    const thread = {
      id: "thread-1",
      status: { type: "active" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hi" }] },
          ],
        },
      ],
    };

    expect(
      shouldSuppressStalePendingHistoryLiveState(thread, {
        activeThreadId: "thread-1",
        activeThreadPendingTurnThreadId: "thread-1",
        activeThreadPendingTurnRunning: true,
        activeThreadPendingUserMessage: "hi",
        activeThreadConnectionStatusKind: "reconnecting",
        activeThreadTerminalConnectionErrorThreadId: "thread-1",
      }, () => ({ text: "", images: [] }))
    ).toBe(false);
  });

  it("does not suppress pending history runtime when incomplete history has no materialized turns yet", () => {
    const thread = {
      id: "thread-1",
      status: { type: "active" },
      page: { incomplete: true },
      turns: [],
    };

    expect(
      shouldSuppressStalePendingHistoryLiveState(thread, {
        activeThreadId: "thread-1",
        activeThreadPendingTurnThreadId: "thread-1",
        activeThreadPendingTurnRunning: true,
        activeThreadPendingUserMessage: "hi",
      }, () => ({ text: "", images: [] }))
    ).toBe(false);
  });

  it("does not treat an identical prompt from the baseline turn as the latest pending echo", () => {
    const thread = {
      id: "thread-1",
      status: { type: "active" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hi" }] },
          ],
        },
      ],
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingTurnBaselineTurnCount: 1,
    };
    const parseUserMessageParts = (item) => ({
      text: String(item?.content?.[0]?.text || ""),
      images: [],
    });

    expect(latestTurnContainsPendingUserEcho(thread, state, parseUserMessageParts)).toBe(false);
    expect(shouldSuppressStalePendingHistoryLiveState(thread, state, parseUserMessageParts)).toBe(true);
  });

  it("does not treat the baseline user count as a new pending echo when the turn baseline is stale", () => {
    const thread = {
      id: "thread-1",
      status: { type: "failed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hi" }] },
          ],
        },
      ],
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 1,
    };
    const parseUserMessageParts = (item) => ({
      text: String(item?.content?.[0]?.text || ""),
      images: [],
    });

    expect(latestTurnContainsPendingUserEcho(thread, state, parseUserMessageParts)).toBe(false);
  });

  it("does not mistake an older same-text turn for the current pending turn once a pending turn id exists", () => {
    const thread = {
      id: "thread-1",
      status: { type: "failed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hi" }] },
          ],
        },
      ],
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 1,
    };
    const parseUserMessageParts = (item) => ({
      text: String(item?.content?.[0]?.text || ""),
      images: [],
    });

    expect(latestTurnContainsPendingUserEcho(thread, state, parseUserMessageParts)).toBe(false);
  });
});
