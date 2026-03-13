export function buildTurnPayload({
  activeThreadId,
  prompt,
  workspace,
  startCwd,
  shouldSendStartCwd,
  selectedModel,
  selectedReasoningEffort,
}) {
  return {
    threadId: String(activeThreadId || "").trim(),
    prompt,
    workspace:
      workspace === "windows" || workspace === "wsl2" ? workspace : undefined,
    cwd: shouldSendStartCwd ? startCwd || undefined : undefined,
    model: selectedModel || undefined,
    reasoningEffort: selectedReasoningEffort || undefined,
  };
}

function buildThreadResumeUrl(threadId, options = {}) {
  const params = new URLSearchParams();
  const workspace = String(options.workspace || "").trim();
  const rolloutPath = String(options.rolloutPath || "").trim();
  if (workspace === "windows" || workspace === "wsl2") params.set("workspace", workspace);
  if (rolloutPath) params.set("rolloutPath", rolloutPath);
  const query = params.toString();
  return `/codex/threads/${encodeURIComponent(threadId)}/resume${query ? `?${query}` : ""}`;
}

export function createTurnActionsModule(deps) {
  const {
    state,
    byId,
    api,
    wsSend,
    wsCall,
    nextReqId,
    connectWs,
    syncEventSubscription = () => {},
    getPromptValue,
    getWorkspaceTarget,
    getStartCwdForWorkspace,
    waitPendingThreadResume,
    registerPendingThreadResume = () => {},
    updateHeaderUi,
    addChat,
    clearChatMessages,
    hideWelcomeCard,
    showWelcomeCard,
    clearPromptValue,
    renderComposerContextLeft,
    scrollToBottomReliable,
    scheduleChatLiveFollow,
    createAssistantStreamingMessage,
    appendStreamingDelta,
    finalizeAssistantMessage,
    normalizeTextPayload,
    maybeNotifyTurnDone,
    renderAttachmentPills,
    refreshThreads,
    refreshHosts,
    refreshPending,
    setStatus,
    setActiveThread,
    setMainTab,
    setMobileTab,
    setChatOpening,
    syncPendingTurnUi = () => {},
    clearTransientToolMessages = () => {},
    clearTransientThinkingMessages = () => {},
    blockInSandbox,
    TextDecoderRef = TextDecoder,
  } = deps;

  function activeThreadHistoryTurnCount(threadId = state.activeThreadId) {
    const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
    if (!normalizedThreadId) return 0;
    if (String(state.activeThreadHistoryThreadId || "").trim() !== normalizedThreadId) return 0;
    return Array.isArray(state.activeThreadHistoryTurns) ? state.activeThreadHistoryTurns.length : 0;
  }

  function resetLiveTurnStateForNewTurn() {
    state.activeThreadTransientToolText = "";
    state.activeThreadTransientThinkingText = "";
    state.activeThreadCommentaryPendingPlan = null;
    state.activeThreadCommentaryPendingTools = [];
    state.activeThreadCommentaryPendingToolKeys = [];
    state.activeThreadCommentaryCurrent = null;
    state.activeThreadCommentaryArchive = [];
    state.activeThreadCommentaryArchiveVisible = false;
    state.activeThreadCommentaryArchiveExpanded = false;
    state.activeThreadActivity = null;
    state.activeThreadActiveCommands = [];
    state.activeThreadPlan = null;
    state.activeThreadLiveAssistantThreadId = "";
    state.activeThreadLiveAssistantIndex = -1;
    state.activeThreadLiveAssistantMsgNode = null;
    state.activeThreadLiveAssistantBodyNode = null;
    state.activeThreadLiveAssistantText = "";
    clearTransientToolMessages();
    clearTransientThinkingMessages();
    syncPendingTurnUi();
  }

  function primePendingTurnRuntime(threadId, prompt = "") {
    const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
    if (!normalizedThreadId) return false;
    state.activeThreadPendingTurnThreadId = normalizedThreadId;
    state.activeThreadPendingTurnRunning = true;
    state.activeThreadPendingUserMessage = String(prompt || "");
    state.activeThreadPendingAssistantMessage = "";
    state.activeThreadPendingTurnBaselineTurnCount = activeThreadHistoryTurnCount(normalizedThreadId);
    resetLiveTurnStateForNewTurn();
    return true;
  }

  function clearPendingTurnRuntimePlaceholder(threadId, options = {}) {
    const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
    const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
    if (!normalizedThreadId || !pendingThreadId || pendingThreadId !== normalizedThreadId) return;
    if (options.force !== true) {
      if (String(state.activeThreadPendingUserMessage || "").trim()) return;
      if (String(state.activeThreadPendingAssistantMessage || "").trim()) return;
    }
    state.activeThreadPendingTurnThreadId = "";
    state.activeThreadPendingTurnRunning = false;
    state.activeThreadPendingUserMessage = "";
    state.activeThreadPendingAssistantMessage = "";
    state.activeThreadPendingTurnBaselineTurnCount = 0;
    syncPendingTurnUi();
  }

  function syncPendingAssistantMessage(text) {
    if (!Array.isArray(state.activeThreadMessages)) state.activeThreadMessages = [];
    const nextText = String(text || "");
    const lastIndex = state.activeThreadMessages.length - 1;
    const last = lastIndex >= 0 ? state.activeThreadMessages[lastIndex] : null;
    if (!last || last.role !== "assistant" || String(last.kind || "").trim()) {
      state.activeThreadMessages.push({ role: "assistant", text: nextText, kind: "" });
      return;
    }
    state.activeThreadMessages[lastIndex] = {
      ...last,
      role: "assistant",
      kind: "",
      text: nextText,
    };
  }

  function pushLiveDebugEvent(kind, payload = {}) {
    if (!Array.isArray(state.liveDebugEvents)) state.liveDebugEvents = [];
    state.liveDebugEvents.push({
      at: Date.now(),
      kind: String(kind || ""),
      ...payload,
    });
    if (state.liveDebugEvents.length > 80) {
      state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 80);
    }
  }

  async function addHost() {
    if (blockInSandbox("host changes")) return;
    const name = byId("hostNameInput").value.trim();
    const baseUrl = byId("hostUrlInput").value.trim();
    if (!name || !baseUrl) throw new Error("host name and base URL are required");
    await api("/codex/hosts", { method: "POST", body: { name, baseUrl, tokenHint: "" } });
    byId("hostNameInput").value = "";
    byId("hostUrlInput").value = "";
    await refreshHosts();
  }

  async function newThread() {
    if (blockInSandbox("new thread")) return;
    const workspace = getWorkspaceTarget();
    const startCwd = getStartCwdForWorkspace(workspace);
    setChatOpening(false);
    setActiveThread("");
    state.activeThreadStarted = false;
    state.activeThreadWorkspace = workspace;
    state.activeThreadRolloutPath = "";
    state.activeThreadTokenUsage = null;
    renderComposerContextLeft();
    clearChatMessages();
    showWelcomeCard();
    updateHeaderUi();

    const data = await api("/codex/threads", {
      method: "POST",
      body: {
        workspace,
        cwd: startCwd || undefined,
      },
    });
    const id = data.id || data.threadId || data?.thread?.id || "";
    const rolloutPath =
      String(data?.thread?.path || data?.path || data?.rolloutPath || data?.rollout_path || "").trim();
    if (id) {
      setActiveThread(id);
      state.activeThreadStarted = false;
      state.activeThreadWorkspace = workspace;
      state.activeThreadRolloutPath = rolloutPath;
      state.activeThreadTokenUsage = null;
      renderComposerContextLeft();
      clearChatMessages();
      showWelcomeCard();
      updateHeaderUi();
    }
    await refreshThreads();
    setMainTab("chat");
  }

  async function sendTurn() {
    if (blockInSandbox("send turn")) return;
    const prompt = getPromptValue();
    if (!prompt) return;
    const workspace = getWorkspaceTarget();
    const startCwd = getStartCwdForWorkspace(workspace);
    let activeThreadId = String(state.activeThreadId || "").trim();
    const primedPendingRuntime = primePendingTurnRuntime(activeThreadId, prompt);
    try {
      await waitPendingThreadResume(state.activeThreadId);
      activeThreadId = String(state.activeThreadId || "").trim();
      if (!activeThreadId) {
        const created = await api("/codex/threads", {
          method: "POST",
          body: {
            workspace,
            cwd: startCwd || undefined,
          },
        });
        const createdRolloutPath = String(
          created?.thread?.path || created?.path || created?.rolloutPath || created?.rollout_path || ""
        ).trim();
        activeThreadId = String(created?.id || created?.threadId || created?.thread?.id || "").trim();
        if (!activeThreadId) throw new Error("turn start failed: missing threadId");
        setActiveThread(activeThreadId);
        state.activeThreadWorkspace = workspace;
        state.activeThreadRolloutPath = createdRolloutPath;
        state.activeThreadNeedsResume = false;
      } else if (state.activeThreadNeedsResume) {
        const resumePromise = api(
          buildThreadResumeUrl(activeThreadId, {
            workspace: state.activeThreadWorkspace || workspace,
            rolloutPath: state.activeThreadRolloutPath,
          }),
          { method: "POST" }
        );
        registerPendingThreadResume(state.pendingThreadResumes, activeThreadId, resumePromise);
        const resumed = await resumePromise;
        const resumedThreadId = String(
          resumed?.threadId || resumed?.thread_id || resumed?.id || resumed?.thread?.id || activeThreadId
        ).trim();
        if (!resumedThreadId) throw new Error("turn resume failed: missing threadId");
        activeThreadId = resumedThreadId;
        if (state.activeThreadId !== resumedThreadId) setActiveThread(resumedThreadId);
        state.activeThreadNeedsResume = false;
      }
    } catch (error) {
      if (primedPendingRuntime) clearPendingTurnRuntimePlaceholder(activeThreadId, { force: true });
      throw error;
    }
    const payload = buildTurnPayload({
      activeThreadId,
      prompt,
      workspace,
      startCwd,
      shouldSendStartCwd: false,
      selectedModel: state.selectedModel,
      selectedReasoningEffort: state.selectedReasoningEffort,
    });
    const shouldAnimateWorkspaceBadge = !state.activeThreadStarted;
    state.activeThreadStarted = true;
    state.activeThreadWorkspace = workspace;
    state.activeThreadPendingTurnThreadId = activeThreadId;
    state.activeThreadPendingTurnRunning = true;
    state.activeThreadPendingUserMessage = prompt;
    state.activeThreadPendingAssistantMessage = "";
    state.activeThreadPendingTurnBaselineTurnCount = activeThreadHistoryTurnCount(activeThreadId);
    resetLiveTurnStateForNewTurn();
    updateHeaderUi(shouldAnimateWorkspaceBadge);
    hideWelcomeCard();
    addChat("user", prompt);
    if (!Array.isArray(state.activeThreadMessages)) state.activeThreadMessages = [];
    state.activeThreadMessages = state.activeThreadMessages.concat([{ role: "user", text: prompt, kind: "" }]);
    state.chatShouldStickToBottom = true;
    scrollToBottomReliable();
    setMainTab("chat");
    clearPromptValue();
    connectWs();
    syncEventSubscription();
    pushLiveDebugEvent("turn.send", {
      threadId: activeThreadId,
      usedWs: !!(state.ws && state.ws.readyState === WebSocket.OPEN),
      promptChars: prompt.length,
    });
    const started = await api("/codex/turns/start", { method: "POST", body: payload });
    const startedThreadId = String(started?.threadId || started?.thread_id || activeThreadId).trim();
    const startedRolloutPath = String(
      started?.thread?.path ||
        started?.path ||
        started?.rolloutPath ||
        started?.rollout_path ||
        started?.result?.thread?.path ||
        started?.result?.path ||
        ""
    ).trim();
    if (startedThreadId) {
      setActiveThread(startedThreadId);
      state.activeThreadPendingTurnThreadId = startedThreadId;
      state.activeThreadPendingTurnRunning = true;
      state.activeThreadPendingTurnBaselineTurnCount = activeThreadHistoryTurnCount(startedThreadId);
      state.activeThreadNeedsResume = false;
    }
    if (startedRolloutPath) state.activeThreadRolloutPath = startedRolloutPath;
    pushLiveDebugEvent("turn.start.ack", {
      threadId: startedThreadId,
      turnId: String(started?.turnId || started?.turn_id || started?.result?.turn?.id || "").trim(),
    });
    await refreshThreads();
  }

  async function uploadAttachment(file) {
    if (blockInSandbox("attachment upload")) return;
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    const base64Data = btoa(binary);
    const data = await api("/codex/attachments/upload", {
      method: "POST",
      body: {
        threadId: state.activeThreadId || "unassigned",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        base64Data,
      },
    });
    renderAttachmentPills([file]);
    setStatus(`Attachment uploaded: ${data.fileName || file.name}`);
  }

  async function resolveApproval() {
    if (blockInSandbox("approval resolve")) return;
    const id = byId("approvalIdInput").value.trim();
    const decision = byId("approvalDecisionSelect").value;
    if (!id) throw new Error("approval id required");
    connectWs();
    let data;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      data = await wsCall("approval.resolve", { id, decision }, "approval.resolved");
    } else {
      data = await api(`/codex/approvals/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: { decision },
      });
    }
    addChat("system", `approval resolved: ${JSON.stringify(data)}`);
    await refreshPending();
  }

  async function resolveUserInput() {
    if (blockInSandbox("user input resolve")) return;
    const id = byId("userInputIdInput").value.trim();
    const answerKey = byId("userInputAnswerKeyInput").value.trim();
    const answerValue = byId("userInputAnswerValueInput").value.trim();
    if (!id || !answerKey) throw new Error("user_input id and answer key required");
    const answers = { [answerKey]: answerValue };
    connectWs();
    let data;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      data = await wsCall("user_input.resolve", { id, answers }, "user_input.resolved");
    } else {
      data = await api(`/codex/user-input/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: { answers },
      });
    }
    addChat("system", `user input resolved: ${JSON.stringify(data)}`);
    await refreshPending();
  }

  return {
    addHost,
    newThread,
    resolveApproval,
    resolveUserInput,
    sendTurn,
    uploadAttachment,
  };
}
