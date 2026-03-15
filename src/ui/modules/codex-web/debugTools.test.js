import { describe, expect, it } from "vitest";

import {
  collectPendingLiveTraceEvents,
  createDebugToolsModule,
  hasQueryFlag,
  readDebugMessageNode,
} from "./debugTools.js";

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
