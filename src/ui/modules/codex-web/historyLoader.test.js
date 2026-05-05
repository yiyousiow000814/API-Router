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

  it("refreshes activeThreadRolloutPath from loaded thread history", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "wsl2",
      activeThreadRolloutPath: "/old/rollout.jsonl",
      activeThreadHistoryStatusType: "",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
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
      detectThreadWorkspaceTarget() { return "wsl2"; },
      parseUserMessageParts(item) {
        return {
          text: Array.isArray(item?.content) ? String(item.content[0]?.text || "") : "",
          images: [],
        };
      },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
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
      clearChatMessages() {},
      buildMsgNode() { return { dataset: {} }; },
      ensureLoadOlderControl() { return null; },
      syncEventSubscription() {},
      captureLiveCommentarySnapshot() { return null; },
      extractLatestCommentaryState,
      clearCommentaryArchiveState() {},
      clearCommentaryDraft() {},
      clearIncompleteToolMessage() {},
      restoreCommentaryArchiveState() {},
      syncIncompleteToolMessage() {},
      renderCommentaryArchive() {},
      renderActiveCommentary() {},
      syncRuntimeStateFromHistory() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      path: "/new/rollout.jsonl",
      workspace: "wsl2",
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", text: "latest" }],
        },
      ],
      status: { type: "running" },
      page: { incomplete: false },
    });

    expect(state.activeThreadRolloutPath).toBe("/new/rollout.jsonl");
    expect(state.activeThreadHistoryStatusType).toBe("running");
  });

  it("clears transient live connection status when terminal history becomes authoritative", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
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
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
    };
    const clears = [];
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
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
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
      clearChatMessages() {},
      buildMsgNode() { return { dataset: {} }; },
      ensureLoadOlderControl() { return null; },
      syncEventSubscription() {},
      captureLiveCommentarySnapshot() { return null; },
      extractLatestCommentaryState,
      clearCommentaryArchiveState() {},
      clearCommentaryDraft() {},
      clearIncompleteToolMessage() {},
      restoreCommentaryArchiveState() {},
      syncIncompleteToolMessage() {},
      renderCommentaryArchive() {},
      renderActiveCommentary() {},
      syncRuntimeStateFromHistory() {},
      clearLiveThreadConnectionStatus() {
        clears.push("clear");
        state.activeThreadConnectionStatusKind = "";
        state.activeThreadConnectionStatusText = "";
      },
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "failed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(clears).toEqual(["clear"]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
  });

  it("keeps the current live connection error when the terminal history belongs to the current started thread", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
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
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
    };
    const clears = [];
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
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
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
      clearChatMessages() {},
      buildMsgNode() { return { dataset: {} }; },
      ensureLoadOlderControl() { return null; },
      syncEventSubscription() {},
      captureLiveCommentarySnapshot() { return null; },
      extractLatestCommentaryState,
      clearCommentaryArchiveState() {},
      clearCommentaryDraft() {},
      clearIncompleteToolMessage() {},
      restoreCommentaryArchiveState() {},
      syncIncompleteToolMessage() {},
      renderCommentaryArchive() {},
      renderActiveCommentary() {},
      syncRuntimeStateFromHistory() {},
      clearLiveThreadConnectionStatus() {
        clears.push("clear");
      },
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "failed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(clears).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
  });

  it("does not re-overlay a stale live connection error when reopening a terminal history thread", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
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
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
    };
    const clears = [];
    const overlays = [];
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
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
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
        overlays.push({ role, text, options });
      },
      clearChatMessages() {},
      buildMsgNode() { return { dataset: {} }; },
      ensureLoadOlderControl() { return null; },
      syncEventSubscription() {},
      captureLiveCommentarySnapshot() { return null; },
      extractLatestCommentaryState,
      clearCommentaryArchiveState() {},
      clearCommentaryDraft() {},
      clearIncompleteToolMessage() {},
      restoreCommentaryArchiveState() {},
      syncIncompleteToolMessage() {},
      renderCommentaryArchive() {},
      renderActiveCommentary() {},
      syncRuntimeStateFromHistory() {},
      clearLiveThreadConnectionStatus() {
        clears.push("clear");
        state.activeThreadConnectionStatusKind = "";
        state.activeThreadConnectionStatusText = "";
      },
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "failed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(clears).toEqual(["clear"]);
    expect(
      overlays.filter((entry) => String(entry?.role || "").trim().toLowerCase() === "system")
    ).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
  });

  it("clears a latched transient connection error when explicitly reopening a non-resumable history thread", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
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
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
      activeThreadOpenState: {
        threadId: "thread-1",
        resumeRequired: false,
        loaded: false,
      },
    };
    const clears = [];
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
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
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
      clearChatMessages() {},
      buildMsgNode() { return { dataset: {} }; },
      ensureLoadOlderControl() { return null; },
      syncEventSubscription() {},
      captureLiveCommentarySnapshot() { return null; },
      extractLatestCommentaryState,
      clearCommentaryArchiveState() {},
      clearCommentaryDraft() {},
      clearIncompleteToolMessage() {},
      restoreCommentaryArchiveState() {},
      syncIncompleteToolMessage() {},
      renderCommentaryArchive() {},
      renderActiveCommentary() {},
      syncRuntimeStateFromHistory() {},
      clearLiveThreadConnectionStatus() {
        clears.push("clear");
        state.activeThreadConnectionStatusKind = "";
        state.activeThreadConnectionStatusText = "";
      },
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "failed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    }, {
      forceRender: true,
    });

    expect(clears).toEqual(["clear"]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(state.activeThreadTerminalConnectionErrorThreadId).toBe("");
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

  it("dedupes adjacent identical assistant history messages when a repeated final reply leaks into turns", async () => {
    const added = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
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
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
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
        added.push({ role, text, kind: options.kind || "" });
      },
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientToolMessage() {},
      showTransientThinkingMessage() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: false },
      historyItems: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "same final" }] },
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "same final" }] },
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "same final" }] },
      ],
    });

    expect(state.activeThreadMessages).toEqual([
      { role: "user", text: "hello", kind: "", images: [] },
      { role: "assistant", text: "same final", kind: "" },
    ]);
    expect(added).toEqual([
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "same final", kind: "" },
    ]);
  });

  it("resubscribes live events when the active thread workspace differs from the current ws subscription", async () => {
    let syncCalls = 0;
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "wsl2",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: false,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      wsSubscribedEvents: true,
      wsSubscribedWorkspaceTarget: "windows",
      wsRequestedWorkspaceTarget: "windows",
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
      detectThreadWorkspaceTarget() { return "wsl2"; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      isBootstrapAgentsPrompt() { return false; },
      normalizeThreadItemText: normalizeThreadItemTextImpl,
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
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
      buildImageBlocks() { return []; },
      addChat() {},
      clearChatMessages() {},
      renderChatFull: async () => {},
      updateLoadOlderControl() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {
        syncCalls += 1;
      },
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "wsl2",
      page: { incomplete: false },
      turns: [],
    });

    expect(syncCalls).toBe(1);
    expect(state.activeThreadWorkspace).toBe("wsl2");
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

  it("strips Codex desktop git directives from session assistant history", () => {
    expect(
      normalizeSessionAssistantText(
        [
          {
            type: "output_text",
            text: `已推送
::git-stage{cwd="C:\\Users\\yiyou\\API-Router"}
::git-commit{cwd="C:\\Users\\yiyou\\API-Router"}
::git-push{cwd="C:\\Users\\yiyou\\API-Router" branch="fix/thread-source-allowlist"}`,
          },
        ],
        {
          normalizeType: (value) => String(value || "").replace(/[^a-z]/gi, "").toLowerCase(),
          stripCodexImageBlocks: (value) => value,
        }
      )
    ).toBe("已推送");
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

  it("detects standalone plan markdown in session history and records diagnostics", async () => {
    const state = { liveDebugEvents: [] };
    const module = createHistoryLoaderModule({
      state,
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
        phase: "final_answer",
        id: "assistant-plan-1",
        content: [{
          type: "output_text",
          text: `# Fix Plan Rendering

## Summary
Ensure the web client recognizes plan responses even when the wrapper heading is omitted.

### Changes
- Detect standalone plan markdown before the confirmation prompt
- Render the inline plan card and local confirmation question

Implement this plan?
1. Yes, implement this plan
2. No, stay in Plan mode`,
        }],
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: "system",
        kind: "planCard",
        plan: expect.objectContaining({ title: "Fix Plan Rendering" }),
      }),
    ]);
    expect(state.liveDebugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "history.inspect:proposed_plan_detection",
        source: "history.session",
        itemId: "assistant-plan-1",
        hasPlan: true,
        hasPendingUserInput: true,
      }),
    ]));
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

  it("clears pending turn state when incomplete history already ends with the exact pending user and assistant pair", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "OK",
      activeThreadLastFinalAssistantThreadId: "thread-1",
      activeThreadLastFinalAssistantText: "OK",
      activeThreadHistoryIncomplete: true,
    };

    expect(
      mergePendingLiveMessages(
        [
          { role: "user", text: "hello", kind: "" },
          { role: "assistant", text: "OK", kind: "" },
        ],
        state,
        "thread-1",
        { historyIncomplete: true }
      )
    ).toEqual([
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "OK", kind: "" },
    ]);

    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
  });

  it("adopts pending turn control state from incomplete history for an opened running thread", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadOpenState: {
        threadId: "thread-1",
        loaded: false,
        resumeRequired: true,
      },
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
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
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-live",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
          ],
        },
      ],
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("turn-live");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
  });

  it("does not synthesize running pending state from notLoaded incomplete history without turns", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadOpenState: {
        threadId: "thread-1",
        loaded: false,
        resumeRequired: true,
      },
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: true,
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
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "notLoaded" },
      page: { incomplete: true },
      turns: [],
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(
      state.liveDebugEvents.some(
        (event) => event?.kind === "pending.runtime:reset" && event?.reason === "history.sync:incomplete_without_turn"
      )
    ).toBe(true);
  });

  it("does not restore pending running from incomplete systemError history", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-live",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
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
      activeThreadActiveCommands: [{ key: "cmd-1" }],
      activeThreadPlan: null,
      activeThreadActivity: { threadId: "thread-1", title: "Working" },
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
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      clearRuntimeState() {
        ops.push("runtime:clear");
        state.activeThreadActiveCommands = [];
        state.activeThreadPlan = null;
        state.activeThreadActivity = null;
      },
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
        state.activeThreadPendingTurnRunning = true;
        state.activeThreadActivity = { threadId: "thread-1", title: "Working" };
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "systemError" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-live",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "commandExecution", command: "npm test", status: "running" },
          ],
        },
      ],
    });

    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(ops).toContain("runtime:clear");
    expect(ops).not.toContain("runtime:sync");
  });

  it("clears stale header status once terminal history becomes authoritative", async () => {
    const statuses = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
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
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
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
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "failed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hello" }] }],
        },
      ],
    });

    expect(statuses).toContainEqual({ message: "", isWarn: false });
  });

  it("does not let incomplete history revive runtime after the current thread already latched a connection error", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-live",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
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
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available",
      activeThreadActiveCommands: [{ key: "cmd-1" }],
      activeThreadPlan: null,
      activeThreadActivity: { threadId: "thread-1", title: "Working" },
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
      showTransientToolMessage() {},
      clearTransientToolMessages() {
        ops.push("tool:clear");
      },
      clearTransientThinkingMessages() {},
      clearRuntimeState() {
        ops.push("runtime:clear");
        state.activeThreadActiveCommands = [];
        state.activeThreadPlan = null;
        state.activeThreadActivity = null;
      },
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
        state.activeThreadPendingTurnRunning = true;
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "active" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-live",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hello" }] }],
        },
      ],
    });

    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(ops).toContain("runtime:clear");
    expect(ops).not.toContain("runtime:sync");
  });

  it("does not let incomplete history revive runtime after a terminal connection error latch even if the status card is already gone", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-live",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
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
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
      activeThreadActiveCommands: [{ key: "cmd-1" }],
      activeThreadPlan: null,
      activeThreadActivity: { threadId: "thread-1", title: "Working" },
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
      showTransientToolMessage() {},
      clearTransientToolMessages() {
        ops.push("tool:clear");
      },
      clearTransientThinkingMessages() {},
      clearRuntimeState() {
        ops.push("runtime:clear");
        state.activeThreadActiveCommands = [];
        state.activeThreadPlan = null;
        state.activeThreadActivity = null;
      },
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
        state.activeThreadPendingTurnRunning = true;
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "active" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-live",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hello" }] }],
        },
      ],
    });

    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(ops).toContain("runtime:clear");
    expect(ops).not.toContain("runtime:sync");
  });

  it("does not resurrect pending runtime from an incomplete history turn that only contains the user message", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadOpenState: {
        threadId: "thread-1",
        loaded: false,
        resumeRequired: false,
      },
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
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
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
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
      clearChatMessages() {},
      buildMsgNode() { return { dataset: {} }; },
      syncEventSubscription() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "active" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnId).toBe("");
  });

  it("restores pending turn running when incomplete history arrives while a partial assistant snapshot already exists", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-live",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "partial reply",
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
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-live",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
          ],
        },
      ],
    });

    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingTurnId).toBe("turn-live");
  });

  it("does not resurrect runtime from stale incomplete history after a final live assistant snapshot", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [
        { role: "user", text: "hello", kind: "" },
        { role: "assistant", text: "done", kind: "" },
      ],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-live",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "done",
      activeThreadLastFinalAssistantThreadId: "thread-1",
      activeThreadLastFinalAssistantText: "done",
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
      clearChatMessages() {},
      clearTransientToolMessages() {
        ops.push("tool:clear");
      },
      clearTransientThinkingMessages() {},
      clearRuntimeState() {
        ops.push("runtime:clear");
        state.activeThreadActiveCommands = [];
        state.activeThreadPlan = null;
        state.activeThreadActivity = null;
      },
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
        state.activeThreadActiveCommands = [{ key: "cmd-1" }];
        state.activeThreadActivity = { threadId: "thread-1", title: "Working" };
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-live",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "commandExecution", command: "npm test", status: "running" },
          ],
        },
      ],
    });

    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnId).toBe("turn-live");
    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(ops).toContain("runtime:clear");
    expect(ops).not.toContain("runtime:sync");
  });

  it("does not clear pending runtime from empty incomplete history materialization", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [{ role: "user", text: "hello", kind: "" }],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-live",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 0,
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
      activeThreadActiveCommands: [{ key: "cmd-1" }],
      activeThreadPlan: null,
      activeThreadActivity: { threadId: "thread-1", title: "Working" },
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
      clearTransientToolMessages() {
        ops.push("tool:clear");
      },
      clearTransientThinkingMessages() {},
      clearRuntimeState() {
        ops.push("runtime:clear");
        state.activeThreadActiveCommands = [];
        state.activeThreadPlan = null;
        state.activeThreadActivity = null;
      },
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true },
      turns: [],
    });

    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadActivity).toEqual({ threadId: "thread-1", title: "Working" });
    expect(state.activeThreadActiveCommands).toEqual([{ key: "cmd-1" }]);
    expect(ops).not.toContain("runtime:clear");
  });

  it("does not clear pending runtime from non-terminal empty history pages", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [{ role: "user", text: "hello", kind: "" }],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-live",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 0,
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
      activeThreadActiveCommands: [{ key: "cmd-1" }],
      activeThreadPlan: null,
      activeThreadActivity: { threadId: "thread-1", title: "Working" },
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
      clearTransientToolMessages() {
        ops.push("tool:clear");
      },
      clearTransientThinkingMessages() {},
      clearRuntimeState() {
        ops.push("runtime:clear");
        state.activeThreadActiveCommands = [];
        state.activeThreadPlan = null;
        state.activeThreadActivity = null;
      },
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "active" },
      page: { incomplete: false },
      turns: [],
    });

    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingUserMessage).toBe("hello");
    expect(state.activeThreadActivity).toEqual({ threadId: "thread-1", title: "Working" });
    expect(ops).not.toContain("runtime:clear");
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

  it("keeps pending turn running while incomplete history only catches up to a streamed assistant snapshot", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "partial reply",
    };

    expect(
      mergePendingLiveMessages(
        [
          { role: "user", text: "hello", kind: "" },
          { role: "assistant", text: "partial reply", kind: "" },
        ],
        state,
        "thread-1",
        { historyIncomplete: true }
      )
    ).toEqual([
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "partial reply", kind: "" },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("partial reply");
  });

  it("drops stale history applies before they can re-render older tool state", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadHistoryReqSeq: 3,
      activeThreadRenderSig: "current-render",
      activeThreadMessages: [{ role: "user", text: "latest prompt", kind: "" }],
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
      renderComposerContextLeft() {
        ops.push("context:render");
      },
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
        ops.push(`chat:${role}:${String(options.kind || "")}:${text}`);
      },
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {
        ops.push("chat:clear");
      },
      showTransientToolMessage(text) {
        ops.push(`tool:${text}`);
      },
      clearTransientToolMessages() {
        ops.push("tool:clear");
      },
      clearTransientThinkingMessages() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
      },
      syncEventSubscription() {},
    });

    await module.applyThreadToChat(
      {
        id: "thread-1",
        workspace: "windows",
        page: { incomplete: true },
        turns: [
          {
            id: "turn-old",
            items: [
              { type: "userMessage", content: [{ type: "input_text", text: "older user" }] },
              {
                type: "webSearch",
                query: "openai codex stale history",
              },
            ],
          },
        ],
      },
      { historyReqSeq: 2 }
    );

    expect(ops).toEqual([]);
    expect(state.activeThreadMessages).toEqual([{ role: "user", text: "latest prompt", kind: "" }]);
    expect(state.liveDebugEvents.some((event) => event.kind === "history.apply:drop_stale_req")).toBe(true);
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

  it("keeps the pending user fallback until the assistant reply is also reflected in history", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "push it",
      activeThreadPendingAssistantMessage: "",
    };

    expect(
      mergePendingLiveMessages([{ role: "user", text: "push it", kind: "" }], state, "thread-1")
    ).toEqual([{ role: "user", text: "push it", kind: "" }]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingUserMessage).toBe("push it");

    expect(
      mergePendingLiveMessages([{ role: "assistant", text: "older reply", kind: "" }], state, "thread-1")
    ).toEqual([
      { role: "assistant", text: "older reply", kind: "" },
      { role: "user", text: "push it", kind: "" },
    ]);
  });

  it("does not append a duplicate pending user when authoritative history already contains the latest user echo before commentary", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
    };

    expect(
      mergePendingLiveMessages(
        [
          { role: "assistant", text: "older reply", kind: "" },
          { role: "user", text: "hi", kind: "" },
          { role: "system", text: "tool trace", kind: "commentaryArchive" },
        ],
        state,
        "thread-1",
        { historyIncomplete: true }
      )
    ).toEqual([
      { role: "assistant", text: "older reply", kind: "" },
      { role: "user", text: "hi", kind: "" },
      { role: "system", text: "tool trace", kind: "commentaryArchive" },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
  });

  it("does not append a duplicate pending user when authoritative history already contains the latest user echo before the latest assistant reply", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
    };

    expect(
      mergePendingLiveMessages(
        [
          { role: "assistant", text: "older reply", kind: "" },
          { role: "user", text: "hi", kind: "" },
          { role: "assistant", text: "你好，发任务。", kind: "" },
        ],
        state,
        "thread-1",
        { historyIncomplete: true }
      )
    ).toEqual([
      { role: "assistant", text: "older reply", kind: "" },
      { role: "user", text: "hi", kind: "" },
      { role: "assistant", text: "你好，发任务。", kind: "" },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
  });

  it("does not treat an identical prompt from the baseline turn as a materialized pending user", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 1,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
    };

    expect(
      mergePendingLiveMessages(
        [{ role: "user", text: "hi", kind: "" }],
        state,
        "thread-1",
        { historyIncomplete: true, historyTurnCount: 1 }
      )
    ).toEqual([
      { role: "user", text: "hi", kind: "" },
      { role: "user", text: "hi", kind: "" },
    ]);
    expect(state.activeThreadPendingUserMessage).toBe("hi");
  });

  it("does not treat an unchanged authoritative user count as a materialized duplicate prompt when turn count stays zero", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
    };

    expect(
      mergePendingLiveMessages(
        [{ role: "user", text: "hi", kind: "" }],
        state,
        "thread-1",
        { historyIncomplete: true, historyTurnCount: 0 }
      )
    ).toEqual([
      { role: "user", text: "hi", kind: "" },
      { role: "user", text: "hi", kind: "" },
    ]);
    expect(state.activeThreadPendingUserMessage).toBe("hi");
  });

  it("keeps finalized pending placeholders visible while history is still stale", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "done",
    };

    expect(mergePendingLiveMessages([], state, "thread-1")).toEqual([
      { role: "user", text: "hello", kind: "" },
      { role: "assistant", text: "done", kind: "" },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingUserMessage).toBe("hello");
    expect(state.activeThreadPendingAssistantMessage).toBe("done");
  });

  it("keeps a failed second-send user echo visible while authoritative history is still on the previous turn", () => {
    const state = {
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnBaselineTurnCount: 1,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
    };

    expect(
      mergePendingLiveMessages(
        [{ role: "user", text: "hi", kind: "" }],
        state,
        "thread-1",
        { historyTurnCount: 1 }
      )
    ).toEqual([
      { role: "user", text: "hi", kind: "" },
      { role: "user", text: "hi", kind: "" },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(1);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(1);
  });

  it("keeps the failed second-send pending user across repeated terminal history polls until history materializes it", async () => {
    const added = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: true,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "", images: [] },
        { role: "user", text: "hi", kind: "" },
      ],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
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
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
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
        added.push({ role, text, kind: options.kind || "" });
      },
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientToolMessage() {},
      showTransientThinkingMessage() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {},
    });

    const staleFailedThread = {
      id: "thread-1",
      workspace: "windows",
      status: { type: "failed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    };

    await module.applyThreadToChat(staleFailedThread);
    await module.applyThreadToChat(staleFailedThread);

    expect(state.activeThreadMessages).toEqual([
      { role: "user", text: "hi", kind: "", images: [] },
      { role: "user", text: "hi", kind: "" },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(0);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(1);
    expect(added.filter((entry) => entry.role === "user")).toEqual([]);
    expect(state.activeThreadMessages).toEqual([
      { role: "user", text: "hi", kind: "", images: [] },
      { role: "user", text: "hi", kind: "" },
    ]);
    expect(added.some(
      (entry) =>
        entry.role === "system" &&
        entry.kind === "error" &&
        entry.text === "no routable providers available; preferred=aigateway; tried=",
    )).toBe(true);
  });

  it("materializes an error when terminal history becomes authoritative for a reconnecting second-send", async () => {
    const added = [];
    const clears = [];
    const statuses = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "", images: [] },
        { role: "user", text: "hi", kind: "" },
      ],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
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
      activeThreadConnectionStatusKind: "reconnecting",
      activeThreadConnectionStatusText: "Reconnecting... 5/5",
      activeThreadTerminalConnectionErrorThreadId: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadConnectionReplayGuardEpoch: 4,
      activeThreadConnectionReplayGuardReconnectSeen: true,
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
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      setStatus(text, isWarn) {
        statuses.push({ text, isWarn });
      },
      renderMessageBody() { return ""; },
      addChat(role, text, options = {}) {
        added.push({ role, text, kind: options.kind || "", key: options.messageKey || "" });
      },
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientToolMessage() {},
      showTransientThinkingMessage() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {
        clears.push("clear");
        state.activeThreadConnectionStatusKind = "";
        state.activeThreadConnectionStatusText = "";
      },
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "systemError" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(clears).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
    expect(statuses).toContainEqual({
      text: "no routable providers available; preferred=aigateway; tried=",
      isWarn: true,
    });
    expect(added.some(
      (entry) =>
        entry.role === "system" &&
        entry.kind === "error" &&
        entry.key === "live-thread-connection-status" &&
        entry.text === "no routable providers available; preferred=aigateway; tried="
    )).toBe(true);
    expect(added.some(
      (entry) =>
        entry.role === "system" &&
        entry.kind === "thinking" &&
        entry.text === "Reconnecting... 5/5"
    )).toBe(false);
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
              kind: "",
              markdownBody: "",
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

  it("clears transient tool messages when incomplete history is already represented in runtime state", async () => {
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
          ],
        },
      ],
    });

    expect(shown).toEqual(["Running `npm test`"]);

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

  it("renders an empty commentary summary before the final assistant message", async () => {
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
      normalizeThreadItemText(item) { return String(item?.text || ""); },
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
            { type: "assistantMessage", phase: "final_answer", text: "done one" },
          ],
        },
      ],
    });

    expect(added).toEqual([
      expect.objectContaining({ role: "user", text: "hello", kind: "" }),
      expect.objectContaining({ role: "assistant", text: "done one", kind: "" }),
    ]);
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

  it("does not suppress a failed incomplete history page when it still needs the pending second-send user fallback", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "user", text: "hi", kind: "" },
      ],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnBaselineTurnCount: 1,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
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
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
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
      },
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {
        ops.push("runtime:sync");
      },
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "failed" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(state.activeThreadMessages).toEqual([
      { role: "user", text: "hi", kind: "", images: [] },
      { role: "user", text: "hi", kind: "" },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(state.liveDebugEvents.some((event) => event?.kind === "history.runtime:suppress_stale_pending")).toBe(false);
    expect(ops).not.toContain("runtime:clear");
  });

  it("does not drop pending running during a stale non-incomplete history poll when the second-send fallback still owns the turn", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "user", text: "hi", kind: "" },
      ],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 1,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
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
      showTransientThinkingMessage() {},
      clearTransientThinkingMessages() {},
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "active" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(
      state.liveDebugEvents.some(
        (event) => event?.kind === "pending.runtime:set_running" && event?.reason === "history.sync:not_incomplete_or_terminal"
      )
    ).toBe(false);
  });

  it("does not let a stale failed history page clear a newly started second send before reconnect begins", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
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
      showTransientThinkingMessage() {},
      clearTransientThinkingMessages() {},
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "failed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("turn-2");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(
      state.liveDebugEvents.some(
        (event) => event?.kind === "pending.runtime:reset" && event?.reason === "history.sync:not_incomplete_or_terminal"
      )
    ).toBe(false);
  });

  it("clears stale running state when complete history has only a pending turn id shell", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-stale",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 0,
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
      showTransientThinkingMessage() {},
      clearTransientThinkingMessages() {},
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "notLoaded" },
      page: { incomplete: false },
      turns: [],
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(
      state.liveDebugEvents.some(
        (event) => event?.kind === "pending.runtime:reset" && event?.reason === "history.sync:complete_without_materialized_history"
      )
    ).toBe(true);
  });

  it("settles a pending running turn from complete authoritative history even when no live turn completion event arrived", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [
        { role: "user", text: "older", kind: "" },
        { role: "assistant", text: "older reply", kind: "" },
      ],
      activeThreadWorkspace: "wsl2",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 1,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
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
      detectThreadWorkspaceTarget() { return "wsl2"; },
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
      showTransientThinkingMessage() {},
      clearTransientThinkingMessages() {},
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "wsl2",
      status: { type: "completed" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "older" }] },
            { type: "assistantMessage", phase: "final_answer", text: "older reply" },
          ],
        },
        {
          id: "turn-2",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hi" }] },
            { type: "assistantMessage", phase: "final_answer", text: "你好，直接说任务。" },
          ],
        },
      ],
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
    expect(
      state.liveDebugEvents.some(
        (event) => event?.kind === "pending.runtime:reset" && event?.reason === "history.sync:complete_materialized_pending_turn"
      )
    ).toBe(true);
  });

  it("stops a reconnecting pending turn once systemError history can materialize the terminal error", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "user", text: "hi", kind: "" },
      ],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 1,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
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
      activeThreadConnectionStatusKind: "reconnecting",
      activeThreadConnectionStatusText: "Reconnecting... 5/5",
      activeThreadTerminalConnectionErrorThreadId: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadConnectionReplayGuardEpoch: 4,
      activeThreadConnectionReplayGuardReconnectSeen: true,
    };
    const statuses = [];
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
      setStatus(text, isWarn) {
        statuses.push({ text, isWarn });
      },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientThinkingMessage() {},
      clearTransientThinkingMessages() {},
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "systemError" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
        {
          id: "turn-2",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("turn-2");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
    expect(statuses).toContainEqual({
      text: "no routable providers available; preferred=aigateway; tried=",
      isWarn: true,
    });
    expect(state.liveDebugEvents.some(
      (event) => event?.kind === "pending.runtime:set_running" && event?.reason === "history.sync:terminal_preserve_pending_user"
    )).toBe(false);
    expect(state.liveDebugEvents.some(
      (event) => event?.kind === "pending.runtime:reset" && event?.reason === "history.sync:terminal_preserve_pending_user"
    )).toBe(false);
    expect(state.liveDebugEvents.some(
      (event) => event?.kind === "history.connection:materialize_terminal_error"
    )).toBe(true);
  });

  it("does not materialize reconnect text as a terminal error without terminal error context text", async () => {
    const statuses = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "", images: [] },
      ],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
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
      activeThreadConnectionStatusKind: "reconnecting",
      activeThreadConnectionStatusText: "Reconnecting... 5/5",
      activeThreadTerminalConnectionErrorThreadId: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardText: "",
      activeThreadConnectionReplayGuardEpoch: 4,
      activeThreadConnectionReplayGuardReconnectSeen: true,
      activeThreadPendingTerminalConnectionErrorThreadId: "",
      activeThreadPendingTerminalConnectionErrorText: "",
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
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
      stripCodexImageBlocks(value) { return String(value || ""); },
      hideWelcomeCard() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      updateScrollToBottomBtn() {},
      scheduleChatLiveFollow() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      canStartChatLiveFollow() { return false; },
      setStatus(text, isWarn) {
        statuses.push({ text, isWarn });
      },
      renderMessageBody() { return ""; },
      addChat() {},
      buildMsgNode() { return { nodeType: 1 }; },
      clearChatMessages() {},
      showTransientToolMessage() {},
      showTransientThinkingMessage() {},
      clearTransientToolMessages() {},
      clearTransientThinkingMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "systemError" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(state.activeThreadConnectionStatusKind).toBe("reconnecting");
    expect(state.activeThreadConnectionStatusText).toBe("Reconnecting... 5/5");
    expect(statuses).toEqual([]);
    expect(state.liveDebugEvents.some(
      (event) => event?.kind === "history.connection:materialize_terminal_error"
    )).toBe(false);
  });

  it("does not let suppressed synthetic pending inputs clear an active second-send runtime", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "",
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "user", text: "hi", kind: "" },
      ],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadPendingUserMessage: "hi",
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
      suppressedSyntheticPendingUserInputsByThreadId: { "thread-1": true },
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
      showTransientThinkingMessage() {},
      clearTransientThinkingMessages() {},
      showTransientToolMessage() {},
      clearTransientToolMessages() {},
      clearRuntimeState() {},
      renderCommentaryArchive() {},
      syncRuntimeStateFromHistory() {},
      syncEventSubscription() {},
      clearLiveThreadConnectionStatus() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      status: { type: "active" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [{ type: "userMessage", content: [{ type: "input_text", text: "hi" }] }],
        },
      ],
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("turn-2");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(
      state.liveDebugEvents.some((event) => event?.kind === "pending.runtime:reset" && event?.reason === "history.sync:suppressed_pending")
    ).toBe(false);
    expect(
      state.liveDebugEvents.some((event) => event?.kind === "pending.runtime:reset" && event?.reason === "history.sync:not_incomplete_or_terminal")
    ).toBe(false);
  });

  it("does not restore a commentary snapshot captured before a new pending turn reset", async () => {
    const ops = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadRenderSig: "older-render",
      activeThreadMessages: [{ role: "assistant", text: "stale", kind: "" }],
      activeThreadWorkspace: "windows",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadStarted: true,
      activeThreadHistoryHasMore: false,
      historyWindowEnabled: false,
      historyWindowThreadId: "",
      historyAllMessages: [],
      chatShouldStickToBottom: false,
      liveDebugEvents: [],
      activeThreadLiveStateEpoch: 1,
      activeThreadTransientThinkingText: "构建已完成。",
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-old",
        text: "构建已完成。",
        tools: [],
        toolKeys: [],
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
        state.activeThreadLiveStateEpoch = 2;
        state.activeThreadPendingTurnThreadId = "thread-1";
        state.activeThreadPendingTurnRunning = true;
        state.activeThreadPendingUserMessage = "new live turn";
        state.activeThreadPendingAssistantMessage = "";
        state.activeThreadTransientThinkingText = "";
        state.activeThreadCommentaryCurrent = null;
        state.activeThreadCommentaryArchive = [];
        state.activeThreadCommentaryArchiveVisible = false;
        state.activeThreadCommentaryArchiveExpanded = false;
      },
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
      clearRuntimeState() {},
      renderCommentaryArchive() {
        ops.push(`archive:${state.activeThreadCommentaryArchiveVisible ? "visible" : "hidden"}`);
      },
      syncRuntimeStateFromHistory() {},
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
            { type: "assistantMessage", id: "assistant-old", phase: "final_answer", text: "older answer" },
          ],
        },
      ],
    });

    expect(state.activeThreadLiveStateEpoch).toBe(2);
    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadTransientThinkingText).toBe("");
    expect(ops).toContain("clear-history-dom");
    expect(ops).toContain("thinking:clear");
    expect(ops).not.toContain("thinking:构建已完成。");
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

  it("preserves scroll when a non-sticky history window is rebuilt for an incomplete turn", async () => {
    const clearCalls = [];
    const module = createHistoryLoaderModule({
      state: {
        activeThreadId: "thread-1",
        activeThreadRenderSig: "older-render",
        activeThreadMessages: [{ role: "assistant", text: "older", kind: "" }],
        activeThreadWorkspace: "windows",
        activeThreadPendingTurnThreadId: "",
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadStarted: true,
        activeThreadHistoryHasMore: true,
        activeThreadHistoryTurns: [{ id: "turn-older-1" }, { id: "turn-older-2" }],
        activeThreadHistoryThreadId: "thread-1",
        historyWindowEnabled: true,
        historyWindowThreadId: "thread-1",
        historyWindowStart: 60,
        historyAllMessages: new Array(120).fill(null).map((_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `older-${index}`,
          kind: "",
        })),
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
      HISTORY_WINDOW_THRESHOLD: 5,
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
      clearChatMessages(options = {}) {
        clearCalls.push(options);
      },
      renderChatFull: async () => {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true, hasMore: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "input_text", text: "hello" }] },
            { type: "assistantMessage", text: "done" },
          ],
        },
      ],
    }, { forceHistoryWindow: true });

    expect(clearCalls).toContainEqual(expect.objectContaining({
      preservePendingTurn: true,
      preserveScroll: true,
    }));
  });

  it("restores scrollTop after rebuilding a non-sticky history window", async () => {
    const elementById = new Map();
    const createFakeElement = (tagName = "div") => {
      const node = {
        tagName: String(tagName || "div").toUpperCase(),
        children: [],
        parentElement: null,
        className: "",
        textContent: "",
        disabled: false,
        __wiredLoadOlder: false,
        appendChild(child) {
          if (!child) return child;
          child.parentElement = this;
          this.children.push(child);
          return child;
        },
        remove() {
          if (!this.parentElement || !Array.isArray(this.parentElement.children)) return;
          this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
          this.parentElement = null;
        },
        addEventListener() {},
        querySelector(selector) {
          if (selector === "#loadOlderBtn") return elementById.get("loadOlderBtn") || null;
          return null;
        },
      };
      Object.defineProperty(node, "id", {
        configurable: true,
        get() {
          return this._id || "";
        },
        set(value) {
          this._id = String(value || "");
          if (this._id) elementById.set(this._id, this);
        },
      });
      Object.defineProperty(node, "innerHTML", {
        configurable: true,
        get() {
          return this._innerHTML || "";
        },
        set(value) {
          this._innerHTML = String(value || "");
          if (this._innerHTML.includes("loadOlderBtn")) {
            const btn = createFakeElement("button");
            btn.id = "loadOlderBtn";
            btn.className = "loadOlderBtn";
            this.children = [btn];
            btn.parentElement = this;
          } else {
            this.children = [];
          }
        },
      });
      return node;
    };
    const chatBox = {
      childNodes: [],
      clientHeight: 320,
      scrollTop: 420,
      appendChild(node) {
        if (Array.isArray(node?.children)) {
          this.childNodes.push(...node.children);
          return node;
        }
        this.childNodes.push(node);
        return node;
      },
      insertBefore(node) {
        return this.appendChild(node);
      },
      querySelector() {
        return this.childNodes.length ? this.childNodes[0] : null;
      },
      querySelectorAll() {
        return [];
      },
      get scrollHeight() {
        return Math.max(1200, this.childNodes.length * 28);
      },
    };

    const module = createHistoryLoaderModule({
      state: {
        activeThreadId: "thread-1",
        activeThreadRenderSig: "older-render",
        activeThreadMessages: [{ role: "assistant", text: "older", kind: "" }],
        activeThreadWorkspace: "windows",
        activeThreadPendingTurnThreadId: "",
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadStarted: true,
        activeThreadHistoryHasMore: false,
        activeThreadHistoryTurns: [{ id: "turn-older-1" }, { id: "turn-older-2" }],
        activeThreadHistoryThreadId: "thread-1",
        historyWindowEnabled: true,
        historyWindowThreadId: "thread-1",
        historyWindowStart: 60,
        historyAllMessages: new Array(120).fill(null).map((_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `older-${index}`,
          kind: "",
        })),
        chatShouldStickToBottom: false,
        liveDebugEvents: [],
        historyWindowSize: 120,
      },
      byId(id) {
        if (id === "chatBox") return chatBox;
        return elementById.get(String(id || "")) || null;
      },
      api: async () => ({}),
      nextFrame: async () => {},
      waitMs: async () => {},
      windowRef: {},
      documentRef: {
        createDocumentFragment() {
          return {
            children: [],
            appendChild(node) {
              this.children.push(node);
              return node;
            },
          };
        },
        createElement(tagName) {
          return createFakeElement(tagName);
        },
      },
      performanceRef: { now: () => 0 },
      setTimeoutRef(callback) {
        callback();
        return 1;
      },
      HISTORY_WINDOW_THRESHOLD: 5,
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
      addChat(role, text) { chatBox.appendChild({ role, text }); },
      buildMsgNode(msg) {
        return { role: String(msg?.role || ""), text: String(msg?.text || "") };
      },
      clearChatMessages(options = {}) {
        chatBox.childNodes = [];
        chatBox.scrollTop = 0;
      },
      renderChatFull: async () => {},
      syncEventSubscription() {},
    });

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: true, hasMore: false },
      turns: new Array(90).fill(null).map((_, index) => ({
        id: `turn-${index + 1}`,
        items: [
          { type: "userMessage", content: [{ type: "input_text", text: `hello-${index}` }] },
          { type: "assistantMessage", text: `done-${index}` },
        ],
      })),
    }, { forceHistoryWindow: true });

    expect(chatBox.scrollTop).toBe(420);
  });

  it("deduplicates duplicate turns from authoritative history before rendering chat messages", async () => {
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
        activeThreadStarted: true,
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

    const duplicateTurn = {
      id: "turn-1",
      items: [
        { type: "userMessage", content: [{ type: "input_text", text: "hi" }] },
        { type: "assistantMessage", text: "你好。" },
      ],
    };

    await module.applyThreadToChat({
      id: "thread-1",
      workspace: "windows",
      page: { incomplete: false, hasMore: false },
      turns: [duplicateTurn, duplicateTurn],
    });

    expect(rendered).toEqual([
      { role: "user", text: "hi", kind: "" },
      { role: "assistant", text: "你好。", kind: "" },
    ]);
  });
});
