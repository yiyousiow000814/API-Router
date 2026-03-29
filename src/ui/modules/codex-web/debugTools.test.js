import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectPendingLiveTraceEvents,
  createDebugToolsModule,
  detectPlanInterruptCleanupAnomaly,
  hasQueryFlag,
  readDebugMessageNode,
} from "./debugTools.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("debugTools", () => {
  it("detects query flags", () => {
    expect(hasQueryFlag("?e2e=1", "e2e")).toBe(true);
    expect(hasQueryFlag("?e2e=0", "e2e")).toBe(false);
  });

  it("reads message debug snapshots", () => {
    const body = {
      textContent: "abc",
      innerHTML:
        '<code class="msgInlineCode">a</code><span class="msgPseudoLink">b</span><a class="msgLink" href="/x">c</a>',
      querySelectorAll(selector) {
        if (selector === "code.msgInlineCode") return [{ textContent: "a" }];
        if (selector === ".msgPseudoLink") return [{ textContent: "b" }];
        if (selector === "a.msgLink") {
          return [
            {
              textContent: "c",
              getAttribute(name) {
                return name === "href" ? "/x" : "";
              },
            },
          ];
        }
        return [];
      },
    };
    const node = {
      className: "msg assistant",
      __webCodexRole: "assistant",
      __webCodexKind: "tool",
      __webCodexSource: "live",
      __webCodexRawText: "hello",
      querySelector(selector) {
        if (selector === ".msgBody") return body;
        if (selector === ".msgHead") return { textContent: "Codex" };
        return null;
      },
    };
    const info = readDebugMessageNode(node, 2);
    expect(info.index).toBe(2);
    expect(info.role).toBe("assistant");
    expect(info.inline).toEqual(["a"]);
    expect(info.pseudo).toEqual(["b"]);
    expect(info.links).toEqual([{ text: "c", href: "/x" }]);
  });

  it("collects only unsent live trace events", () => {
    const state = {
      liveDebugEvents: [
        { at: 1, kind: "a", __traceUploaded: true },
        { at: 2, kind: "b" },
        { at: 3, kind: "c" },
      ],
    };
    expect(collectPendingLiveTraceEvents(state, 1)).toEqual([{ at: 2, kind: "b" }]);
    expect(collectPendingLiveTraceEvents(state, 5)).toEqual([
      { at: 2, kind: "b" },
      { at: 3, kind: "c" },
    ]);
  });

  it("detects stale plan interrupt cleanup residue", () => {
    expect(
      detectPlanInterruptCleanupAnomaly({
        active: {
          activeThreadPendingTurnRunning: false,
          activeThreadPendingAssistantMessage: "working",
          statusLine: "Stopping current turn...",
        },
        pendingUi: {
          pendingMount: { visible: true, text: "Question 1/3 Type your answer" },
          commentaryArchive: { visible: true },
          runtimePanels: { visible: false },
        },
      })
    ).toEqual({
      anomalous: true,
      reasons: [
        "pending-inline-visible",
        "commentary-visible",
        "status-line-stale",
        "pending-assistant-stale",
        "pending-inline-question-stale",
      ],
    });
  });

  it("auto-uploads a persistent plan interrupt cleanup anomaly", async () => {
    vi.useFakeTimers();
    const fetchCalls = [];
    const windowRef = {
      location: { search: "", pathname: "/codex-web" },
      fetch: vi.fn(async (_url, init = {}) => {
        fetchCalls.push(JSON.parse(String(init.body || "{}")));
        return {
          ok: true,
          json: async () => ({ ok: true, accepted: 1 }),
        };
      }),
      addEventListener() {},
      dispatchEvent() {},
    };
    const pendingMount = { textContent: "Question 1/1 Type your answer" };
    const commentaryMount = { textContent: "stale commentary" };
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadPendingAssistantMessage: "working",
      liveDebugEvents: [
        { at: 123, kind: "turn.interrupt:cleared", threadId: "thread-1", turnId: "turn-1" },
      ],
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return value === "wsl2" ? "wsl2" : "windows"; },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      getStartCwdForWorkspace() { return ""; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll(selector) {
          if (selector === "#chatBox .msg") return [];
          if (selector === "#chatBox > *") return [commentaryMount, pendingMount];
          return [];
        },
        getElementById(id) {
          if (id === "statusLine") return { textContent: "working..." };
          if (id === "pendingInlineMount") return pendingMount;
          if (id === "commentaryArchiveMount") return commentaryMount;
          if (id === "runtimeChatPanels") return null;
          return null;
        },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installDebugAndE2E();
    await vi.advanceTimersByTimeAsync(6000);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.events?.[0]?.kind).toBe("plan.interrupt:cleanup_anomaly");
    expect(fetchCalls[0]?.events?.[0]?.threadId).toBe("thread-1");
    expect(fetchCalls[0]?.events?.[0]?.reasons).toContain("commentary-visible");
    expect(fetchCalls[0]?.events?.[0]?.reasons).toContain("status-line-stale");
    expect(windowRef.__webCodexDebug?.getLastAutoPlanInterruptReport?.()?.kind).toBe(
      "plan.interrupt:cleanup_anomaly"
    );
  });

  it("also auto-uploads a cleanup anomaly after terminal-side turn cancellation", async () => {
    vi.useFakeTimers();
    const fetchCalls = [];
    const windowRef = {
      location: { search: "", pathname: "/codex-web" },
      fetch: vi.fn(async (_url, init = {}) => {
        fetchCalls.push(JSON.parse(String(init.body || "{}")));
        return {
          ok: true,
          json: async () => ({ ok: true, accepted: 1 }),
        };
      }),
      addEventListener() {},
      dispatchEvent() {},
    };
    const pendingMount = { textContent: "Question 1/1 Type your answer" };
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadPendingAssistantMessage: "",
      liveDebugEvents: [
        {
          at: 456,
          kind: "live.render:turn_terminal",
          method: "turn/cancelled",
          threadId: "thread-1",
        },
      ],
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return value === "wsl2" ? "wsl2" : "windows"; },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      getStartCwdForWorkspace() { return ""; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll(selector) {
          if (selector === "#chatBox .msg") return [];
          if (selector === "#chatBox > *") return [pendingMount];
          return [];
        },
        getElementById(id) {
          if (id === "statusLine") return { textContent: "" };
          if (id === "pendingInlineMount") return pendingMount;
          if (id === "commentaryArchiveMount") return null;
          if (id === "runtimeChatPanels") return null;
          return null;
        },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installDebugAndE2E();
    await vi.advanceTimersByTimeAsync(6000);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.events?.[0]?.kind).toBe("plan.interrupt:cleanup_anomaly");
    expect(fetchCalls[0]?.events?.[0]?.threadId).toBe("thread-1");
    expect(fetchCalls[0]?.events?.[0]?.reasons).toContain("pending-inline-visible");
  });

  it("exposes thread list snapshot in debug hooks", () => {
    const windowRef = {};
    const state = {
      threadItemsAll: [
        { id: "t1", title: "One", cwd: "C:\\Users\\yiyou\\API-Router", workspace: "windows" },
        { id: "t2", title: "Two", cwd: "C:\\Users\\yiyou\\XAUUSD-Calendar-Agent", workspace: "windows" },
      ],
      threadItems: [
        { id: "t2", title: "Two", cwd: "C:\\Users\\yiyou\\XAUUSD-Calendar-Agent", workspace: "windows" },
      ],
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return value === "wsl2" ? "wsl2" : "windows"; },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      getStartCwdForWorkspace() { return ""; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll() { return []; },
        getElementById() { return { textContent: "" }; },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    const before = windowRef.__webCodexDebug?.getThreadListSnapshot();
    expect(before).toMatchObject({
      workspaceTarget: "windows",
      startCwd: "",
      allCount: 2,
      visibleCount: 1,
    });
    expect(before?.visibleItems?.[0]).toMatchObject({
      id: "t2",
      cwd: "C:\\Users\\yiyou\\XAUUSD-Calendar-Agent",
    });
  });

  it("uses history fallback events for live pipeline snapshot when rpc notifications are missing", () => {
    const windowRef = {};
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "C:\\rollout.jsonl",
      activeThreadRenderSig: "sig",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      wsSubscribedEvents: true,
      ws: { readyState: 1 },
      liveDebugEvents: [
        { at: 1, kind: "history.load", threadId: "thread-1" },
        { at: 2, kind: "history.receive", threadId: "thread-1", messages: 3 },
        { at: 3, kind: "history.render:append", threadId: "thread-1", appended: 2 },
      ],
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return String(value || "windows"); },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll() { return []; },
        getElementById() { return { textContent: "" }; },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    const snapshot = windowRef.__webCodexDebug
      ? windowRef.__webCodexDebug.getLivePipelineSnapshot()
      : null;
    expect(snapshot?.lastReceived?.kind).toBe("history.receive");
    expect(snapshot?.lastRender?.kind).toBe("history.render:append");
  });

  it("treats rpc turn lifecycle notifications as last turn activity", () => {
    const windowRef = {};
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "C:\\rollout.jsonl",
      activeThreadRenderSig: "sig",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      wsSubscribedEvents: true,
      ws: { readyState: 1 },
      liveDebugEvents: [
        { at: 1, kind: "rpc.notification", method: "turn/started", threadId: "thread-1" },
        { at: 2, kind: "rpc.notification", method: "turn/assistant/delta", threadId: "thread-1" },
      ],
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return String(value || "windows"); },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll() { return []; },
        getElementById() { return { textContent: "" }; },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    const snapshot = windowRef.__webCodexDebug
      ? windowRef.__webCodexDebug.getLivePipelineSnapshot()
      : null;
    expect(snapshot?.lastTurn?.kind).toBe("rpc.notification");
    expect(snapshot?.lastTurn?.method).toBe("turn/started");
  });

  it("captures commentary diagnostics in the live pipeline snapshot", () => {
    const windowRef = {};
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "C:\\rollout.jsonl",
      activeThreadRenderSig: "sig",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadTransientThinkingText: "thinking block two",
      activeThreadTransientToolText: "Running `npm test`",
      activeThreadCommentaryCurrent: {
        key: "commentary-2",
        text: "thinking block two",
        tools: ["Running `npm test`"],
      },
      activeThreadCommentaryArchive: [{ key: "commentary-1", text: "thinking block one", tools: [] }],
      activeThreadCommentaryArchiveVisible: true,
      activeThreadCommentaryArchiveExpanded: false,
      wsSubscribedEvents: true,
      ws: { readyState: 1 },
      liveDebugEvents: [
        {
          at: 1,
          kind: "live.inspect:item_candidate",
          method: "codex/event/agent_message",
          threadId: "thread-1",
          paramsSource: "params",
          itemSource: "params.payload",
          itemType: "agent_message",
          itemId: "commentary-2",
          phase: "commentary",
        },
        {
          at: 2,
          kind: "live.inspect:assistant_candidate",
          method: "codex/event/agent_message",
          threadId: "thread-1",
          itemId: "commentary-2",
          phase: "commentary",
          mode: "snapshot",
          visible: false,
          preview: "thinking block two",
        },
        {
          at: 3,
          kind: "live.inspect:commentary_state",
          threadId: "thread-1",
          action: "update",
          key: "commentary-2",
          chars: 18,
          toolCount: 1,
          archiveCount: 1,
          preview: "thinking block two",
        },
      ],
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return String(value || "windows"); },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll() { return []; },
        getElementById() { return { textContent: "" }; },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    const snapshot = windowRef.__webCodexDebug
      ? windowRef.__webCodexDebug.getLivePipelineSnapshot()
      : null;

    expect(snapshot?.commentary.currentKey).toBe("commentary-2");
    expect(snapshot?.commentary.currentToolCount).toBe(1);
    expect(snapshot?.commentary.archiveCount).toBe(1);
    expect(snapshot?.commentary.lastItemCandidate?.itemSource).toBe("params.payload");
    expect(snapshot?.commentary.lastAssistantCandidate?.phase).toBe("commentary");
    expect(snapshot?.commentary.lastState?.action).toBe("update");
  });

  it("exports plan interrupt diagnostics with pending ui snapshot and chat order", () => {
    const pendingMount = { id: "pendingInlineMount", textContent: "Question 1/1", className: "msg system kind-pending" };
    const runtimePanels = { id: "runtimeChatPanels", textContent: "", className: "runtimeChatPanels" };
    const commentaryMount = { id: "commentaryArchiveMount", textContent: "", className: "commentaryArchiveMount" };
    const chatBox = {
      children: [commentaryMount, runtimePanels, pendingMount],
    };
    const windowRef = {};
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "C:\\rollout.jsonl",
      activeThreadRenderSig: "sig",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadHistoryStatusType: "interrupted",
      pendingApprovals: [],
      pendingUserInputs: [{ id: "real-1", threadId: "thread-1" }],
      syntheticPendingUserInputsByThreadId: {
        "thread-1": [{ id: "synthetic-1", prompt: "Where?" }],
      },
      suppressedSyntheticPendingUserInputsByThreadId: {},
      liveDebugEvents: [{ at: 1, kind: "turn.interrupt:request", threadId: "thread-1" }],
      wsSubscribedEvents: true,
      ws: { readyState: 1 },
    };
    const module = createDebugToolsModule({
      state,
      byId(id) {
        if (id === "chatBox") return chatBox;
        if (id === "pendingInlineMount") return pendingMount;
        if (id === "runtimeChatPanels") return runtimePanels;
        if (id === "commentaryArchiveMount") return commentaryMount;
        return null;
      },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return String(value || "windows"); },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      getVisiblePendingUserInputs() {
        return [{ id: "visible-1", threadId: "thread-1" }];
      },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll(selector) {
          if (selector === "#chatBox .msg") return [commentaryMount, pendingMount];
          return [];
        },
        getElementById(id) {
          if (id === "chatBox") return chatBox;
          if (id === "pendingInlineMount") return pendingMount;
          if (id === "runtimeChatPanels") return runtimePanels;
          if (id === "commentaryArchiveMount") return commentaryMount;
          if (id === "statusLine") return { textContent: "Stopping current turn..." };
          return null;
        },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    const diagnostics = windowRef.__webCodexDebug?.getPlanInterruptDiagnostics?.(20);
    const exported = windowRef.__webCodexDebug?.exportPlanInterruptDiagnostics?.(20);
    const parsed = JSON.parse(exported);

    expect(diagnostics?.pendingUi?.historyStatusType).toBe("interrupted");
    expect(diagnostics?.pendingUi?.visibleUserInputIds).toEqual(["visible-1"]);
    expect(diagnostics?.pendingUi?.pendingMount?.index).toBe(2);
    expect(diagnostics?.pendingUi?.runtimePanels?.index).toBe(1);
    expect(diagnostics?.pendingUi?.chatOrder?.map((item) => item.id)).toEqual([
      "commentaryArchiveMount",
      "runtimeChatPanels",
      "pendingInlineMount",
    ]);
    expect(parsed.pendingUi.pendingMount.text).toContain("Question 1/1");
    expect(parsed.recentEvents[0].kind).toBe("turn.interrupt:request");
  });

  it("toggles an Updated Plan card through the debug hook", () => {
    const windowRef = {};
    const setActivePlanCalls = [];
    const setRuntimeActivityCalls = [];
    const setActiveCommandsCalls = [];
    const setMainTabCalls = [];
    const setMobileTabCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadPlan: null,
      ws: { readyState: 1 },
      liveDebugEvents: [],
      wsSubscribedEvents: true,
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return String(value || "windows"); },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab(value) { setMainTabCalls.push(value); },
      setMobileTab(value) { setMobileTabCalls.push(value); },
      setActiveThread() {},
      setActivePlan(payload) {
        state.activeThreadPlan = payload;
        setActivePlanCalls.push(payload);
      },
      setActiveCommands(payload) { setActiveCommandsCalls.push(payload); },
      setRuntimeActivity(payload) { setRuntimeActivityCalls.push(payload); },
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll() { return []; },
        getElementById() { return { textContent: "" }; },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    const result = windowRef.__webCodexDebug?.previewUpdatedPlan?.();
    const closeResult = windowRef.__webCodexDebug?.previewUpdatedPlan?.();

    expect(result).toEqual({ ok: true, threadId: "thread-1", open: true });
    expect(closeResult).toEqual({ ok: true, threadId: "thread-1", open: false });
    expect(setMainTabCalls).toEqual(["chat", "chat"]);
    expect(setMobileTabCalls).toEqual(["chat", "chat"]);
    expect(setActiveCommandsCalls).toEqual([[]]);
    expect(setActivePlanCalls[0]?.title).toBe("Updated Plan");
    expect(setActivePlanCalls[0]?.steps?.length).toBe(3);
    expect(setActivePlanCalls[1]).toBe(null);
    expect(setRuntimeActivityCalls[0]?.title).toBe("Updated Plan");
    expect(setRuntimeActivityCalls[0]?.tone).toBe("running");
    expect(setRuntimeActivityCalls[1]).toBe(null);
  });

  it("opens and closes the pending preview", () => {
    const setMainTabCalls = [];
    const setMobileTabCalls = [];
    const renderPendingListsCalls = [];
    const renderPendingInlineCalls = [];
    const windowRef = {
      location: { search: "" },
      addEventListener() {},
      dispatchEvent() {},
    };
    const state = {
      activeThreadId: "thread-1",
      pendingApprovals: [],
      pendingUserInputs: [],
      pendingUserInputAnswersById: {},
      selectedPendingApprovalId: "",
      selectedPendingUserInputId: "",
      liveDebugEvents: [],
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      addChat() {},
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return value; },
      detectThreadWorkspaceTarget() { return "windows"; },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderRuntimePanels() {},
      renderCommentaryArchive() {},
      renderPendingLists() { renderPendingListsCalls.push("lists"); },
      renderPendingInline() { renderPendingInlineCalls.push("inline"); },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      getStartCwdForWorkspace() { return ""; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab(value) { setMainTabCalls.push(value); },
      setMobileTab(value) { setMobileTabCalls.push(value); },
      setActiveThread() {},
      setActivePlan() {},
      setActiveCommands() {},
      setRuntimeActivity() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll() { return []; },
        getElementById() { return null; },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    const result = windowRef.__webCodexDebug?.previewPending?.();
    const closeResult = windowRef.__webCodexDebug?.previewPending?.();

    expect(result).toEqual({ ok: true, open: true });
    expect(closeResult).toEqual({ ok: true, open: false });
    expect(setMainTabCalls).toEqual(["chat", "chat"]);
    expect(setMobileTabCalls).toEqual(["chat", "chat"]);
    expect(renderPendingListsCalls).toEqual(["lists", "lists"]);
    expect(renderPendingInlineCalls).toEqual(["inline", "inline"]);
  });

  it("opens e2e threads with resolved workspace metadata instead of stale active state", async () => {
    const windowRef = {
      location: { search: "?e2e=1" },
      setInterval() { return 1; },
      clearInterval() {},
      addEventListener() {},
    };
    const loadCalls = [];
    const state = {
      activeThreadId: "win-thread",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "C:\\sessions\\win.jsonl",
      threadItemsAll: [
        {
          id: "wsl-thread",
          title: "WSL thread",
          cwd: "/home/yiyou/project",
          workspace: "wsl2",
          path: "/home/yiyou/.codex/sessions/wsl-thread.jsonl",
        },
      ],
      threadItemsByWorkspace: {
        windows: [],
        wsl2: [
          {
            id: "wsl-thread",
            cwd: "/home/yiyou/project",
            workspace: "wsl2",
            path: "/home/yiyou/.codex/sessions/wsl-thread.jsonl",
          },
        ],
      },
      ws: { readyState: 1 },
      liveDebugEvents: [],
      wsSubscribedEvents: true,
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return value === "wsl2" ? "wsl2" : "windows"; },
      detectThreadWorkspaceTarget(thread) {
        return String(thread?.workspace || "").trim() === "wsl2" ? "wsl2" : "windows";
      },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      getStartCwdForWorkspace() { return ""; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread(value) { state.activeThreadId = value; },
      setChatOpening() {},
      loadThreadMessages: async (threadId, options) => {
        loadCalls.push({ threadId, options });
      },
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll() { return []; },
        getElementById() { return { textContent: "" }; },
      },
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installDebugAndE2E();
    const result = await windowRef.__webCodexE2E.openThread("wsl-thread");

    expect(result).toEqual({
      ok: true,
      workspace: "wsl2",
      rolloutPath: "/home/yiyou/.codex/sessions/wsl-thread.jsonl",
    });
    expect(state.activeThreadWorkspace).toBe("wsl2");
    expect(state.activeThreadRolloutPath).toBe("/home/yiyou/.codex/sessions/wsl-thread.jsonl");
    expect(loadCalls).toEqual([
      {
        threadId: "wsl-thread",
        options: expect.objectContaining({
          workspace: "wsl2",
          rolloutPath: "/home/yiyou/.codex/sessions/wsl-thread.jsonl",
          forceRender: true,
        }),
      },
    ]);
  });

  it("refreshes e2e workspace target after hydrating availability", async () => {
    const windowRef = {
      location: { search: "?e2e=1" },
      setInterval() { return 1; },
      clearInterval() {},
      addEventListener() {},
    };
    const refreshCalls = [];
    const setWorkspaceTargetCalls = [];
    const state = {
      workspaceTarget: "windows",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: false },
      threadItemsByWorkspace: { windows: [], wsl2: [] },
      ws: { readyState: 1 },
      liveDebugEvents: [],
      wsSubscribedEvents: true,
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return value === "wsl2" ? "wsl2" : "windows"; },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return state.workspaceTarget; },
      getStartCwdForWorkspace() { return ""; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async (target, options) => {
        refreshCalls.push({ target, options });
        state.workspaceAvailability.wsl2Installed = true;
      },
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        querySelectorAll() { return []; },
        getElementById() { return { textContent: "" }; },
      },
      windowRef,
      performanceRef: { now: () => 0 },
      setWorkspaceTarget: async (target) => {
        setWorkspaceTargetCalls.push(target);
        if (state.workspaceAvailability.wsl2Installed) state.workspaceTarget = target;
      },
    });

    module.installDebugAndE2E();
    const result = await windowRef.__webCodexE2E.setWorkspaceTarget("wsl2");

    expect(result).toEqual({ ok: true, target: "wsl2" });
    expect(refreshCalls).toEqual([
      { target: "wsl2", options: { force: true, silent: true } },
    ]);
    expect(setWorkspaceTargetCalls).toEqual(["wsl2"]);
    expect(state.workspaceTarget).toBe("wsl2");
  });

  it("does not install live trace background sync unless debug live mode is enabled", () => {
    let intervalCalls = 0;
    const windowRef = {
      fetch: async () => ({
        ok: true,
        json: async () => ({ backend: { recent: [] }, app: { homes: [], recent: [] } }),
      }),
      setInterval() {
        intervalCalls += 1;
        return intervalCalls;
      },
      clearInterval() {},
      addEventListener() {},
      location: { search: "" },
      __webCodexDebug: null,
      __webCodexE2E: null,
    };
    const storage = {
      getItem() { return ""; },
      setItem() {},
      removeItem() {},
    };
    const module = createDebugToolsModule({
      state: { liveDebugEvents: [] },
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return value === "wsl2" ? "wsl2" : "windows"; },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      getStartCwdForWorkspace() { return ""; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef: {
        body: { appendChild() {} },
        querySelectorAll() { return []; },
        getElementById() { return null; },
      },
      windowRef,
      localStorageRef: storage,
      storage,
      performanceRef: { now: () => 0 },
    });

    module.installDebugAndE2E();

    expect(intervalCalls).toBe(1);
  });

  it("renders live inspector with a single title and top edge resize affordance", () => {
    const appended = [];
    const windowRef = {
      fetch: async () => ({
        ok: true,
        json: async () => ({ backend: { recent: [] }, app: { homes: [], recent: [] } }),
      }),
      setInterval() {
        return 1;
      },
      clearInterval() {},
      location: { search: "" },
    };
    const documentRef = {
      body: {
        appendChild(node) {
          appended.push(node);
          node.isConnected = true;
        },
      },
      querySelectorAll() {
        return [];
      },
      getElementById(id) {
        return appended.find((node) => node.id === id) || null;
      },
      createElement(tag) {
        const listeners = new Map();
        return {
          tagName: String(tag || "").toUpperCase(),
          style: {},
          children: [],
          isConnected: false,
          textContent: "",
          setAttribute() {},
          appendChild(child) {
            this.children.push(child);
            child.parentNode = this;
          },
          addEventListener(type, handler) {
            listeners.set(type, handler);
          },
          __listeners: listeners,
          remove() {
            this.isConnected = false;
          },
        };
      },
    };
    const state = {
      ws: { readyState: 1 },
      liveDebugEvents: [],
      wsSubscribedEvents: true,
    };
    const module = createDebugToolsModule({
      state,
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return String(value || "windows"); },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef,
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    windowRef.__webCodexDebug.toggleLiveInspector(true);

    const node = appended.find((entry) => entry.id === "webCodexLiveInspector");
    expect(node).toBeTruthy();
    expect(node.style.maxHeight).toBe("calc(100vh - 12px)");
    expect(node.style.overflow).toBe("hidden");
    expect(node.style.resize).toBe("none");
    const body = node.__webCodexLiveInspectorBody;
    expect(body).toBeTruthy();
    expect(body.style.overflowY).toBe("auto");
    expect(body.style.whiteSpace).toBe("pre-wrap");
    expect(String(body.textContent || "")).not.toMatch(/^LIVE PIPELINE\b/);
    const grip = node.__webCodexLiveInspectorGrip;
    expect(grip).toBeTruthy();
    expect(grip.style.cursor).toBe("ns-resize");
    expect(grip.style.height).toBe("6px");
    expect(grip.style.position).toBe("absolute");
    expect(grip.style.top).toBe("-3px");
    expect(grip.style.left).toBe("0");
    expect(grip.style.right).toBe("0");
    expect(grip.style.background).toBe("transparent");
  });

  it("renders commentary diagnostics in the live inspector body", () => {
    const appended = [];
    const windowRef = {
      fetch: async () => ({
        ok: true,
        json: async () => ({ backend: { recent: [] }, app: { homes: [], recent: [] } }),
      }),
      setInterval() {
        return 1;
      },
      clearInterval() {},
      location: { search: "" },
      dispatchEvent() {},
      addEventListener() {},
      removeEventListener() {},
    };
    const documentRef = {
      body: {
        appendChild(node) {
          appended.push(node);
          node.isConnected = true;
        },
      },
      querySelectorAll() {
        return [];
      },
      getElementById(id) {
        return appended.find((node) => node.id === id) || null;
      },
      createElement(tag) {
        const listeners = new Map();
        return {
          tagName: String(tag || "").toUpperCase(),
          style: {},
          children: [],
          isConnected: false,
          textContent: "",
          setAttribute() {},
          appendChild(child) {
            this.children.push(child);
            child.parentNode = this;
          },
          addEventListener(type, handler) {
            listeners.set(type, handler);
          },
          __listeners: listeners,
          remove() {
            this.isConnected = false;
          },
        };
      },
    };
    const module = createDebugToolsModule({
      state: {
        activeThreadId: "thread-1",
        activeThreadWorkspace: "windows",
        activeThreadRolloutPath: "C:\\rollout.jsonl",
        activeThreadRenderSig: "sig",
        activeThreadPendingTurnThreadId: "",
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadTransientThinkingText: "thinking block two",
        activeThreadTransientToolText: "Running `npm test`",
        activeThreadCommentaryCurrent: {
          key: "commentary-2",
          text: "thinking block two",
          tools: ["Running `npm test`"],
        },
        activeThreadCommentaryArchive: [{ key: "commentary-1", text: "thinking block one", tools: [] }],
        activeThreadCommentaryArchiveVisible: true,
        activeThreadCommentaryArchiveExpanded: false,
        ws: { readyState: 1 },
        liveDebugEvents: [
          {
            at: 2,
            kind: "live.inspect:assistant_candidate",
            method: "codex/event/agent_message",
            threadId: "thread-1",
            phase: "commentary",
            mode: "snapshot",
            visible: false,
            preview: "thinking block two",
          },
          {
            at: 3,
            kind: "live.inspect:commentary_state",
            threadId: "thread-1",
            action: "update",
            key: "commentary-2",
            chars: 18,
            toolCount: 1,
            archiveCount: 1,
          },
        ],
        wsSubscribedEvents: true,
      },
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return String(value || "windows"); },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef,
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    windowRef.__webCodexDebug.toggleLiveInspector(true);

    const node = appended.find((entry) => entry.id === "webCodexLiveInspector");
    const body = node.__webCodexLiveInspectorBody;
    expect(String(body.textContent || "")).toContain("COMMENTARY");
    expect(String(body.textContent || "")).toContain("current: key=commentary-2");
    expect(String(body.textContent || "")).toContain("last assistant candidate:");
  });

  it("collapses inspector without leaving a tall empty shell", () => {
    const appended = [];
    const windowRef = {
      fetch: async () => ({
        ok: true,
        json: async () => ({ backend: { recent: [] }, app: { homes: [], recent: [] } }),
      }),
      setInterval() {
        return 1;
      },
      clearInterval() {},
      location: { search: "" },
      dispatchEvent() {},
      addEventListener() {},
      removeEventListener() {},
    };
    const documentRef = {
      body: {
        appendChild(node) {
          appended.push(node);
          node.isConnected = true;
        },
      },
      querySelectorAll() {
        return [];
      },
      getElementById(id) {
        return appended.find((node) => node.id === id) || null;
      },
      createElement(tag) {
        const listeners = new Map();
        return {
          tagName: String(tag || "").toUpperCase(),
          style: {},
          children: [],
          isConnected: false,
          textContent: "",
          setAttribute() {},
          appendChild(child) {
            this.children.push(child);
            child.parentNode = this;
          },
          addEventListener(type, handler) {
            listeners.set(type, handler);
          },
          __listeners: listeners,
          remove() {
            this.isConnected = false;
          },
        };
      },
    };
    const module = createDebugToolsModule({
      state: { ws: { readyState: 1 }, liveDebugEvents: [], wsSubscribedEvents: true },
      byId() { return null; },
      renderInlineMessageText(value) { return String(value || ""); },
      findNextInlineCodeSpan() { return null; },
      normalizeWorkspaceTarget(value) { return String(value || "windows"); },
      normalizeModelOption(value) { return value; },
      ensureArrayItems(value) { return Array.isArray(value) ? value : []; },
      pickLatestModelId() { return ""; },
      REASONING_EFFORT_KEY: "reasoning",
      MODEL_LOADING_MIN_MS: 0,
      normalizeThreadTokenUsage(value) { return value; },
      renderComposerContextLeft() {},
      clearChatMessages() {},
      showWelcomeCard() {},
      updateHeaderUi() {},
      getWorkspaceTarget() { return "windows"; },
      parseUserMessageParts() { return { text: "", images: [] }; },
      renderMessageAttachments() { return ""; },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      loadThreadMessages: async () => {},
      refreshThreads: async () => {},
      handleWsPayload() {},
      scrollChatToBottom() {},
      scrollToBottomReliable() {},
      createAssistantStreamingMessage() { return { msg: null, body: null }; },
      appendStreamingDelta() {},
      setStatus() {},
      isThreadAnimDebugEnabled() { return false; },
      pushThreadAnimDebug() {},
      threadAnimDebug: { enabled: false, events: [], seq: 0 },
      WEB_CODEX_DEV_DEBUG_VERSION: "test",
      documentRef,
      windowRef,
      performanceRef: { now: () => 0 },
    });

    module.installWebCodexDebug();
    windowRef.__webCodexDebug.toggleLiveInspector(true);
    const node = appended.find((entry) => entry.id === "webCodexLiveInspector");
    node.style.height = "520px";
    const collapseBtn = node.__webCodexLiveInspectorCollapseBtn;
    collapseBtn.__listeners.get("click")();
    expect(node.style.height).toBe("");
    expect(node.style.minHeight).toBe("0");
    expect(node.__webCodexLiveInspectorBody.style.display).toBe("none");
    collapseBtn.__listeners.get("click")();
    expect(node.style.height).toBe("520px");
    expect(node.__webCodexLiveInspectorBody.style.display).toBe("block");
  });
});
