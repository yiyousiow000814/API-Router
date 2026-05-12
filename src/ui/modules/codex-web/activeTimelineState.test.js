import { describe, expect, it } from "vitest";

import {
  appendActiveTimelineMessage,
  ensureActiveTimelineMessages,
  removeActiveTimelineMessageAt,
  setActiveTimelineMessages,
  updateActiveTimelineMessageAt,
} from "./activeTimelineState.js";

describe("activeTimelineState", () => {
  it("deduplicates appends by canonical message identity", () => {
    const state = { activeThreadMessages: [] };

    appendActiveTimelineMessage(state, {
      id: "client:thread-1:req-1",
      clientMessageId: "client:thread-1:req-1",
      role: "user",
      text: "hello",
      kind: "",
    });
    appendActiveTimelineMessage(state, {
      id: "client:thread-1:req-1",
      clientMessageId: "client:thread-1:req-1",
      role: "user",
      text: "hello",
      kind: "",
      optimistic: true,
    });

    expect(state.activeThreadMessages).toEqual([
      expect.objectContaining({
        id: "client:thread-1:req-1",
        role: "user",
        text: "hello",
        optimistic: true,
      }),
    ]);
  });

  it("owns replace update and remove mutations", () => {
    const state = {};

    expect(ensureActiveTimelineMessages(state)).toEqual([]);
    setActiveTimelineMessages(state, [
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "", kind: "", id: "assistant:turn-1:message" },
    ]);
    updateActiveTimelineMessageAt(state, 1, (message) => ({
      ...message,
      text: "final",
    }));
    removeActiveTimelineMessageAt(state, 0);

    expect(state.activeThreadMessages).toEqual([
      { role: "assistant", text: "final", kind: "", id: "assistant:turn-1:message" },
    ]);
  });

  it("canonicalizes snapshots before replacing active messages", () => {
    const state = {};

    setActiveTimelineMessages(state, [
      { id: "user-1", role: "user", text: "hello", kind: "" },
      { id: "user-1", role: "user", text: "hello", kind: "", source: "history" },
      { role: "assistant", text: "final", kind: "" },
      { role: "assistant", text: "final", kind: "" },
    ]);

    expect(state.activeThreadMessages).toEqual([
      expect.objectContaining({ id: "user-1", role: "user", text: "hello", source: "history" }),
      { role: "assistant", text: "final", kind: "" },
    ]);
  });
});
