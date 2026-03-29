import { describe, expect, it } from "vitest";

import { prepareThreadHistoryView } from "./historyPreparation.js";

describe("historyPreparation", () => {
  it("prepares canonical render inputs from thread history", async () => {
    const prepared = await prepareThreadHistoryView(
      {
        id: "thread-1",
        path: "/tmp/rollout.jsonl",
        status: { type: "running" },
        page: { incomplete: true },
        turns: [{ id: "turn-1" }],
      },
      { workspace: "windows" },
      {
        state: {
          activeThreadId: "thread-1",
          activeThreadPendingTurnThreadId: "",
          activeThreadPendingUserMessage: "",
          activeThreadPendingAssistantMessage: "",
        },
        async mapSessionHistoryMessages() {
          return [];
        },
        async mapThreadReadMessages() {
          return [
            { role: "user", text: "hello", kind: "" },
            { role: "system", text: "tool", kind: "tool" },
            { role: "assistant", text: "done", kind: "" },
          ];
        },
        normalizeThreadItemText() {
          return "";
        },
        captureLiveCommentarySnapshot(threadId) {
          return { threadId, epoch: 1 };
        },
        normalizeThreadTokenUsage(value) {
          return value ?? { total: 0 };
        },
        detectThreadWorkspaceTarget() {
          return "unknown";
        },
      }
    );

    expect(prepared.threadId).toBe("thread-1");
    expect(prepared.messages).toHaveLength(3);
    expect(prepared.toolCount).toBe(1);
    expect(prepared.started).toBe(true);
    expect(prepared.historyStatusType).toBe("running");
    expect(prepared.target).toBe("windows");
    expect(prepared.resolvedRolloutPath).toBe("/tmp/rollout.jsonl");
    expect(prepared.liveCommentarySnapshot).toEqual({ threadId: "thread-1", epoch: 1 });
    expect(typeof prepared.renderSig).toBe("string");
  });

  it("drops trailing artifacts from the latest incomplete turn after a local interrupt", async () => {
    const prepared = await prepareThreadHistoryView(
      {
        id: "thread-1",
        page: { incomplete: true },
        turns: [{ id: "turn-1" }],
      },
      { workspace: "windows" },
      {
        state: {
          activeThreadId: "thread-1",
          suppressedIncompleteHistoryRuntimeByThreadId: { "thread-1": true },
        },
        async mapSessionHistoryMessages() {
          return [];
        },
        async mapThreadReadMessages() {
          return [
            { role: "user", text: "我们继续上次未完成的 plan", kind: "", images: [] },
            { role: "assistant", text: "这是未完成 turn 里残留的 assistant 片段", kind: "" },
            { role: "system", text: "Updated Plan", kind: "planCard" },
          ];
        },
        normalizeThreadItemText() {
          return "";
        },
        captureLiveCommentarySnapshot(threadId) {
          return { threadId, epoch: 2 };
        },
        normalizeThreadTokenUsage(value) {
          return value ?? { total: 0 };
        },
        detectThreadWorkspaceTarget() {
          return "windows";
        },
      }
    );

    expect(prepared.rawMessages).toEqual([
      { role: "user", text: "我们继续上次未完成的 plan", kind: "", images: [] },
    ]);
    expect(prepared.messages).toEqual([
      { role: "user", text: "我们继续上次未完成的 plan", kind: "", images: [] },
    ]);
  });
});
