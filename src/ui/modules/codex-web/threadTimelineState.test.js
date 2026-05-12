import { describe, expect, it } from "vitest";

import {
  applyTimelineSnapshot,
  createThreadTimelineState,
  mergeThreadTimelineMeta,
  reduceTimelineEvent,
} from "./threadTimelineState.js";

describe("threadTimelineState", () => {
  it("replaces an optimistic user message with the matching server echo", () => {
    let state = createThreadTimelineState("thread-1");

    state = reduceTimelineEvent(state, {
      type: "optimistic-user",
      threadId: "thread-1",
      clientMessageId: "client:user:1",
      text: "Explain the screenshots",
    });
    state = reduceTimelineEvent(state, {
      type: "message-upsert",
      threadId: "thread-1",
      message: {
        id: "server:user:1",
        role: "user",
        text: "Explain the screenshots",
      },
      correlation: {
        clientMessageId: "client:user:1",
      },
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: "server:user:1",
        role: "user",
        text: "Explain the screenshots",
        optimistic: false,
      }),
    ]);
  });

  it("deduplicates live and history final answers with the same turn identity", () => {
    let state = createThreadTimelineState("thread-1");

    state = reduceTimelineEvent(state, {
      type: "assistant-final",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      text: "Final answer",
      source: "live",
    });
    state = reduceTimelineEvent(state, {
      type: "assistant-final",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      text: "Final answer",
      source: "history",
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(
      expect.objectContaining({
        id: "assistant:turn-1:message-1",
        role: "assistant",
        text: "Final answer",
      })
    );
    expect(state.messages[0].sources).toEqual(["live", "history"]);
  });

  it("preserves a running optimistic user when a history snapshot lacks the user echo", () => {
    let state = createThreadTimelineState("thread-1");

    state = reduceTimelineEvent(state, {
      type: "optimistic-user",
      threadId: "thread-1",
      clientMessageId: "client:user:1",
      text: "Why did this duplicate?",
    });
    state = applyTimelineSnapshot(state, {
      threadId: "thread-1",
      running: true,
      messages: [
        {
          id: "assistant:turn-1:message-1",
          role: "assistant",
          text: "It duplicated because two sources appended the same final answer.",
        },
      ],
    });

    expect(state.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Why did this duplicate?"],
      ["assistant", "It duplicated because two sources appended the same final answer."],
    ]);
  });

  it("prevents provisional live metadata from overwriting a stable title", () => {
    const merged = mergeThreadTimelineMeta(
      {
        id: "thread-1",
        title: "Explain the screenshots",
        preview: "Explain the screenshots",
        provisional: false,
        source: "thread-list",
      },
      {
        id: "thread-1",
        title: "Assistant delta text",
        preview: "Assistant delta text",
        previewSource: "assistant",
        provisional: true,
        source: "live-provisional",
      }
    );

    expect(merged.title).toBe("Explain the screenshots");
    expect(merged.preview).toBe("Explain the screenshots");
  });

  it("allows a user-message provisional preview to seed a brand-new thread", () => {
    const merged = mergeThreadTimelineMeta(
      null,
      {
        id: "thread-1",
        title: "Explain the screenshots",
        preview: "Explain the screenshots",
        previewSource: "user",
        provisional: true,
        source: "live-provisional",
      }
    );

    expect(merged.title).toBe("Explain the screenshots");
    expect(merged.preview).toBe("Explain the screenshots");
    expect(merged.provisional).toBe(true);
  });
});
