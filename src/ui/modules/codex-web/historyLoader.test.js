import { describe, expect, it } from "vitest";

import {
  buildHistoryRenderSig,
  buildThreadHistoryUrl,
  createHistoryLoaderModule,
  extractLatestCommentaryArchive,
  extractLatestCommentaryState,
  findLatestIncompleteToolMessage,
  mergePendingLiveMessages,
  mergeHistoryTurns,
  normalizeSessionAssistantText,
  shouldUseHistoryWindow,
} from "./historyLoader.js";
import { normalizeThreadItemText as normalizeThreadItemTextImpl } from "./messageData.js";

describe("historyLoader", () => {
  it("builds history urls with workspace and cursor params", () => {
    expect(
      buildThreadHistoryUrl("thread 1", {
        workspace: "wsl2",
        before: "cursor-1",
        limit: 80,
      })
    ).toBe("/codex/threads/thread%201/history?workspace=wsl2&before=cursor-1&limit=80");
  });

  it("includes rolloutPath in history urls when provided", () => {
    expect(
      buildThreadHistoryUrl("thread-1", {
        workspace: "windows",
        rolloutPath: "C:\\Users\\yiyou\\.codex\\sessions\\rollout.jsonl",
        limit: 60,
      })
    ).toBe(
      "/codex/threads/thread-1/history?workspace=windows&rolloutPath=C%3A%5CUsers%5Cyiyou%5C.codex%5Csessions%5Crollout.jsonl&limit=60"
    );
  });

  it("merges history turns without duplicates", () => {
    expect(
      mergeHistoryTurns(
        [{ id: "turn-1", value: 1 }, { id: "turn-2", value: 2 }],
        [{ id: "turn-2", value: 99 }, { id: "turn-3", value: 3 }]
      )
    ).toEqual([
      { id: "turn-1", value: 1 },
      { id: "turn-2", value: 99 },
      { id: "turn-3", value: 3 },
    ]);
  });

  it("replaces an existing turn when polled history has the same turn id with newer content", () => {
    expect(
      mergeHistoryTurns(
        [
          { id: "turn-1", items: [{ type: "userMessage", text: "hi" }] },
          { id: "turn-2", items: [{ type: "userMessage", text: "follow up" }] },
        ],
        [
          {
            id: "turn-2",
            items: [
              { type: "userMessage", text: "follow up" },
              { type: "assistantMessage", text: "new reply" },
            ],
          },
        ]
      )
    ).toEqual([
      { id: "turn-1", items: [{ type: "userMessage", text: "hi" }] },
      {
        id: "turn-2",
        items: [
          { type: "userMessage", text: "follow up" },
          { type: "assistantMessage", text: "new reply" },
        ],
      },
    ]);
  });

  it("normalizes assistant text blocks from session history", () => {
    expect(
      normalizeSessionAssistantText(
        [
          { type: "output_text", text: " first " },
          { type: "image", text: "skip" },
          { type: "input_text", text: "second" },
        ],
        {
          normalizeType: (value) => String(value || "").replace(/[^a-z]/gi, "").toLowerCase(),
          stripCodexImageBlocks: (value) => value,
        }
      )
    ).toBe("first\nsecond");
  });

  it("omits commentary-phase assistant messages from session history", async () => {
    const module = createHistoryLoaderModule({
      state: { liveDebugEvents: [] },
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: {},
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 20,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "unknown"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
    });

    const messages = await module.mapSessionHistoryMessages([
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "working notes" }],
      },
      {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "done" }],
      },
    ]);

    expect(messages).toEqual([{ role: "assistant", text: "done", kind: "" }]);
  });

  it("extracts the latest turn commentary archive from raw turn items", () => {
    const archive = extractLatestCommentaryArchive(
      {
        turns: [
          {
            id: "turn-1",
            items: [
              { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
              { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
              { type: "commandExecution", command: "npm test", status: "running" },
              { type: "assistantMessage", phase: "final_answer", text: "done" },
            ],
          },
        ],
      },
      { normalizeThreadItemText: normalizeThreadItemTextImpl }
    );

    expect(archive).toEqual([
      expect.objectContaining({
        key: "commentary-1",
        text: "thinking one",
        tools: ["Running `npm test`"],
      }),
    ]);
  });

  it("extracts the current commentary block from an incomplete latest turn", () => {
    const commentary = extractLatestCommentaryState(
      {
        turns: [
          {
            id: "turn-1",
            items: [
              { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
              { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
              { type: "commandExecution", command: "npm test", status: "completed" },
              { type: "agentMessage", id: "commentary-2", phase: "commentary", text: "thinking two" },
              { type: "commandExecution", command: "npm run build", status: "running" },
            ],
          },
        ],
      },
      { normalizeThreadItemText: normalizeThreadItemTextImpl }
    );

    expect(commentary).toEqual({
      current: expect.objectContaining({
        key: "commentary-2",
        text: "thinking two",
        tools: ["Running `npm run build`"],
      }),
      archive: [],
      visible: false,
    });
  });

  it("enables history windowing only when threshold or flags require it", () => {
    expect(shouldUseHistoryWindow(new Array(10).fill({}), {}, { HISTORY_WINDOW_THRESHOLD: 20 })).toBe(false);
    expect(shouldUseHistoryWindow(new Array(20).fill({}), {}, { HISTORY_WINDOW_THRESHOLD: 20 })).toBe(true);
    expect(shouldUseHistoryWindow([], { forceHistoryWindow: true }, { HISTORY_WINDOW_THRESHOLD: 20 })).toBe(true);
    expect(shouldUseHistoryWindow([], {}, { HISTORY_WINDOW_THRESHOLD: 20, activeThreadHistoryHasMore: true })).toBe(true);
  });

  it("changes render signature when a middle message changes under the same last assistant message", () => {
    const threadId = "thread-1";
    const turns = [{ id: "turn-1" }];
    const first = [
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "draft one", kind: "" },
      { role: "assistant", text: "done", kind: "" },
    ];
    const second = [
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "draft two", kind: "" },
      { role: "assistant", text: "done", kind: "" },
    ];

    expect(buildHistoryRenderSig(threadId, turns, first)).not.toBe(
      buildHistoryRenderSig(threadId, turns, second)
    );
  });

  it("keeps locally pending turn messages when history is stale", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "world",
    };
    expect(
      mergePendingLiveMessages([{ role: "user", text: "older", kind: "" }], state, "thread-1")
    ).toEqual([
      { role: "user", text: "older", kind: "" },
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "world", kind: "" },
    ]);
  });

  it("clears pending turn state once history catches up", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "world",
    };
    expect(
      mergePendingLiveMessages(
        [
          { role: "user", text: "older", kind: "" },
          { role: "user", text: "hello", kind: "" },
          { role: "assistant", text: "world", kind: "" },
        ],
        state,
        "thread-1"
      )
    ).toEqual([
      { role: "user", text: "older", kind: "" },
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "world", kind: "" },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
  });

  it("keeps pending turn ownership after history catches up to the user message only", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
    };

    expect(
      mergePendingLiveMessages([{ role: "user", text: "hello", kind: "" }], state, "thread-1")
    ).toEqual([{ role: "user", text: "hello", kind: "" }]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");

    state.activeThreadPendingAssistantMessage = "world";
    expect(
      mergePendingLiveMessages([{ role: "user", text: "hello", kind: "" }], state, "thread-1")
    ).toEqual([
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "world", kind: "" },
    ]);
  });

  it("keeps tool-only summaries inside history commentary archives before the final assistant message", async () => {
    const module = createHistoryLoaderModule({
      state: { liveDebugEvents: [] },
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: {},
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 20,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "unknown"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
    });

    const messages = await module.mapThreadReadMessages({
      turns: [
        {
          items: [
            {
              type: "userMessage",
              content: [{ type: "input_text", text: "hello" }],
            },
            {
              type: "commandExecution",
              command: "git status --short",
              status: "completed",
              output: "M src/ui/codex-web-dev.js",
              exitCode: 0,
            },
            {
              type: "toolCall",
              tool: "apply_patch",
              status: "completed",
              result: "Success. Updated the following files:\nM AGENTS.md",
            },
            {
              type: "webSearch",
              action: {
                type: "search",
                query: "openai codex history tools",
              },
            },
            {
              type: "plan",
              text: "Step 1\nStep 2",
            },
            {
              type: "assistantMessage",
              text: "done",
            },
          ],
        },
      ],
    });

    expect(messages).toEqual([
      { role: "user", text: "hello", kind: "", images: [] },
      {
        role: "system",
        kind: "commentaryArchive",
        text: "Updated Plan\nStep 1\nStep 2\ncommentary-summary:summary\nRan `git status --short`\nEdited `AGENTS.md`\nSearched web for `openai codex history tools`",
        archiveKey: "commentary-archive-1",
        archiveBlocks: [
          {
            key: "commentary-summary:summary",
            text: "",
            tools: [
              "Ran `git status --short`",
              "Edited `AGENTS.md`",
              "Searched web for `openai codex history tools`",
            ],
            plan: {
              threadId: "",
              turnId: "",
              title: "Updated Plan",
              explanation: "",
              steps: [
                { step: "Step 1", status: "pending" },
                { step: "Step 2", status: "pending" },
              ],
              deltaText: "",
            },
          },
        ],
      },
      { role: "assistant", text: "done", kind: "" },
    ]);
  });

  it("extracts the latest tool message only from incomplete history", () => {
    expect(
      findLatestIncompleteToolMessage(
        {
          page: { incomplete: true },
          turns: [
            {
              items: [
                { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
                { type: "commandExecution", command: "npm test", status: "running" },
              ],
            },
          ],
        },
        normalizeThreadItemTextImpl
      )
    ).toContain("npm test");

    expect(
      findLatestIncompleteToolMessage(
        {
          page: { incomplete: true },
          turns: [
            {
              items: [
                {
                  type: "toolCall",
                  tool: "shell_command",
                  status: "running",
                  arguments: JSON.stringify({
                    command: "cargo test --manifest-path src-tauri/Cargo.toml web_codex_history --lib",
                  }),
                },
              ],
            },
          ],
        },
        normalizeThreadItemTextImpl
      )
    ).toBe("Running `cargo test --manifest-path src-tauri/Cargo.toml web_codex_history --lib`");

    expect(
      findLatestIncompleteToolMessage(
        {
          page: { incomplete: false },
          turns: [
            {
              items: [{ type: "commandExecution", command: "npm test", status: "running" }],
            },
          ],
        },
        normalizeThreadItemTextImpl
      )
    ).toBe("");
  });

  it("shows transient tool messages only while history page is incomplete", async () => {
    const shown = [];
    const cleared = [];
    const module = createHistoryLoaderModule({
      state: {
        activeThreadId: "thread-1",
        activeThreadRenderSig: "",
        activeThreadMessages: [],
        activeThreadWorkspace: "windows",
        activeThreadPendingTurnThreadId: "",
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadStarted: false,
        activeThreadHistoryHasMore: false,
        historyWindowEnabled: false,
        historyWindowThreadId: "",
        historyAllMessages: [],
        chatShouldStickToBottom: false,
        liveDebugEvents: [],
      },
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientToolMessage(text) {
        shown.push(text);
      },
      clearTransientToolMessages() {
        cleared.push(true);
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "commandExecution", command: "npm test", status: "running" },
            { type: "assistantMessage", text: "done" },
          ],
        },
      ],
    });

    expect(shown[0]).toContain("npm test");

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "commandExecution", command: "npm test", status: "completed", output: "ok", exitCode: 0 },
            { type: "assistantMessage", text: "done" },
          ],
        },
      ],
    });

    expect(cleared.length).toBeGreaterThan(0);
  });

  it("re-applies the incomplete transient tool bubble after a full history re-render", async () => {
    const ops = [];
    const module = createHistoryLoaderModule({
      state: {
        activeThreadId: "thread-1",
        activeThreadRenderSig: "older-render",
        activeThreadMessages: [{ role: "assistant", text: "stale", kind: "" }],
        activeThreadWorkspace: "windows",
        activeThreadPendingTurnThreadId: "",
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadStarted: false,
        activeThreadHistoryHasMore: false,
        historyWindowEnabled: false,
        historyWindowThreadId: "",
        historyAllMessages: [],
        chatShouldStickToBottom: false,
        liveDebugEvents: [],
      },
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {
        ops.push("clear-history-dom");
      },
      showTransientToolMessage(text) {
        ops.push(`show:${text}`);
      },
      clearTransientToolMessages() {
        ops.push("clear-transient");
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "commandExecution", command: "npm test", status: "running" },
          ],
        },
      ],
    });

    expect(ops).toEqual([
      "clear-history-dom",
      "show:Running `npm test`",
    ]);
  });

  it("re-applies live commentary after a full history re-render while the turn is still running", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "older-render",
      activeThreadMessages: [{ role: "assistant", text: "stale", kind: "" }],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadTransientThinkingText: "正在分析",
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-1",
        text: "正在分析",
        tools: ["Running `npm test`"],
        toolKeys: ["cmd-1"],
      },
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {
        ops.push("clear-history-dom");
        state.activeThreadTransientThinkingText = "";
        state.activeThreadCommentaryCurrent = null;
        state.activeThreadCommentaryArchive = [];
        state.activeThreadCommentaryArchiveVisible = false;
        state.activeThreadCommentaryArchiveExpanded = false;
      },
      showTransientThinkingMessage(text) {
        ops.push(`thinking:${text}`);
      },
      renderCommentaryArchive() {
        ops.push(`archive:${state.activeThreadCommentaryArchiveVisible ? "visible" : "hidden"}`);
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "assistantMessage", text: "done" },
          ],
        },
      ],
    });

    expect(state.activeThreadCommentaryCurrent).toEqual(
      expect.objectContaining({
        key: "commentary-1",
        text: "正在分析",
        tools: ["Running `npm test`"],
      })
    );
    expect(ops).toContain("thinking:正在分析");
  });

  it("reconstructs the latest commentary archive from history on full render", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {
        ops.push("clear-history-dom");
      },
      renderCommentaryArchive() {
        ops.push(`archive:${state.activeThreadCommentaryArchiveVisible ? "visible" : "hidden"}`);
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
            { type: "commandExecution", command: "npm test", status: "running" },
            { type: "assistantMessage", phase: "final_answer", text: "done" },
          ],
        },
      ],
    });

    expect(state.activeThreadCommentaryArchiveVisible).toBe(true);
    expect(state.activeThreadCommentaryArchive).toEqual([
      expect.objectContaining({
        key: "commentary-1",
        text: "thinking one",
        tools: ["Running `npm test`"],
      }),
    ]);
    expect(ops).toContain("archive:visible");
  });

  it("renders completed turn commentary archives inline before each final assistant message", async () => {
    const added = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadInlineCommentaryArchiveCount: 0,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat(role, text, options = {}) {
        added.push({
          role,
          text,
          kind: options.kind || "",
          archiveKey: options.archiveKey || "",
          archiveBlocks: Array.isArray(options.archiveBlocks) ? options.archiveBlocks : [],
        });
      },
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      renderCommentaryArchive() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
            { type: "commandExecution", command: "npm test", status: "completed" },
            { type: "assistantMessage", phase: "final_answer", text: "done one" },
          ],
        },
        {
          id: "turn-2",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "again" }] },
            { type: "agentMessage", id: "commentary-2", phase: "commentary", text: "thinking two" },
            { type: "commandExecution", command: "npm run build", status: "completed" },
            { type: "assistantMessage", phase: "final_answer", text: "done two" },
          ],
        },
      ],
    });

    expect(added.map((item) => `${item.role}:${item.kind || "plain"}:${item.kind === "commentaryArchive" ? item.archiveKey : item.text}`)).toEqual([
      "user:plain:hello",
      "system:commentaryArchive:turn-1",
      "assistant:plain:done one",
      "user:plain:again",
      "system:commentaryArchive:turn-2",
      "assistant:plain:done two",
    ]);
    expect(added[1].archiveBlocks).toEqual([
      expect.objectContaining({
        key: "commentary-1",
        text: "thinking one",
        tools: ["Ran `npm test`"],
      }),
    ]);
    expect(added[4].archiveBlocks).toEqual([
      expect.objectContaining({
        key: "commentary-2",
        text: "thinking two",
        tools: ["Ran `npm run build`"],
      }),
    ]);
    expect(state.activeThreadInlineCommentaryArchiveCount).toBe(2);
  });

  it("captures plan updates into completed turn commentary archives", async () => {
    const added = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat(role, text, options = {}) {
        added.push({
          role,
          text,
          kind: options.kind || "",
          archiveKey: options.archiveKey || "",
          archiveBlocks: Array.isArray(options.archiveBlocks) ? options.archiveBlocks : [],
        });
      },
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      renderCommentaryArchive() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
            {
              type: "toolCall",
              tool: "update_plan",
              arguments: JSON.stringify({
                explanation: "Investigate runtime display",
                plan: [{ step: "Inspect live stack", status: "in_progress" }],
              }),
            },
            { type: "commandExecution", command: "npm test", status: "completed" },
            { type: "assistantMessage", phase: "final_answer", text: "done one" },
          ],
        },
      ],
    });

    expect(added[1]?.archiveBlocks).toEqual([
      expect.objectContaining({
        key: "commentary-1",
        text: "thinking one",
        plan: expect.objectContaining({
          title: "Updated Plan",
          explanation: "Investigate runtime display",
          steps: [{ step: "Inspect live stack", status: "inprogress" }],
        }),
        tools: ["Ran `npm test`"],
      }),
    ]);
  });

  it("renders a plan-only commentary archive before the final assistant message", async () => {
    const added = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat(role, text, options = {}) {
        added.push({
          role,
          text,
          kind: options.kind || "",
          archiveKey: options.archiveKey || "",
          archiveBlocks: Array.isArray(options.archiveBlocks) ? options.archiveBlocks : [],
        });
      },
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      renderCommentaryArchive() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            {
              type: "toolCall",
              tool: "update_plan",
              arguments: JSON.stringify({
                explanation: "Investigate foldout rendering",
                plan: [{ step: "Check commentary archive", status: "in_progress" }],
              }),
            },
            { type: "assistantMessage", phase: "final_answer", text: "done one" },
          ],
        },
      ],
    });

    expect(added[1]?.kind).toBe("commentaryArchive");
    expect(added[1]?.archiveBlocks).toEqual([
      expect.objectContaining({
        text: "",
        plan: expect.objectContaining({
          title: "Updated Plan",
          explanation: "Investigate foldout rendering",
          steps: [{ step: "Check commentary archive", status: "inprogress" }],
        }),
      }),
    ]);
    expect(added[2]).toEqual(expect.objectContaining({ role: "assistant", text: "done one", kind: "" }));
  });

  it("renders a tool-only commentary summary before the final assistant message", async () => {
    const added = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat(role, text, options = {}) {
        added.push({
          role,
          text,
          kind: options.kind || "",
          archiveKey: options.archiveKey || "",
          archiveBlocks: Array.isArray(options.archiveBlocks) ? options.archiveBlocks : [],
        });
      },
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      renderCommentaryArchive() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "commandExecution", command: "npm test", status: "completed" },
            { type: "assistantMessage", phase: "final_answer", text: "done one" },
          ],
        },
      ],
    });

    expect(added[1]?.kind).toBe("commentaryArchive");
    expect(added[1]?.archiveBlocks).toEqual([
      expect.objectContaining({
        text: "",
        tools: ["Ran `npm test`"],
      }),
    ]);
    expect(added[2]).toEqual(expect.objectContaining({ role: "assistant", text: "done one", kind: "" }));
  });

  it("reconstructs the current commentary block from history on full render while the turn is incomplete", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {
        ops.push("clear-history-dom");
      },
      showTransientThinkingMessage(text) {
        ops.push(`thinking:${text}`);
      },
      clearTransientThinkingMessages() {
        ops.push("thinking:clear");
      },
      renderCommentaryArchive() {
        ops.push(`archive:${state.activeThreadCommentaryArchiveVisible ? "visible" : "hidden"}`);
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
            { type: "commandExecution", command: "npm test", status: "completed" },
            { type: "agentMessage", id: "commentary-2", phase: "commentary", text: "thinking two" },
            { type: "commandExecution", command: "npm run build", status: "running" },
          ],
        },
      ],
    });

    expect(state.activeThreadCommentaryCurrent).toEqual(
      expect.objectContaining({
        key: "commentary-2",
        text: "thinking two",
        tools: ["Running `npm run build`"],
      })
    );
    expect(state.activeThreadCommentaryArchiveVisible).toBe(false);
    expect(ops).toContain("thinking:thinking two");
    expect(ops).toContain("archive:hidden");
  });

  it("prefers history current commentary over an archive-only live snapshot", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [
        {
          threadId: "thread-1",
          key: "commentary-1",
          text: "thinking one",
          tools: ["Running `npm test`"],
          toolKeys: [],
        },
      ],
      activeThreadCommentaryArchiveVisible: true,
      activeThreadCommentaryArchiveExpanded: true,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {
        ops.push("clear-history-dom");
      },
      showTransientThinkingMessage(text) {
        ops.push(`thinking:${text}`);
      },
      clearTransientThinkingMessages() {
        ops.push("thinking:clear");
      },
      renderCommentaryArchive() {
        ops.push(`archive:${state.activeThreadCommentaryArchiveVisible ? "visible" : "hidden"}`);
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
            { type: "commandExecution", command: "npm test", status: "completed" },
            { type: "agentMessage", id: "commentary-2", phase: "commentary", text: "thinking two" },
            { type: "commandExecution", command: "npm run build", status: "running" },
          ],
        },
      ],
    });

    expect(state.activeThreadCommentaryCurrent).toEqual(
      expect.objectContaining({
        key: "commentary-2",
        text: "thinking two",
        tools: ["Running `npm run build`"],
      })
    );
    expect(state.activeThreadCommentaryArchive).toEqual([]);
    expect(state.activeThreadCommentaryArchiveVisible).toBe(false);
    expect(state.activeThreadCommentaryArchiveExpanded).toBe(false);
    expect(ops).toContain("thinking:thinking two");
    expect(ops).toContain("archive:hidden");
  });

  it("suppresses stale history commentary and runtime state until the pending user turn appears in history", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "new live turn",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: true,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActivity: { threadId: "thread-1", title: "Thinking", detail: "stale", tone: "running" },
      activeThreadActiveCommands: [{ key: "cmd-1", text: "Running `npm run build`", state: "running" }],
      activeThreadPlan: {
        threadId: "thread-1",
        title: "Updated Plan",
        explanation: "stale plan",
        steps: [],
      },
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientThinkingMessage(text) {
        ops.push(`thinking:${text}`);
      },
      clearTransientThinkingMessages() {
        ops.push("thinking:clear");
      },
      showTransientToolMessage(text) {
        ops.push(`tool:${text}`);
      },
      clearTransientToolMessages() {
        ops.push("tool:clear");
      },
      clearRuntimeState() {
        ops.push("runtime:clear");
        state.activeThreadActivity = null;
        state.activeThreadActiveCommands = [];
        state.activeThreadPlan = null;
      },
      renderCommentaryArchive() {
        ops.push(`archive:${state.activeThreadCommentaryArchiveVisible ? "visible" : "hidden"}`);
      },
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
        state.activeThreadActivity = {
          threadId: "thread-1",
          title: "Thinking",
          detail: "构建已完成。",
          tone: "running",
        };
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-old",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "older user" }] },
            { type: "agentMessage", id: "commentary-old", phase: "commentary", text: "构建已完成。" },
            { type: "commandExecution", command: "npm run build", status: "running" },
          ],
        },
      ],
    });

    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(state.activeThreadPlan).toBeNull();
    expect(ops).toContain("thinking:clear");
    expect(ops).toContain("tool:clear");
    expect(ops).toContain("runtime:clear");
    expect(ops).not.toContain("runtime:sync");
  });

  it("suppresses stale history commentary for external turns until history grows beyond the baseline turn count", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 2,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: true,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActivity: { threadId: "thread-1", title: "Thinking", detail: "stale", tone: "running" },
      activeThreadActiveCommands: [{ key: "cmd-1", text: "Running `npm run build`", state: "running" }],
      activeThreadPlan: {
        threadId: "thread-1",
        title: "Updated Plan",
        explanation: "stale plan",
        steps: [],
      },
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientThinkingMessage(text) {
        ops.push(`thinking:${text}`);
      },
      clearTransientThinkingMessages() {
        ops.push("thinking:clear");
      },
      showTransientToolMessage(text) {
        ops.push(`tool:${text}`);
      },
      clearTransientToolMessages() {
        ops.push("tool:clear");
      },
      clearRuntimeState() {
        ops.push("runtime:clear");
        state.activeThreadActivity = null;
        state.activeThreadActiveCommands = [];
        state.activeThreadPlan = null;
      },
      renderCommentaryArchive() {
        ops.push(`archive:${state.activeThreadCommentaryArchiveVisible ? "visible" : "hidden"}`);
      },
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
        state.activeThreadActivity = {
          threadId: "thread-1",
          title: "Thinking",
          detail: "old commentary",
          tone: "running",
        };
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "older user" }] },
            { type: "assistantMessage", id: "assistant-1", phase: "final_answer", text: "done" },
          ],
        },
        {
          id: "turn-2",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "older user 2" }] },
            { type: "agentMessage", id: "commentary-old", phase: "commentary", text: "构建已完成。" },
            { type: "commandExecution", command: "npm run build", status: "running" },
          ],
        },
      ],
    });

    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(state.activeThreadPlan).toBeNull();
    expect(ops).toContain("thinking:clear");
    expect(ops).toContain("tool:clear");
    expect(ops).toContain("runtime:clear");
    expect(ops).not.toContain("runtime:sync");
  });

  it("replaces a stale live commentary current with the latest history commentary block", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-1",
        text: "thinking one",
        tools: ["Running `npm test`"],
        toolKeys: ["cmd-1"],
      },
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientThinkingMessage(text) {
        ops.push(`thinking:${text}`);
      },
      clearTransientThinkingMessages() {
        ops.push("thinking:clear");
      },
      renderCommentaryArchive() {
        ops.push(`archive:${state.activeThreadCommentaryArchiveVisible ? "visible" : "hidden"}`);
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "agentMessage", id: "commentary-2", phase: "commentary", text: "thinking two" },
            { type: "commandExecution", command: "npm run build", status: "running" },
          ],
        },
      ],
    });

    expect(state.activeThreadCommentaryCurrent).toEqual(
      expect.objectContaining({
        key: "commentary-2",
        text: "thinking two",
        tools: ["Running `npm run build`"],
      })
    );
    expect(ops).toContain("thinking:thinking two");
    expect(ops).toContain("archive:hidden");
  });

  it("clears a stale live commentary current when history only has archived commentary before the final answer", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: true,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-stale",
        text: "构建已完成。",
        tools: ["Running `npm run build`"],
        toolKeys: ["cmd-1"],
      },
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientThinkingMessage(text) {
        ops.push(`thinking:${text}`);
      },
      clearTransientThinkingMessages() {
        ops.push("thinking:clear");
      },
      renderCommentaryArchive() {
        ops.push(`archive:${state.activeThreadCommentaryArchiveVisible ? "visible" : "hidden"}`);
      },
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
            { type: "commandExecution", command: "npm run build", status: "completed" },
            { type: "assistantMessage", id: "assistant-final", phase: "final_answer", text: "done" },
          ],
        },
      ],
    });

    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchiveVisible).toBe(true);
    expect(state.activeThreadCommentaryArchive).toEqual([
      expect.objectContaining({
        key: "commentary-1",
        text: "thinking one",
        tools: ["Ran `npm run build`"],
      }),
    ]);
    expect(ops).toContain("thinking:clear");
    expect(ops).toContain("archive:visible");
  });

  it("prefers runtime dock state over transient tool bubbles during incomplete history", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadActivity: null,
    };
    const module = createHistoryLoaderModule({
      state,
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {
        ops.push("clear-history-dom");
      },
      showTransientToolMessage(text) {
        ops.push(`show:${text}`);
      },
      clearTransientToolMessages() {
        ops.push("clear-transient");
      },
      syncRuntimeStateFromHistory() {
        state.activeThreadActiveCommands = [{ key: "cmd-1" }];
        state.activeThreadActivity = { threadId: "thread-1", title: "Running command" };
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "commandExecution", command: "npm test", status: "running" },
          ],
        },
      ],
    });

    expect(ops).toEqual(["clear-transient"]);
  });

  it("re-renders when tool-only history summaries change", async () => {
    const rendered = [];
    const module = createHistoryLoaderModule({
      state: {
        activeThreadId: "thread-1",
        activeThreadRenderSig: "",
        activeThreadMessages: [],
        activeThreadWorkspace: "windows",
        activeThreadPendingTurnThreadId: "",
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadStarted: false,
        activeThreadHistoryHasMore: false,
        historyWindowEnabled: false,
        historyWindowThreadId: "",
        historyAllMessages: [],
        chatShouldStickToBottom: false,
        liveDebugEvents: [],
      },
      byId() { return null; },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: { createDocumentFragment() { return { appendChild() {} }; } },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 99,
      normalizeThreadTokenUsage(value) { return value ?? null; },
      renderComposerContextLeft() {},
      detectThreadWorkspaceTarget() { return "windows"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase(); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      renderMessageBody() { return ""; },
      addChat(role, text, options = {}) {
        rendered.push({ role, text, kind: options.kind || "" });
      },
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {
        rendered.length = 0;
      },
      renderChatFull: async () => {},
      syncEventSubscription() {},
    });

    const baseThread = {
      id: "thread-1",
      workspace: "windows",
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "commandExecution", command: "npm test", status: "running" },
            { type: "assistantMessage", text: "done" },
          ],
        },
      ],
    };

    await module.applyThreadToChat(baseThread);
    expect(module).toBeTruthy();
    expect(rendered).toEqual([
      { role: "user", text: "hello", kind: "" },
      { role: "system", text: "commentary-summary:turn-1\nRunning `npm test`", kind: "commentaryArchive" },
      { role: "assistant", text: "done", kind: "" },
    ]);

    await module.applyThreadToChat({
      ...baseThread,
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            {
              type: "commandExecution",
              command: "npm test",
              status: "completed",
              output: "all good",
              exitCode: 0,
            },
            { type: "assistantMessage", text: "done" },
          ],
        },
      ],
    });

    expect(rendered).toEqual([
      { role: "user", text: "hello", kind: "" },
      { role: "system", text: "commentary-summary:turn-1\nRan `npm test`", kind: "commentaryArchive" },
      { role: "assistant", text: "done", kind: "" },
    ]);
  });
});
