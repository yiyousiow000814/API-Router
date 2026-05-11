import { describe, expect, it } from "vitest";

import { mapThreadReadMessages } from "./historyMessageMapping.js";

describe("historyMessageMapping", () => {
  it("keeps commentary archive before the final assistant when a turn reports final answer twice", async () => {
    const messages = await mapThreadReadMessages(
      {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            items: [
              { type: "userMessage", content: [{ type: "input_text", text: "hi" }] },
              { type: "assistantMessage", id: "assistant-1", phase: "final_answer", text: "done" },
              { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
              { type: "commandExecution", command: "npm test", status: "completed" },
              { type: "assistantMessage", id: "assistant-1", phase: "final_answer", text: "done" },
            ],
          },
        ],
      },
      {
        nextFrame: async () => {},
        performanceRef: { now: (() => { let n = 0; return () => (n += 1); })() },
        parseUserMessageParts(item) {
          return {
            text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
            images: [],
          };
        },
        isBootstrapAgentsPrompt() {
          return false;
        },
        normalizeThreadItemText(item) {
          if (String(item?.type || "").trim() === "commandExecution") {
            return `Ran \`${String(item?.command || "")}\``;
          }
          return String(item?.text || "");
        },
        pushHistoryMessage(messagesRef, message) {
          messagesRef.push(message);
        },
        isVisibleAssistantHistoryPhase(phase) {
          const value = String(phase || "").trim().toLowerCase();
          return !value || value === "final_answer";
        },
        includeCanonicalIds: true,
      }
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "hi",
        id: "user:thread-1:turn-1:message",
      }),
      expect.objectContaining({
        role: "system",
        kind: "commentaryArchive",
        archiveKey: "turn-1",
        archiveBlocks: [
          expect.objectContaining({
            key: "commentary-1",
            text: "thinking one",
            tools: ["Ran `npm test`"],
          }),
        ],
      }),
      expect.objectContaining({
        role: "assistant",
        text: "done",
        id: "assistant:turn-1:assistant-1",
      }),
    ]);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });
});
