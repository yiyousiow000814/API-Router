import { describe, expect, it } from "vitest";

import { buildTurnPayload } from "./turnActions.js";

describe("turnActions", () => {
  it("builds payload for new threads with cwd and model info", () => {
    expect(
      buildTurnPayload({
        activeThreadId: "",
        prompt: "hello",
        startCwd: "C:\\repo",
        shouldSendStartCwd: true,
        selectedModel: "gpt-5",
        selectedReasoningEffort: "medium",
      })
    ).toEqual({
      threadId: null,
      prompt: "hello",
      cwd: "C:\\repo",
      model: "gpt-5",
      reasoningEffort: "medium",
      collaborationMode: "default",
    });
  });

  it("omits cwd for existing threads", () => {
    expect(
      buildTurnPayload({
        activeThreadId: "thread-1",
        prompt: "hello",
        startCwd: "C:\\repo",
        shouldSendStartCwd: false,
        selectedModel: "",
        selectedReasoningEffort: "",
      })
    ).toEqual({
      threadId: "thread-1",
      prompt: "hello",
      cwd: undefined,
      model: undefined,
      reasoningEffort: undefined,
      collaborationMode: "default",
    });
  });
});
