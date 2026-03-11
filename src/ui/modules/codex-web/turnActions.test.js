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
});
