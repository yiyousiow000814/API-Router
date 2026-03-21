import { describe, expect, it } from "vitest";

import {
  buildManagedTerminalUrl,
  buildThreadCreatePayload,
  buildTurnPayload,
  createTurnActionsModule,
} from "./turnActions.js";

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
        planModeEnabled: true,
        fastModeEnabled: true,
        permissionPreset: "/permission full-access",
      })
    ).toEqual({
      threadId: "",
      prompt: "hello",
      workspace: "wsl2",
      cwd: "C:\\repo",
      model: "gpt-5",
      reasoningEffort: "medium",
      collaborationMode: "plan",
      serviceTier: "fast",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
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
        planModeEnabled: false,
        fastModeEnabled: false,
        permissionPreset: "/permission auto",
      })
    ).toEqual({
      threadId: "thread-1",
      prompt: "hello",
      workspace: "windows",
      cwd: undefined,
      model: undefined,
      reasoningEffort: undefined,
      collaborationMode: undefined,
      serviceTier: null,
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    });
  });

  it("maps read-only permission preset to Codex runtime enums", () => {
    expect(
      buildTurnPayload({
        activeThreadId: "thread-1",
        prompt: "hello",
        workspace: "windows",
        startCwd: "",
        shouldSendStartCwd: false,
        selectedModel: "",
        selectedReasoningEffort: "",
        planModeEnabled: false,
        fastModeEnabled: false,
        permissionPreset: "/permission read-only",
      })
    ).toEqual({
      threadId: "thread-1",
      prompt: "hello",
      workspace: "windows",
      cwd: undefined,
      model: undefined,
      reasoningEffort: undefined,
      collaborationMode: undefined,
      serviceTier: null,
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
    });
  });

  it("builds thread create payload from fast mode and permission preset", () => {
    expect(
      buildThreadCreatePayload({
        workspace: "windows",
        startCwd: "C:\\repo",
        fastModeEnabled: false,
        permissionPreset: "/permission read-only",
      })
    ).toEqual({
      workspace: "windows",
      cwd: "C:\\repo",
      serviceTier: null,
      approvalPolicy: "untrusted",
      sandbox: "readOnly",
    });
  });

  it("builds managed terminal url from thread id", () => {
    expect(buildManagedTerminalUrl("thread/one")).toBe(
      "/codex/threads/thread%2Fone/managed-terminal"
    );
  });

  it("opens a managed terminal surface for the active thread", async () => {
    const calls = [];
    const statusCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      activeThreadAttachTransport: "",
      activeThreadAttachPendingUntil: 0,
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      threadItemsAll: [
        {
          id: "thread-1",
          cwd: "C:\\repo",
          workspace: "windows",
        },
      ],
      threadAttachTransportById: new Map(),
      ws: null,
    };
    let headerUpdates = 0;
    let runtimeRefreshes = 0;
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET", body: options.body || null });
        if (path === "/codex/threads/thread-1/managed-terminal") {
          return {
            ok: true,
            threadId: "thread-1",
            attached: true,
            transport: "terminal-session",
            cwd: "C:\\repo",
            path: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
          };
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
      getStartCwdForWorkspace: () => "C:\\fallback",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      refreshWorkspaceRuntimeState: async () => {
        runtimeRefreshes += 1;
        return { connected: true };
      },
      updateHeaderUi: () => {
        headerUpdates += 1;
      },
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
      setStatus: (message, isWarn = false) => {
        statusCalls.push({ message, isWarn });
      },
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    const result = await module.openManagedTerminalSurface();

    expect(result).toEqual({
      ok: true,
      threadId: "thread-1",
      attached: true,
      transport: "terminal-session",
      cwd: "C:\\repo",
      path: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
    });
    expect(calls).toEqual([
      {
        path: "/codex/threads/thread-1/managed-terminal",
        method: "POST",
        body: { workspace: "windows", cwd: "C:\\repo" },
      },
    ]);
    expect(state.activeThreadAttachTransport).toBe("terminal-session");
    expect(state.threadAttachTransportById.get("thread-1")).toBe("terminal-session");
    expect(state.activeThreadAttachPendingUntil).toBe(0);
    expect(runtimeRefreshes).toBe(1);
    expect(headerUpdates).toBeGreaterThanOrEqual(2);
    expect(statusCalls).toContainEqual({
      message: "Terminal linked to this chat.",
      isWarn: false,
    });
  });

  it("executes slash commands through the slash endpoint instead of starting a turn", async () => {
    const calls = [];
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
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    let cleared = 0;
    let hidden = 0;
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET", body: options.body || null });
        if (path === "/codex/slash/execute") {
          return { ok: true, method: "status/read", result: {} };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "/status",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => { cleared += 1; },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => { hidden += 1; },
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(calls).toEqual([
      {
        path: "/codex/slash/execute",
        method: "POST",
        body: {
          command: "/status",
          threadId: "thread-1",
          workspace: "windows",
          serviceTier: null,
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
        },
      },
    ]);
    expect(cleared).toBe(1);
    expect(hidden).toBe(1);
  });

  it("updates plan mode state after executing slash plan on and off", async () => {
    const calls = [];
    const renderCalls = [];
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
      planModeEnabled: false,
      ws: null,
    };
    let currentPrompt = "/plan on";
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET", body: options.body || null });
        if (path === "/codex/slash/execute") {
          throw new Error("plan mode should stay local");
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => currentPrompt,
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
      renderComposerContextLeft: () => { renderCalls.push(state.planModeEnabled); },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();
    expect(state.planModeEnabled).toBe(true);

    currentPrompt = "/plan off";
    await module.sendTurn();
    expect(state.planModeEnabled).toBe(false);
    expect(renderCalls).toEqual([true, false]);
    expect(calls).toEqual([]);
  });

  it("queues a next turn instead of starting immediately while a turn is running", async () => {
    const apiCalls = [];
    let cleared = 0;
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        apiCalls.push({ path, method: options.method || "GET" });
        return {};
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "follow up",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => { cleared += 1; },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(apiCalls).toEqual([]);
    expect(cleared).toBe(1);
    expect(state.activeThreadQueuedTurns).toEqual([
      {
        id: expect.any(String),
        threadId: "thread-1",
        prompt: "follow up",
        mode: "queue",
      },
    ]);
  });

  it("invalidates older history requests when starting a new turn", async () => {
    const apiCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadMessages: [],
      activeThreadHistoryReqSeq: 7,
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "older-turn" }],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const input = { value: "new prompt" };
    const module = createTurnActionsModule({
      state,
      byId(id) {
        if (id === "mobilePromptInput") return input;
        return { value: "" };
      },
      api: async (path, options = {}) => {
        apiCalls.push({ path, method: options.method || "GET", body: options.body || null });
        if (path === "/codex/turns/start") {
          return { threadId: "thread-1", turnId: "turn-2" };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "new prompt",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {
        input.value = "";
      },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      updateMobileComposerState: () => {},
      syncPendingTurnUi: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(state.activeThreadHistoryReqSeq).toBeGreaterThan(7);
    expect(apiCalls).toEqual([
      {
        path: "/codex/turns/start",
        method: "POST",
        body: expect.objectContaining({
          threadId: "thread-1",
          prompt: "new prompt",
        }),
      },
    ]);
  });

  it("interrupts the running turn when the composer is empty", async () => {
    const apiCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        apiCalls.push({ path, method: options.method || "GET" });
        return { ok: true };
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "",
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(apiCalls).toEqual([
      { path: "/codex/turns/turn-1/interrupt", method: "POST" },
    ]);
  });

  it("interrupts by thread when the running terminal turn has no turn id yet", async () => {
    const apiCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "wsl2",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        apiCalls.push({ path, method: options.method || "GET" });
        return { ok: true };
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "",
      getWorkspaceTarget: () => "wsl2",
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(apiCalls).toEqual([
      { path: "/codex/threads/thread-1/interrupt?workspace=wsl2", method: "POST" },
    ]);
  });

  it("queues a steering prompt and interrupts the current turn", async () => {
    const apiCalls = [];
    const input = { value: "steer this" };
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: (id) => (id === "mobilePromptInput" ? input : { value: "" }),
      api: async (path, options = {}) => {
        apiCalls.push({ path, method: options.method || "GET" });
        return { ok: true };
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => input.value,
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => { input.value = ""; },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.steerTurn();

    expect(apiCalls).toEqual([
      { path: "/codex/turns/turn-1/interrupt", method: "POST" },
    ]);
    expect(state.activeThreadQueuedTurns).toEqual([
      {
        id: expect.any(String),
        threadId: "thread-1",
        prompt: "steer this",
        mode: "steer",
      },
    ]);
    expect(input.value).toBe("");
  });

  it("appends multiple queued prompts in FIFO order", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      activeThreadQueuedTurns: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    let prompt = "first queued";
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async () => ({}),
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => prompt,
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.queueFollowUpTurn();
    prompt = "second queued";
    await module.queueFollowUpTurn();

    expect(state.activeThreadQueuedTurns).toHaveLength(2);
    expect(state.activeThreadQueuedTurns.map((item) => item.prompt)).toEqual([
      "first queued",
      "second queued",
    ]);
  });

  it("keeps steer ahead of follow-up entries in the queue", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      activeThreadQueuedTurns: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    let prompt = "follow-up first";
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async () => ({}),
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => prompt,
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.queueFollowUpTurn();
    prompt = "steer me sooner";
    await module.steerTurn().catch(() => {});

    expect(state.activeThreadQueuedTurns.map((item) => item.prompt)).toEqual([
      "steer me sooner",
      "follow-up first",
    ]);
  });

  it("preserves the current draft when a queued follow-up is flushed", async () => {
    const apiCalls = [];
    const input = { value: "still typing now" };
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadMessages: [],
      activeThreadQueuedTurns: [
        { id: "queued-1", threadId: "thread-1", prompt: "queued one", mode: "queue" },
      ],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: (id) => (id === "mobilePromptInput" ? input : { value: "" }),
      api: async (path, options = {}) => {
        apiCalls.push({ path, method: options.method || "GET", body: options.body || null });
        if (path === "/codex/turns/start") return { threadId: "thread-1", turnId: "turn-2" };
        return {};
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => input.value,
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => { input.value = ""; },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.flushQueuedTurn("thread-1");

    expect(apiCalls.some((call) => call.path === "/codex/turns/start")).toBe(true);
    expect(input.value).toBe("still typing now");
    expect(state.activeThreadQueuedTurns).toEqual([]);
  });

  it("skips the queued item being edited when flushing the queue", async () => {
    const apiCalls = [];
    const input = { value: "" };
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnRunning: false,
      activeThreadMessages: [],
      activeThreadQueuedTurns: [
        { id: "queued-1", threadId: "thread-1", prompt: "first queued", mode: "queue" },
        { id: "queued-2", threadId: "thread-1", prompt: "second queued", mode: "queue" },
      ],
      queuedTurnEditingId: "queued-1",
      queuedTurnEditingDraft: "editing first queued",
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => input,
      api: async (path, options = {}) => {
        apiCalls.push({ path, method: options.method || "GET", body: options.body || null });
        if (path === "/codex/turns/start") {
          return { id: "turn-2", threadId: "thread-1" };
        }
        return {};
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {
        input.value = "";
      },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.flushQueuedTurn("thread-1");

    expect(apiCalls.some((call) => call.path === "/codex/turns/start" && call.body?.prompt === "second queued")).toBe(true);
    expect(state.activeThreadQueuedTurns).toEqual([]);
    expect(input.value).toBe("editing first queued");
    expect(state.queuedTurnEditingId).toBe("");
  });

  it("saves queued edits in place and clears editing state", async () => {
    const input = { value: "draft already here", focus() {}, setSelectionRange() {} };
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      activeThreadQueuedTurns: [
        { id: "queued-1", threadId: "thread-1", prompt: "before edit", mode: "queue" },
        { id: "queued-2", threadId: "thread-1", prompt: "another queued", mode: "queue" },
      ],
      queuedTurnEditingId: "",
      queuedTurnEditingDraft: "",
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => input,
      api: async () => ({}),
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "",
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    expect(await module.editQueuedTurn("queued-1")).toBe(true);
    expect(state.queuedTurnEditingId).toBe("queued-1");
    expect(state.queuedTurnEditingDraft).toBe("before edit");
    expect(module.updateQueuedTurnEditingDraft("after edit")).toBe(true);
    expect(module.saveQueuedTurnEdit("queued-1", "after edit")).toBe(true);
    expect(state.activeThreadQueuedTurns).toEqual([
      { id: "queued-1", threadId: "thread-1", prompt: "after edit", mode: "queue" },
      { id: "queued-2", threadId: "thread-1", prompt: "another queued", mode: "queue" },
    ]);
    expect(state.queuedTurnEditingId).toBe("");
    expect(state.queuedTurnEditingDraft).toBe("");
  });

  it("moves a single edited queued item back into the composer", async () => {
    const input = {
      value: "",
      focus() {},
      setSelectionRange() {},
    };
    const wrap = {
      classList: {
        remove() {},
        add() {},
      },
      offsetWidth: 0,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      activeThreadQueuedTurns: [
        { id: "queued-1", threadId: "thread-1", prompt: "bring me back", mode: "queue" },
      ],
      queuedTurnEditingId: "",
      queuedTurnEditingDraft: "",
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: (id) => (id === "mobilePromptInput" ? input : id === "mobilePromptWrap" ? wrap : null),
      api: async () => ({}),
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "",
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    expect(await module.editQueuedTurn("queued-1")).toBe(true);
    expect(input.value).toBe("bring me back");
    expect(state.activeThreadQueuedTurns).toEqual([]);
    expect(state.queuedTurnEditingId).toBe("");
  });

  it("waits for any pending thread resume before executing slash commands that hit the backend", async () => {
    const calls = [];
    let releasePendingResume = null;
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
      planModeEnabled: false,
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET", body: options.body || null });
        if (path === "/codex/slash/execute") {
          return { ok: true, method: "thread/collaborationMode/set", result: {} };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "/fast on",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async (threadId) => {
        expect(threadId).toBe("thread-1");
        await new Promise((resolve) => {
          releasePendingResume = () => {
            state.activeThreadNeedsResume = false;
            resolve();
          };
        });
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
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    const sendPromise = module.sendTurn();
    await Promise.resolve();

    expect(calls).toEqual([]);
    expect(typeof releasePendingResume).toBe("function");

    releasePendingResume();
    await sendPromise;

    expect(calls).toEqual([
      {
        path: "/codex/slash/execute",
        method: "POST",
        body: {
          command: "/fast on",
          threadId: "thread-1",
          workspace: "windows",
          serviceTier: null,
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
        },
      },
    ]);
    expect(state.activeThreadNeedsResume).toBe(false);
  });

  it("does not create a thread before toggling local plan mode in a new chat", async () => {
    const calls = [];
    const renderCalls = [];
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
      planModeEnabled: false,
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission auto" },
      ws: null,
      activeThreadTokenUsage: { total: 3 },
    };
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET", body: options.body || null });
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "/plan on",
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
      renderComposerContextLeft: () => { renderCalls.push(state.planModeEnabled); },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(state.activeThreadId).toBe("");
    expect(state.activeThreadRolloutPath).toBe("");
    expect(state.activeThreadTokenUsage).toEqual({ total: 3 });
    expect(state.planModeEnabled).toBe(true);
    expect(renderCalls).toEqual([true]);
    expect(calls).toEqual([]);
  });

  it("updates fast mode state after executing slash fast on and off", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "gpt-5",
      selectedReasoningEffort: "medium",
      fastModeEnabled: false,
      ws: null,
    };
    const headerUpdates = [];
    const contextUpdates = [];
    const storageWrites = [];
    let prompt = "/fast on";
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path) => {
        if (path === "/codex/slash/execute") {
          return { ok: true, method: "thread/fastMode/set", result: { enabled: prompt === "/fast on" } };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => prompt,
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => { headerUpdates.push(state.fastModeEnabled); },
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {},
      renderComposerContextLeft: () => { contextUpdates.push(state.fastModeEnabled); },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
      localStorageRef: {
        setItem(key, value) {
          storageWrites.push([key, value]);
        },
      },
      FAST_MODE_DEVICE_DEFAULT_KEY: "web_codex_fast_mode_device_default_v1",
    });

    await module.sendTurn();
    expect(state.fastModeEnabled).toBe(true);

    prompt = "/fast off";
    await module.sendTurn();

    expect(state.fastModeEnabled).toBe(false);
    expect(headerUpdates).toEqual([true, false]);
    expect(contextUpdates).toEqual([true, false]);
    expect(storageWrites).toEqual([
      ["web_codex_fast_mode_device_default_v1", "1"],
      ["web_codex_fast_mode_device_default_v1", "0"],
    ]);
  });

  it("updates permission preset state after executing a slash permission command", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "wsl2",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      permissionPresetByWorkspace: { windows: "", wsl2: "" },
      ws: null,
    };
    const contextUpdates = [];
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path) => {
        if (path === "/codex/slash/execute") {
          return {
            ok: true,
            method: "thread/permission/set",
            result: { approvalPolicy: "never", sandbox: "dangerFullAccess", preset: "full-access" },
          };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "/permission full-access",
      getWorkspaceTarget: () => "wsl2",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => {},
      renderComposerContextLeft: () => { contextUpdates.push(state.permissionPresetByWorkspace.wsl2); },
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
      localStorageRef: {
        setItem(key, value) {
          contextUpdates.push(`${key}:${value}`);
        },
      },
      PERMISSION_PRESET_STORAGE_KEY: "web_codex_permission_preset_by_workspace_v1",
    });

    await module.sendTurn();

    expect(state.permissionPresetByWorkspace.wsl2).toBe("/permission full-access");
    expect(contextUpdates).toEqual([
      "web_codex_permission_preset_by_workspace_v1:{\"windows\":\"\",\"wsl2\":\"/permission full-access\"}",
      "/permission full-access",
    ]);
  });

  it("clears prompt and slash menu when starting a new chat", async () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadAttachTransport: "terminal-session",
      activeThreadNeedsResume: false,
      activeThreadStarted: true,
      activeThreadMessages: [],
      pendingThreadResumes: new Map(),
      chatShouldStickToBottom: false,
      selectedModel: "",
      selectedReasoningEffort: "",
      planModeEnabled: true,
      ws: null,
    };
    let cleared = 0;
    let hidden = 0;
    const activeThreadIds = [];
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path) => {
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => {},
      clearPromptValue: () => { cleared += 1; },
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
        activeThreadIds.push(id);
        state.activeThreadId = id;
      },
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      hideSlashCommandMenu: () => { hidden += 1; },
      blockInSandbox: () => false,
    });

    await module.newThread();

    expect(cleared).toBe(1);
    expect(hidden).toBe(1);
    expect(activeThreadIds).toEqual([""]);
    expect(state.activeThreadId).toBe("");
    expect(state.activeThreadAttachTransport).toBe("");
    expect(state.planModeEnabled).toBe(false);
  });

  it("adopts a new active thread after slash new returns a thread id", async () => {
    const state = {
      activeThreadId: "",
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
      activeThreadTokenUsage: { total: 1 },
    };
    const seen = [];
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path) => {
        if (path === "/codex/slash/execute") {
          return {
            ok: true,
            method: "thread/start",
            result: {
              threadId: "thread-new",
              path: "C:\\repo\\.codex\\sessions\\rollout-new.jsonl",
            },
          };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "/new",
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => { seen.push("header"); },
      addChat: () => {},
      clearChatMessages: () => { seen.push("clear"); },
      hideWelcomeCard: () => {},
      showWelcomeCard: () => { seen.push("welcome"); },
      clearPromptValue: () => {},
      renderComposerContextLeft: () => { seen.push("context"); },
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
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(state.activeThreadId).toBe("thread-new");
    expect(state.activeThreadRolloutPath).toBe("C:\\repo\\.codex\\sessions\\rollout-new.jsonl");
    expect(state.activeThreadStarted).toBe(false);
    expect(state.activeThreadTokenUsage).toBeNull();
    expect(seen).toEqual(["context", "clear", "welcome", "header"]);
  });

  it("creates a canonical thread with permission runtime options before slash commands that require one", async () => {
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
      fastModeEnabled: true,
      permissionPresetByWorkspace: {
        windows: "/permission full-access",
        wsl2: "/permission auto",
      },
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
              id: "thread-canonical",
              path: "C:\\repo\\.codex\\sessions\\rollout-canonical.jsonl",
            },
          };
        }
        if (path === "/codex/slash/execute") {
          return { ok: true, method: "model/set", result: { threadId: "thread-canonical" } };
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "/model gpt-5.4",
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
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await module.sendTurn();

    expect(calls).toEqual([
      {
        path: "/codex/threads",
        method: "POST",
        body: {
          workspace: "windows",
          cwd: "C:\\repo",
          serviceTier: "fast",
          approvalPolicy: "never",
          sandbox: "dangerFullAccess",
        },
      },
      {
        path: "/codex/slash/execute",
        method: "POST",
        body: {
          command: "/model gpt-5.4",
          threadId: "thread-canonical",
          workspace: "windows",
          serviceTier: "fast",
          approvalPolicy: "never",
          sandbox: "dangerFullAccess",
        },
      },
    ]);
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
          serviceTier: null,
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "workspaceWrite" },
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

  it("rolls back optimistic send state when turn start fails", async () => {
    const input = { value: "Say OK only." };
    const statusCalls = [];
    const showWelcomeCalls = [];
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
      byId: (id) => {
        if (id === "mobilePromptInput") return input;
        if (id === "chatBox") return { querySelectorAll: () => [] };
        return { value: "" };
      },
      api: async (path) => {
        if (path === "/codex/threads") {
          return {
            thread: {
              id: "thread-live",
              path: "C:\\repo\\.codex\\sessions\\rollout-live.jsonl",
            },
          };
        }
        if (path === "/codex/turns/start") {
          throw new Error("Invalid request: unknown variant `onRequest`");
        }
        throw new Error(`unexpected api call: ${path}`);
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => input.value,
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "C:\\repo",
      waitPendingThreadResume: async () => {},
      registerPendingThreadResume: () => {},
      updateHeaderUi: () => {},
      addChat: () => {},
      clearChatMessages: () => {},
      hideWelcomeCard: () => {},
      showWelcomeCard: () => { showWelcomeCalls.push(true); },
      clearPromptValue: () => { input.value = ""; },
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
      setStatus: (message) => { statusCalls.push(message); },
      setActiveThread: (id) => {
        state.activeThreadId = id;
      },
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      syncPendingTurnUi: () => {},
      updateMobileComposerState: () => {},
      clearTransientToolMessages: () => {},
      clearTransientThinkingMessages: () => {},
      hideSlashCommandMenu: () => {},
      blockInSandbox: () => false,
    });

    await expect(module.sendTurn()).rejects.toThrow("unknown variant `onRequest`");

    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadMessages).toEqual([]);
    expect(input.value).toBe("Say OK only.");
    expect(showWelcomeCalls.length).toBeGreaterThan(0);
    expect(statusCalls).toEqual([]);
  });

  it("keeps new chat local until the first real send", async () => {
    const state = {
      activeThreadId: "",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadAttachTransport: "terminal-session",
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
    const calls = [];
    const module = createTurnActionsModule({
      state,
      byId: () => ({ value: "" }),
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET" });
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

    expect(calls).toEqual([]);
    expect(state.activeThreadId).toBe("");
    expect(state.activeThreadRolloutPath).toBe("");
    expect(state.activeThreadAttachTransport).toBe("");
    expect(state.activeThreadNeedsResume).toBe(false);
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
          serviceTier: null,
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
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
          serviceTier: null,
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "workspaceWrite" },
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

  it("resolves approval using the selected pending approval id from state", async () => {
    const calls = [];
    const state = {
      selectedPendingApprovalId: "approval-7",
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: (id) => {
        if (id === "approvalIdInput") return { value: "" };
        if (id === "approvalDecisionSelect") return { value: "approve" };
        return { value: "" };
      },
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET", body: options.body || null });
        return { ok: true };
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "",
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      blockInSandbox: () => false,
    });

    await module.resolveApproval();

    expect(calls).toEqual([
      {
        path: "/codex/approvals/approval-7/resolve",
        method: "POST",
        body: { decision: "approve" },
      },
    ]);
  });

  it("resolves user input using the selected pending user input id from state", async () => {
    const calls = [];
    const state = {
      selectedPendingUserInputId: "input-3",
      ws: null,
    };
    const module = createTurnActionsModule({
      state,
      byId: (id) => {
        if (id === "userInputIdInput") return { value: "" };
        if (id === "userInputAnswerKeyInput") return { value: "choice" };
        if (id === "userInputAnswerValueInput") return { value: "yes" };
        return { value: "" };
      },
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET", body: options.body || null });
        return { ok: true };
      },
      wsSend: () => false,
      wsCall: async () => ({}),
      nextReqId: () => "req-1",
      connectWs: () => {},
      syncEventSubscription: () => {},
      getPromptValue: () => "",
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
      setActiveThread: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      setChatOpening: () => {},
      blockInSandbox: () => false,
    });

    await module.resolveUserInput();

    expect(calls).toEqual([
      {
        path: "/codex/user-input/input-3/resolve",
        method: "POST",
        body: { answers: { choice: "yes" } },
      },
    ]);
  });
});
