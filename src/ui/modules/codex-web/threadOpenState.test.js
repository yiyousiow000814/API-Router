import { describe, expect, it } from "vitest";

import {
  getThreadOpenState,
  resolveThreadOpenState,
  setThreadOpenState,
} from "./threadOpenState.js";

describe("threadOpenState", () => {
  it("keeps loaded threads canonical and not resumable", () => {
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        threadStatusType: "notLoaded",
        loaded: true,
      })
    ).toMatchObject({
      threadId: "thread-1",
      loaded: true,
      resumeRequired: false,
      resumeReason: "loaded",
    });
  });

  it("normalizes loaded runtime state through the setter", () => {
    const state = {};
    const next = setThreadOpenState(state, {
      threadId: "thread-1",
      threadStatusType: "notLoaded",
      resumeRequired: true,
      resumeReason: "thread-not-loaded",
      loaded: false,
    }, {
      loaded: true,
    });

    expect(next).toMatchObject({
      threadId: "thread-1",
      loaded: true,
      resumeRequired: false,
      resumeReason: "loaded",
    });
    expect(getThreadOpenState(state)).toMatchObject({
      threadId: "thread-1",
      loaded: true,
      resumeRequired: false,
      resumeReason: "loaded",
    });
  });

  it("does not require resuming a failed history thread even when the page is incomplete", () => {
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        historyThreadId: "thread-1",
        historyIncomplete: true,
        historyStatusType: "failed",
        loaded: false,
      })
    ).toMatchObject({
      threadId: "thread-1",
      loaded: false,
      resumeRequired: false,
      resumeReason: "history-complete",
    });
  });

  it("creates an idle open state by default", () => {
    expect(resolveThreadOpenState()).toMatchObject({
      threadId: "",
      loaded: false,
      resumeRequired: false,
      resumeReason: "missing-thread",
    });
  });
});
