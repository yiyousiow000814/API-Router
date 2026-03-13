import { describe, expect, it } from "vitest";

import { buildTurnPayload, createTurnActionsModule } from "./turnActions.js";

describe("turnActions", () => {
  it("builds payload for new threads with cwd and model info", () => {
    expect(
      buildTurnPayload({
        activeThreadId: "",
        prompt: "hello",
        workspace: "wsl2",
        startCwd: "C:\\repo",
        shouldSendStartCwd: true,
        selectedModel: "gpt-5",
        selectedReasoningEffort: "medium",
      })
    ).toEqual({
      threadId: "",
      prompt: "hello",
      workspace: "wsl2",
      cwd: "C:\\repo",
      model: "gpt-5",
      reasoningEffort: "medium",
    });
  });

  it("omits cwd for existing threads", () => {
    expect(
      buildTurnPayload({
        activeThreadId: "thread-1",
        prompt: "hello",
        workspace: "windows",
        startCwd: "C:\\repo",
        shouldSendStartCwd: false,
        selectedModel: "",
        selectedReasoningEffort: "",
      })
    ).toEqual({
      threadId: "thread-1",
      prompt: "hello",
      workspace: "windows",
      cwd: undefined,
      model: undefined,
      reasoningEffort: undefined,
    });
  });

  it("resumes reopened threads before starting a turn", async () => {
    const calls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadNeedsResume: true,
      activeThreadStarted: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET", body: options.body || null });
        if (String(path).startsWith("/codex/threads/thread-1/resume")) {
          return { threadId: "thread-1" };
        }
        if (path === "/codex/turns/start") {
          return { threadId: "thread-1" };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "hello",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {},
      renderComposerContextLeft: () => {},
      scrollToBottomReliable: () => {},
      scheduleChatLiveFollow: () => {},
      createAssistantStreamingMessage: () => ({ msg: null, body: null }),
      appendStreamingDelta: () => {},
      finalizeAssistantMessage: () => {},
      normalizeTextPayload: (value) => value,
      maybeNotifyTurnDone: () => {},
      renderAttachmentPills: () => {},
      refreshThreads: async () => {},
      refreshHosts: async () => {},
      refreshPending: async () => {},
      setStatus: () => {},
      setActiveThread: (id) => {
        state.activeThreadId = id;
      },
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(calls).toEqual([
      {
        path: "/codex/threads/thread-1/resume?workspace=windows&rolloutPath=C%3A%5Crepo%5C.codex%5Csessions%5Crollout.jsonl",
        method: "POST",
        body: null,
      },
      {
        path: "/codex/turns/start",
        method: "POST",
        body: {
          threadId: "thread-1",
          prompt: "hello",
          workspace: "windows",
          cwd: undefined,
          model: undefined,
          reasoningEffort: undefined,
        },
      },
    ]);
    expect(state.activeThreadNeedsResume).toBe(false);
  });

  it("shows the pending Working placeholder before waiting on thread resume state", async () => {
    let releasePendingResume = null;
    const waitPendingThreadResume = new Promise((resolve) => {
      releasePendingResume = resolve;
    });
    const uiSnapshots = [];
    const calls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadNeedsResume: true,
      activeThreadStarted: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      ws: null,
      activeThreadTransientThinkingText: "stale",
      activeThreadTransientToolText: "Ran `npm test`",
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-stale",
        text: "构建已完成。",
        tools: ["Ran `npm test`"],
      },
      activeThreadCommentaryArchive: [{ key: "old", text: "older", tools: [] }],
      activeThreadCommentaryArchiveVisible: true,
      activeThreadCommentaryArchiveExpanded: true,
      activeThreadActivity: { threadId: "thread-1", title: "Thinking", detail: "stale", tone: "running" },
      activeThreadActiveCommands: [{ key: "cmd-1", text: "Ran `npm test`", state: "complete" }],
      activeThreadPlan: { threadId: "thread-1", title: "Updated Plan", explanation: "old", steps: [] },
      activeThreadLiveAssistantThreadId: "thread-1",
      activeThreadLiveAssistantIndex: 1,
      activeThreadLiveAssistantMsgNode: {},
      activeThreadLiveAssistantBodyNode: {},
      activeThreadLiveAssistantText: "stale",
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET" });
        if (String(path).startsWith("/codex/threads/thread-1/resume")) return { threadId: "thread-1" };
        if (path === "/codex/turns/start") return { threadId: "thread-1" };
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "hello",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => waitPendingThreadResume,
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {},
      renderComposerContextLeft: () => {},
      scrollToBottomReliable: () => {},
      scheduleChatLiveFollow: () => {},
      createAssistantStreamingMessage: () => ({ msg: null, body: null }),
      appendStreamingDelta: () => {},
      finalizeAssistantMessage: () => {},
      normalizeTextPayload: (value) => value,
      maybeNotifyTurnDone: () => {},
      renderAttachmentPills: () => {},
      refreshThreads: async () => {},
      refreshHosts: async () => {},
      refreshPending: async () => {},
      setStatus: () => {},
      setActiveThread: (id) => {
        state.activeThreadId = id;
      },
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      syncPendingTurnUi: () => {
        uiSnapshots.push({
          pendingThreadId: state.activeThreadPendingTurnThreadId,
          pendingRunning: state.activeThreadPendingTurnRunning,
          pendingUser: state.activeThreadPendingUserMessage,
          commentary: state.activeThreadCommentaryCurrent,
          commands: state.activeThreadActiveCommands.slice(),
        });
      },
      blockInSandbox: () => false,
    });

    const sendPromise = module.sendTurn();
    await Promise.resolve();

    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("hello");
    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(uiSnapshots).toHaveLength(1);
    expect(uiSnapshots[0]).toEqual({
      pendingThreadId: "thread-1",
      pendingRunning: true,
      pendingUser: "hello",
      commentary: null,
      commands: [],
    });
    expect(calls).toEqual([]);

    releasePendingResume();
    await sendPromise;

    expect(state.activeThreadPendingUserMessage).toBe("hello");
    expect(calls.map((call) => call.path)).toEqual([
      "/codex/threads/thread-1/resume?workspace=windows&rolloutPath=C%3A%5Crepo%5C.codex%5Csessions%5Crollout.jsonl",
      "/codex/turns/start",
    ]);
  });

  it("clears the primed Working placeholder when resume fails before the turn starts", async () => {
    const uiSnapshots = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadNeedsResume: true,
      activeThreadStarted: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async () => {
        throw new Error("unexpected api call");
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "hello",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {
        throw new Error("resume failed");
      },
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {},
      renderComposerContextLeft: () => {},
      scrollToBottomReliable: () => {},
      scheduleChatLiveFollow: () => {},
      createAssistantStreamingMessage: () => ({ msg: null, body: null }),
      appendStreamingDelta: () => {},
      finalizeAssistantMessage: () => {},
      normalizeTextPayload: (value) => value,
      maybeNotifyTurnDone: () => {},
      renderAttachmentPills: () => {},
      refreshThreads: async () => {},
      refreshHosts: async () => {},
      refreshPending: async () => {},
      setStatus: () => {},
      setActiveThread: (id) => {
        state.activeThreadId = id;
      },
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      syncPendingTurnUi: () => {
        uiSnapshots.push({
          pendingThreadId: state.activeThreadPendingTurnThreadId,
          pendingRunning: state.activeThreadPendingTurnRunning,
          pendingUser: state.activeThreadPendingUserMessage,
        });
      },
      blockInSandbox: () => false,
    });

    await expect(module.sendTurn()).rejects.toThrow("resume failed");

    expect(uiSnapshots).toEqual([
      {
        pendingThreadId: "thread-1",
        pendingRunning: true,
        pendingUser: "hello",
      },
      {
        pendingThreadId: "",
        pendingRunning: false,
        pendingUser: "",
      },
    ]);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("");
  });

  it("stores rolloutPath from newly created threads", async () => {
    const state = {
      activeThreadId: "",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: false,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      ws: null,
      activeThreadTokenUsage: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path) => {
        if (path === "/codex/threads") {
          return {
            thread: {
              id: "thread-new",
              path: "C:\\repo\\.codex\\sessions\\rollout-new.jsonl",
            },
          };
        }
        if (path === "/codex/threads?workspace=windows") {
          return { items: [] };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "C:\\repo",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {},
      renderComposerContextLeft: () => {},
      scrollToBottomReliable: () => {},
      scheduleChatLiveFollow: () => {},
      createAssistantStreamingMessage: () => ({ msg: null, body: null }),
      appendStreamingDelta: () => {},
      finalizeAssistantMessage: () => {},
      normalizeTextPayload: (value) => value,
      maybeNotifyTurnDone: () => {},
      renderAttachmentPills: () => {},
      refreshThreads: async () => {},
      refreshHosts: async () => {},
      refreshPending: async () => {},
      setStatus: () => {},
      setActiveThread: (id) => {
        state.activeThreadId = id;
      },
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      blockInSandbox: () => false,
    });

    await module.newThread();

    expect(state.activeThreadId).toBe("thread-new");
    expect(state.activeThreadRolloutPath).toBe("C:\\repo\\.codex\\sessions\\rollout-new.jsonl");
  });

  it("keeps rolloutPath when sendTurn creates a new thread", async () => {
    const calls = [];
    const state = {
      activeThreadId: "",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: false,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      ws: null,
      activeThreadTokenUsage: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET", body: options.body || null });
        if (path === "/codex/threads") {
          return {
            thread: {
              id: "thread-live",
              path: "C:\\repo\\.codex\\sessions\\rollout-live.jsonl",
            },
          };
        }
        if (path === "/codex/turns/start") {
          return { threadId: "thread-live" };
        }
        if (path === "/codex/threads?workspace=windows") {
          return { items: [] };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "hello live",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "C:\\repo",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {},
      renderComposerContextLeft: () => {},
      scrollToBottomReliable: () => {},
      scheduleChatLiveFollow: () => {},
      createAssistantStreamingMessage: () => ({ msg: null, body: null }),
      appendStreamingDelta: () => {},
      finalizeAssistantMessage: () => {},
      normalizeTextPayload: (value) => value,
      maybeNotifyTurnDone: () => {},
      renderAttachmentPills: () => {},
      refreshThreads: async () => {},
      refreshHosts: async () => {},
      refreshPending: async () => {},
      setStatus: () => {},
      setActiveThread: (id) => {
        state.activeThreadId = id;
      },
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(state.activeThreadId).toBe("thread-live");
    expect(state.activeThreadRolloutPath).toBe("C:\\repo\\.codex\\sessions\\rollout-live.jsonl");
    expect(calls).toEqual([
      {
        path: "/codex/threads",
        method: "POST",
        body: {
          workspace: "windows",
          cwd: "C:\\repo",
        },
      },
      {
        path: "/codex/turns/start",
        method: "POST",
        body: {
          threadId: "thread-live",
          prompt: "hello live",
          workspace: "windows",
          cwd: undefined,
          model: undefined,
          reasoningEffort: undefined,
        },
      },
    ]);
  });

  it("clears stale live commentary state before starting a new turn", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      ws: null,
      activeThreadTransientThinkingText: "构建已完成。",
      activeThreadTransientToolText: "Ran `npm test`",
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-1",
        text: "构建已完成。",
        tools: ["Ran `npm test`"],
      },
      activeThreadCommentaryArchive: [{ key: "commentary-0", text: "older", tools: [] }],
      activeThreadCommentaryArchiveVisible: true,
      activeThreadCommentaryArchiveExpanded: true,
      activeThreadActivity: { threadId: "thread-1", title: "Thinking", detail: "构建已完成。", tone: "running" },
      activeThreadActiveCommands: [{ key: "cmd-1", text: "Ran `npm test`", state: "complete" }],
      activeThreadPlan: { threadId: "thread-1", title: "Updated Plan", explanation: "old plan", steps: [] },
      activeThreadLiveAssistantThreadId: "thread-1",
      activeThreadLiveAssistantIndex: 3,
      activeThreadLiveAssistantMsgNode: {},
      activeThreadLiveAssistantBodyNode: {},
      activeThreadLiveAssistantText: "stale",
    };
    const uiOps = [];
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path) => {
        if (path === "/codex/turns/start") return { threadId: "thread-1" };
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "new turn",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {},
      renderComposerContextLeft: () => {},
      scrollToBottomReliable: () => {},
      scheduleChatLiveFollow: () => {},
      createAssistantStreamingMessage: () => ({ msg: null, body: null }),
      appendStreamingDelta: () => {},
      finalizeAssistantMessage: () => {},
      normalizeTextPayload: (value) => value,
      maybeNotifyTurnDone: () => {},
      renderAttachmentPills: () => {},
      refreshThreads: async () => {},
      refreshHosts: async () => {},
      refreshPending: async () => {},
      setStatus: () => {},
      setActiveThread: (id) => {
        state.activeThreadId = id;
      },
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      syncPendingTurnUi: () => {
        uiOps.push({
          thinking: state.activeThreadTransientThinkingText,
          current: state.activeThreadCommentaryCurrent,
          archiveVisible: state.activeThreadCommentaryArchiveVisible,
          commands: state.activeThreadActiveCommands,
        });
      },
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadTransientThinkingText).toBe("");
    expect(state.activeThreadTransientToolText).toBe("");
    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchive).toEqual([]);
    expect(state.activeThreadCommentaryArchiveVisible).toBe(false);
    expect(state.activeThreadCommentaryArchiveExpanded).toBe(false);
    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(state.activeThreadPlan).toBeNull();
    expect(state.activeThreadLiveAssistantThreadId).toBe("");
    expect(uiOps).toHaveLength(2);
    expect(uiOps[0]).toEqual({
      thinking: "",
      current: null,
      archiveVisible: false,
      commands: [],
    });
  });
});
