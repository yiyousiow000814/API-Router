import { describe, expect, it } from "vitest";

import { fetchAndApplyThreadHistory } from "./historyLoadFlow.js";

describe("historyLoadFlow", () => {
  it("records fetch/apply phases around a history load", async () => {
    const events = [];
    const windowRef = {};

    await fetchAndApplyThreadHistory("thread-1", { workspace: "windows" }, {
      state: {
        activeThreadHistoryReqSeq: 3,
        activeThreadWorkspace: "windows",
        activeThreadId: "thread-1",
        historyWindowSize: 120,
      },
      reqSeq: 3,
      api: async () => ({
        turns: [{ id: "turn-1" }],
        page: { hasMore: true },
      }),
      buildThreadHistoryUrl() {
        return "/codex/threads/thread-1/history?workspace=windows";
      },
      applyHistoryPageToState() {
        return {
          page: { hasMore: true },
          mergedTurns: [{ id: "turn-1" }],
          thread: { id: "thread-1" },
        };
      },
      applyThreadToChat: async () => {},
      pushLiveDebugEvent(kind, payload) {
        events.push({ kind, payload });
      },
      windowRef,
    });

    expect(events.map((event) => event.kind)).toEqual([
      "history.load:fetch:start",
      "history.load:fetch:end",
      "history.load:apply:start",
      "history.load:apply:end",
      "history.load:success",
    ]);
    expect(windowRef.__API_ROUTER_UI_ACTIVITY_STACK__ || []).toEqual([]);
    expect(events[3]?.payload).toMatchObject({
      threadId: "thread-1",
      workspace: "windows",
      turns: 1,
      hasMore: true,
    });
  });
});
