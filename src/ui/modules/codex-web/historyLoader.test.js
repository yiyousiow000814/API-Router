import { describe, expect, it } from "vitest";

import {
  buildHistoryRenderSig,
  buildThreadHistoryUrl,
  createHistoryLoaderModule,
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

  it("omits tool items from history chat messages", async () => {
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

  it("does not re-render for tool-only history changes because tools are omitted", async () => {
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
      { role: "assistant", text: "done", kind: "" },
    ]);
  });
});
