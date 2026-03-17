export function buildTurnPayload({
  activeThreadId,
  prompt,
  workspace,
  startCwd,
  shouldSendStartCwd,
  selectedModel,
  selectedReasoningEffort,
  planModeEnabled,
  fastModeEnabled,
  permissionPreset,
}) {
  const permission = buildPermissionRuntimeOptions(permissionPreset);
  return {
    threadId: String(activeThreadId || "").trim(),
    prompt,
    workspace:
      workspace === "windows" || workspace === "wsl2" ? workspace : undefined,
    cwd: shouldSendStartCwd ? startCwd || undefined : undefined,
    model: selectedModel || undefined,
    reasoningEffort: selectedReasoningEffort || undefined,
    collaborationMode: planModeEnabled === true ? "plan" : undefined,
    serviceTier: fastModeEnabled === true ? "fast" : null,
    approvalPolicy: permission.approvalPolicy,
    sandboxPolicy: permission.sandboxPolicy,
  };
}

function appendServiceTierQuery(params, fastModeEnabled) {
  params.set("serviceTier", fastModeEnabled === true ? "fast" : "none");
}

export function buildPermissionRuntimeOptions(permissionPreset) {
  const preset = String(permissionPreset || "").trim().toLowerCase();
  if (preset === "/permission full-access") {
    return {
      approvalPolicy: "never",
      sandbox: "dangerFullAccess",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  if (preset === "/permission read-only") {
    return {
      approvalPolicy: "unlessTrusted",
      sandbox: "readOnly",
      sandboxPolicy: { type: "readOnly" },
    };
  }
  return {
    approvalPolicy: "onRequest",
    sandbox: "workspaceWrite",
    sandboxPolicy: { type: "workspaceWrite" },
  };
}

function isSlashCommandPrompt(prompt) {
  return /^\/\S+/.test(String(prompt || "").trim());
}

function readSlashResultThreadId(value, fallback = "") {
  return String(
    value?.threadId ||
    value?.thread_id ||
    value?.id ||
    value?.thread?.id ||
    value?.result?.threadId ||
    value?.result?.thread_id ||
    value?.result?.id ||
    value?.result?.thread?.id ||
    fallback
  ).trim();
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

function readPlanModeEnabledFromCommand(prompt, fallback = false) {
  const text = String(prompt || "").trim().toLowerCase();
  if (text === "/plan on" || text === "/plan") return true;
  if (text === "/plan off") return false;
  return !!fallback;
}

function readFastModeEnabledFromCommand(prompt, fallback = false) {
  const text = String(prompt || "").trim().toLowerCase();
  if (text === "/fast on" || text === "/fast") return true;
  if (text === "/fast off") return false;
  return !!fallback;
}

function requiresActiveThreadForSlashCommand(command) {
  const text = String(command || "").trim().toLowerCase();
  return text.startsWith("/model ");
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
    updateMobileComposerState = () => {},
    clearTransientToolMessages = () => {},
    clearTransientThinkingMessages = () => {},
    hideSlashCommandMenu = () => {},
    blockInSandbox,
    localStorageRef,
    FAST_MODE_DEVICE_DEFAULT_KEY = "web_codex_fast_mode_device_default_v1",
    PERMISSION_PRESET_STORAGE_KEY = "web_codex_permission_preset_by_workspace_v1",
    TextDecoderRef = TextDecoder,
  } = deps;
  const storage = localStorageRef ?? globalThis.localStorage ?? { setItem() {} };

  function persistPermissionPresetState() {
    try {
      storage.setItem(
        PERMISSION_PRESET_STORAGE_KEY,
        JSON.stringify(state.permissionPresetByWorkspace || { windows: "/permission auto", wsl2: "/permission auto" })
      );
    } catch {}
  }

  function activeThreadHistoryTurnCount(threadId = state.activeThreadId) {
    const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
    if (!normalizedThreadId) return 0;
    if (String(state.activeThreadHistoryThreadId || "").trim() !== normalizedThreadId) return 0;
    return Array.isArray(state.activeThreadHistoryTurns) ? state.activeThreadHistoryTurns.length : 0;
  }

  function resetLiveTurnStateForNewTurn() {
    state.activeThreadLiveStateEpoch = Math.max(0, Number(state.activeThreadLiveStateEpoch || 0)) + 1;
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
    updateMobileComposerState();
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
    state.activeThreadPendingTurnId = "";
    state.activeThreadPendingTurnRunning = false;
    state.activeThreadPendingUserMessage = "";
    state.activeThreadPendingAssistantMessage = "";
    state.activeThreadPendingTurnBaselineTurnCount = 0;
    syncPendingTurnUi();
    updateMobileComposerState();
  }

  function readQueuedTurns() {
    if (Array.isArray(state.activeThreadQueuedTurns)) return state.activeThreadQueuedTurns.slice();
    const legacy = state.activeThreadQueuedTurn;
    if (legacy && typeof legacy === "object") return [{ ...legacy }];
    return [];
  }

  function writeQueuedTurns(nextTurns) {
    state.activeThreadQueuedTurns = Array.isArray(nextTurns) ? nextTurns.slice() : [];
    if ("activeThreadQueuedTurn" in state) delete state.activeThreadQueuedTurn;
    updateMobileComposerState();
  }

  function pulseComposerRestore() {
    const wrap = byId("mobilePromptWrap");
    if (!wrap?.classList) return;
    wrap.classList.remove("is-queue-restoring");
    void wrap.offsetWidth;
    wrap.classList.add("is-queue-restoring");
    if (wrap.__queueRestoreTimer) clearTimeout(wrap.__queueRestoreTimer);
    wrap.__queueRestoreTimer = setTimeout(() => {
      wrap.classList.remove("is-queue-restoring");
      wrap.__queueRestoreTimer = 0;
    }, 320);
  }

  function restoreQueuedTurnToComposer(queuedTurn) {
    if (!queuedTurn || typeof queuedTurn !== "object") return false;
    const prompt = String(state.queuedTurnEditingDraft || queuedTurn.prompt || "").trim();
    if (!prompt) return false;
    const input = byId("mobilePromptInput");
    if (!input) return false;
    input.value = prompt;
    input.focus?.();
    try {
      const length = String(input.value || "").length;
      input.setSelectionRange?.(length, length);
    } catch {}
    state.queuedTurnEditingId = "";
    state.queuedTurnEditingDraft = "";
    state.queuedTurnDeferredComposerRestoreId = "";
    pulseComposerRestore();
    updateMobileComposerState();
    return true;
  }

  function maybePromoteSingleEditingQueuedTurnToComposer(options = {}) {
    const queue = readQueuedTurns();
    if (queue.length !== 1) return false;
    const editingId = String(state.queuedTurnEditingId || "").trim();
    const onlyItem = queue[0];
    const onlyId = String(onlyItem?.id || "").trim();
    if (!editingId || editingId !== onlyId) return false;
    const input = byId("mobilePromptInput");
    const currentPrompt = String(input?.value || "").trim();
    if (currentPrompt && options.force !== true) {
      state.queuedTurnDeferredComposerRestoreId = editingId;
      updateMobileComposerState();
      return false;
    }
    writeQueuedTurns([]);
    return restoreQueuedTurnToComposer(onlyItem);
  }

  function maybeRestoreDeferredQueuedTurnEdit() {
    const deferredId = String(state.queuedTurnDeferredComposerRestoreId || "").trim();
    if (!deferredId) return false;
    const input = byId("mobilePromptInput");
    const currentPrompt = String(input?.value || "").trim();
    if (currentPrompt) return false;
    const queue = readQueuedTurns();
    const queued = queue.find((item) => String(item?.id || "").trim() === deferredId);
    if (!queued) {
      state.queuedTurnDeferredComposerRestoreId = "";
      return false;
    }
    if (queue.length !== 1 || String(state.queuedTurnEditingId || "").trim() !== deferredId) {
      return false;
    }
    writeQueuedTurns([]);
    return restoreQueuedTurnToComposer(queued);
  }

  function createQueuedTurn(prompt, mode = "queue", threadId = state.activeThreadId) {
    const normalizedPrompt = String(prompt || "").trim();
    const normalizedThreadId = String(
      threadId || state.activeThreadId || state.activeThreadPendingTurnThreadId || ""
    ).trim();
    if (!normalizedPrompt || !normalizedThreadId) return null;
    return {
      id: `queued_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      threadId: normalizedThreadId,
      prompt: normalizedPrompt,
      mode: mode === "steer" || mode === "send-now" ? mode : "queue",
    };
  }

  function queuePendingTurn(prompt, mode = "queue", threadId = state.activeThreadId) {
    const nextQueuedTurn = createQueuedTurn(prompt, mode, threadId);
    if (!nextQueuedTurn) return false;
    const nextQueue = readQueuedTurns();
    const priority = nextQueuedTurn.mode === "send-now" ? 0 : nextQueuedTurn.mode === "steer" ? 1 : 2;
    const insertAt = nextQueue.findIndex((item) => {
      const itemPriority =
        item?.mode === "send-now" ? 0 : item?.mode === "steer" ? 1 : 2;
      return itemPriority > priority;
    });
    if (insertAt < 0) nextQueue.push(nextQueuedTurn);
    else nextQueue.splice(insertAt, 0, nextQueuedTurn);
    writeQueuedTurns(nextQueue);
    clearPromptValue();
    return true;
  }

  function removeQueuedTurnById(queuedTurnId = "") {
    const normalizedId = String(queuedTurnId || "").trim();
    const queue = readQueuedTurns();
    if (!queue.length) return null;
    const index = normalizedId
      ? queue.findIndex((item) => String(item?.id || "").trim() === normalizedId)
      : 0;
    if (index < 0) return null;
    const [removed] = queue.splice(index, 1);
    writeQueuedTurns(queue);
    if (String(state.queuedTurnEditingId || "").trim() === String(removed?.id || "").trim()) {
      state.queuedTurnEditingId = "";
      state.queuedTurnEditingDraft = "";
      state.queuedTurnDeferredComposerRestoreId = "";
      updateMobileComposerState();
    }
    maybePromoteSingleEditingQueuedTurnToComposer();
    return removed || null;
  }

  function beginEditQueuedTurn(queuedTurnId = "") {
    const normalizedId = String(queuedTurnId || "").trim();
    if (!normalizedId) return false;
    const queue = readQueuedTurns();
    const queued = queue.find((item) => String(item?.id || "").trim() === normalizedId);
    if (!queued) return false;
    const currentPrompt = String(byId("mobilePromptInput")?.value || "").trim();
    if (queue.length === 1) {
      if (!currentPrompt && restoreQueuedTurnToComposer(queued)) {
        writeQueuedTurns([]);
        return true;
      }
      if (currentPrompt) state.queuedTurnDeferredComposerRestoreId = normalizedId;
    }
    state.queuedTurnEditingId = normalizedId;
    state.queuedTurnEditingDraft = String(queued.prompt || "");
    state.queuedTurnDeferredComposerRestoreId = "";
    updateMobileComposerState();
    return true;
  }

  function updateQueuedTurnEditingDraft(value = "") {
    if (!String(state.queuedTurnEditingId || "").trim()) return false;
    state.queuedTurnEditingDraft = String(value || "");
    return true;
  }

  function cancelQueuedTurnEditing() {
    if (!String(state.queuedTurnEditingId || "").trim() && !String(state.queuedTurnEditingDraft || "").trim()) {
      return false;
    }
    state.queuedTurnEditingId = "";
    state.queuedTurnEditingDraft = "";
    state.queuedTurnDeferredComposerRestoreId = "";
    updateMobileComposerState();
    return true;
  }

  function saveQueuedTurnEdit(queuedTurnId = "", prompt = "") {
    const normalizedId = String(queuedTurnId || state.queuedTurnEditingId || "").trim();
    const normalizedPrompt = String(prompt || state.queuedTurnEditingDraft || "").trim();
    if (!normalizedId || !normalizedPrompt) return false;
    const queue = readQueuedTurns();
    const index = queue.findIndex((item) => String(item?.id || "").trim() === normalizedId);
    if (index < 0) return false;
    queue[index] = {
      ...queue[index],
      prompt: normalizedPrompt,
    };
    writeQueuedTurns(queue);
    state.queuedTurnEditingId = "";
    state.queuedTurnEditingDraft = "";
    state.queuedTurnDeferredComposerRestoreId = "";
    updateMobileComposerState();
    return true;
  }

  function findNextQueuedTurnIndex(threadId = "", options = {}) {
    const targetThreadId = String(threadId || state.activeThreadId || "").trim();
    if (!targetThreadId) return -1;
    const skipEditingId =
      options.skipEditing !== false ? String(state.queuedTurnEditingId || "").trim() : "";
    const queue = readQueuedTurns();
    return queue.findIndex((item) => {
      const itemThreadId = String(item?.threadId || "").trim();
      const itemId = String(item?.id || "").trim();
      if (!itemThreadId || itemThreadId !== targetThreadId) return false;
      if (skipEditingId && itemId === skipEditingId) return false;
      return !!String(item?.prompt || "").trim();
    });
  }

  async function interruptTurn(options = {}) {
    const threadId = String(state.activeThreadPendingTurnThreadId || state.activeThreadId || "").trim();
    const turnId = String(state.activeThreadPendingTurnId || "").trim();
    if (!threadId || !turnId) throw new Error("No running turn to stop.");
    const result = await api(`/codex/turns/${encodeURIComponent(turnId)}/interrupt`, {
      method: "POST",
    });
    if (options.setStatus !== false) setStatus("Stopping current turn...");
    updateMobileComposerState();
    return result;
  }

  async function steerTurn() {
    const prompt = String(getPromptValue() || "").trim();
    if (!prompt) return interruptTurn();
    if (isSlashCommandPrompt(prompt)) {
      throw new Error("Steering does not support slash commands.");
    }
    if (state.activeThreadPendingTurnRunning !== true) {
      return sendTurn();
    }
    const threadId = String(state.activeThreadPendingTurnThreadId || state.activeThreadId || "").trim();
    if (!threadId) throw new Error("No active thread to steer.");
    const input = byId("mobilePromptInput");
    queuePendingTurn(prompt, "steer", threadId);
    try {
      await interruptTurn({ setStatus: false });
      setStatus("Steering current turn...");
    } catch (error) {
      const queue = readQueuedTurns();
      queue.pop();
      writeQueuedTurns(queue);
      if (input) input.value = prompt;
      throw error;
    }
  }

  async function queueFollowUpTurn() {
    const prompt = String(getPromptValue() || "").trim();
    if (!prompt) return;
    if (isSlashCommandPrompt(prompt)) {
      throw new Error("Follow-up queue does not support slash commands.");
    }
    if (state.activeThreadPendingTurnRunning !== true) {
      return sendTurn();
    }
    const threadId = String(state.activeThreadPendingTurnThreadId || state.activeThreadId || "").trim();
    if (!threadId) throw new Error("No active thread to queue.");
    queuePendingTurn(prompt, "queue", threadId);
    setStatus("Queued follow-up after the current turn.");
  }

  async function sendNowTurn() {
    const prompt = String(getPromptValue() || "").trim();
    if (!prompt) return interruptTurn();
    if (isSlashCommandPrompt(prompt)) {
      if (state.activeThreadPendingTurnRunning === true) {
        throw new Error("Wait for the current turn to finish before using slash commands.");
      }
      return sendTurn();
    }
    if (state.activeThreadPendingTurnRunning !== true) {
      return sendTurn();
    }
    const threadId = String(state.activeThreadPendingTurnThreadId || state.activeThreadId || "").trim();
    if (!threadId) throw new Error("No active thread to send now.");
    queuePendingTurn(prompt, "send-now", threadId);
    await interruptTurn({ setStatus: false });
    setStatus("Interrupting current turn to send now...");
  }

  async function editQueuedTurn(queuedTurnId = "") {
    return beginEditQueuedTurn(queuedTurnId);
  }

  function clearQueuedTurn(queuedTurnId = "") {
    removeQueuedTurnById(queuedTurnId);
  }

  async function sendQueuedTurnNow(queuedTurnId = "") {
    const queued = removeQueuedTurnById(queuedTurnId);
    if (!queued || typeof queued !== "object") return false;
    const prompt = String(queued.prompt || "").trim();
    if (!prompt) return false;
    if (state.activeThreadPendingTurnRunning === true) {
      const threadId = String(queued.threadId || state.activeThreadId || "").trim();
      if (!threadId) throw new Error("No active thread to send now.");
      const queue = readQueuedTurns();
      queue.unshift({
        ...queued,
        threadId,
        prompt,
        mode: "send-now",
      });
      writeQueuedTurns(queue);
      await interruptTurn({ setStatus: false });
      setStatus("Interrupting current turn to send now...");
      return true;
    }
    await sendTurn(prompt, { fromQueuedTurn: true });
    return true;
  }

  async function flushQueuedTurn(threadId = "") {
    const targetThreadId = String(threadId || state.activeThreadId || "").trim();
    const queuedIndex = findNextQueuedTurnIndex(targetThreadId);
    if (queuedIndex < 0) return false;
    const queue = readQueuedTurns();
    const [queued] = queue.splice(queuedIndex, 1);
    const queuedThreadId = String(queued?.threadId || "").trim();
    if (!queued || typeof queued !== "object") return false;
    if (!queuedThreadId || !targetThreadId || queuedThreadId !== targetThreadId) return false;
    if (state.activeThreadPendingTurnRunning === true) return false;
    writeQueuedTurns(queue);
    try {
      await sendTurn(String(queued.prompt || "").trim(), { fromQueuedTurn: true });
      maybePromoteSingleEditingQueuedTurnToComposer();
      setStatus(
        queued.mode === "steer"
          ? "Steering message sent."
          : queued.mode === "send-now"
            ? "Message sent after interrupt."
            : "Queued follow-up sent."
      );
      return true;
    } catch (error) {
      const rollbackQueue = readQueuedTurns();
      rollbackQueue.splice(Math.min(queuedIndex, rollbackQueue.length), 0, queued);
      writeQueuedTurns(rollbackQueue);
      setStatus(error?.message || "Failed to send queued message.", true);
      return false;
    }
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
    state.planModeEnabled = false;
    state.activeThreadRolloutPath = "";
    state.activeThreadTokenUsage = null;
    state.activeThreadPendingTurnId = "";
    writeQueuedTurns([]);
    clearPromptValue();
    hideSlashCommandMenu();
    renderComposerContextLeft();
    clearChatMessages();
    showWelcomeCard();
    updateHeaderUi();

    const data = await api("/codex/threads", {
      method: "POST",
      body: {
        workspace,
        cwd: startCwd || undefined,
        serviceTier: state.fastModeEnabled === true ? "fast" : null,
      },
    });
    const id = data.id || data.threadId || data?.thread?.id || "";
    const rolloutPath =
      String(data?.thread?.path || data?.path || data?.rolloutPath || data?.rollout_path || "").trim();
    if (id) {
      setActiveThread(id);
      state.activeThreadStarted = false;
      state.activeThreadWorkspace = workspace;
      state.planModeEnabled = false;
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

  async function executeSlashCommand(command, options = {}) {
    const trimmed = String(command || "").trim();
    if (!trimmed) return null;
    const workspace = getWorkspaceTarget();
    const startCwd = getStartCwdForWorkspace(workspace);
    if (trimmed === "/plan on" || trimmed === "/plan off" || trimmed === "/plan") {
      state.planModeEnabled = readPlanModeEnabledFromCommand(trimmed, state.planModeEnabled);
      renderComposerContextLeft();
      if (options.clearPrompt !== false) clearPromptValue();
      if (options.hideMenu !== false) hideSlashCommandMenu();
      if (options.switchToChat !== false) setMainTab("chat");
      if (options.setStatus !== false) setStatus(`Executed ${trimmed}`);
      return {
        ok: true,
        method: "web/planMode/set",
        result: { mode: state.planModeEnabled === true ? "plan" : "default" },
      };
    }
    let activeThreadId = String(state.activeThreadId || "").trim();
    if (!activeThreadId && requiresActiveThreadForSlashCommand(trimmed)) {
      const created = await api("/codex/threads", {
        method: "POST",
        body: {
          workspace,
          cwd: startCwd || undefined,
          serviceTier: state.fastModeEnabled === true ? "fast" : null,
        },
      });
      activeThreadId = String(created?.id || created?.threadId || created?.thread?.id || "").trim();
      const createdRolloutPath = String(
        created?.thread?.path || created?.path || created?.rolloutPath || created?.rollout_path || ""
      ).trim();
      if (activeThreadId) {
        setActiveThread(activeThreadId);
        state.activeThreadStarted = false;
        state.activeThreadWorkspace = workspace;
        state.activeThreadRolloutPath = createdRolloutPath;
        state.activeThreadTokenUsage = null;
      }
    }
    await waitPendingThreadResume(activeThreadId);
    activeThreadId = String(state.activeThreadId || activeThreadId || "").trim();
    if (activeThreadId && state.activeThreadNeedsResume) {
      const resumePromise = api(
        buildThreadResumeUrl(activeThreadId, {
          workspace: state.activeThreadWorkspace || workspace,
          rolloutPath: state.activeThreadRolloutPath,
          fastModeEnabled: state.fastModeEnabled,
          permissionPreset: state.permissionPresetByWorkspace?.[state.activeThreadWorkspace || workspace],
        }),
        { method: "POST" }
      );
      registerPendingThreadResume(state.pendingThreadResumes, activeThreadId, resumePromise);
      const resumed = await resumePromise;
      activeThreadId = String(
        resumed?.threadId || resumed?.thread_id || resumed?.id || resumed?.thread?.id || activeThreadId
      ).trim();
      if (activeThreadId) setActiveThread(activeThreadId);
      state.activeThreadNeedsResume = false;
    }
    const response = await api("/codex/slash/execute", {
      method: "POST",
      body: {
        command: trimmed,
        threadId: activeThreadId || undefined,
        workspace,
        serviceTier: state.fastModeEnabled === true ? "fast" : null,
        ...(() => {
          const permission = buildPermissionRuntimeOptions(state.permissionPresetByWorkspace?.[workspace]);
          return {
            approvalPolicy: permission.approvalPolicy,
            sandbox: permission.sandbox,
          };
        })(),
      },
    });
    const method = String(response?.method || "").trim();
    const result = response?.result || null;
    const nextThreadId = readSlashResultThreadId(result, activeThreadId);
    const nextRolloutPath = String(
      result?.path ||
      result?.rolloutPath ||
      result?.rollout_path ||
      result?.thread?.path ||
      ""
    ).trim();
    if (nextThreadId && nextThreadId !== state.activeThreadId) setActiveThread(nextThreadId);
    if (nextThreadId) state.activeThreadNeedsResume = false;
    if (nextRolloutPath) state.activeThreadRolloutPath = nextRolloutPath;
    if (method === "thread/start") {
      state.activeThreadStarted = false;
      state.activeThreadWorkspace = workspace;
      state.planModeEnabled = false;
      state.activeThreadTokenUsage = null;
      renderComposerContextLeft();
      clearChatMessages();
      showWelcomeCard();
      updateHeaderUi();
    } else if (nextThreadId) {
      state.activeThreadWorkspace = workspace;
    }
    if (method === "thread/collaborationMode/set" || method === "web/planMode/set") {
      state.planModeEnabled = readPlanModeEnabledFromCommand(trimmed, state.planModeEnabled);
      renderComposerContextLeft();
    }
    if (method === "thread/fastMode/set") {
      state.fastModeEnabled = readFastModeEnabledFromCommand(trimmed, state.fastModeEnabled);
      try {
        storage.setItem(FAST_MODE_DEVICE_DEFAULT_KEY, state.fastModeEnabled ? "1" : "0");
      } catch {}
      renderComposerContextLeft();
      updateHeaderUi();
    }
    if (method === "thread/permission/set") {
      const nextPreset = String(
        result?.preset ? `/permission ${result.preset}` : trimmed
      ).trim();
      if (nextPreset.startsWith("/permission ")) {
        state.permissionPresetByWorkspace[workspace] = nextPreset;
        persistPermissionPresetState();
      }
      renderComposerContextLeft();
    }
    if (options.clearPrompt !== false) clearPromptValue();
    if (options.hideMenu !== false) hideSlashCommandMenu();
    if (options.switchToChat !== false) setMainTab("chat");
    if (options.refreshThreads !== false) await refreshThreads();
    if (options.setStatus !== false) setStatus(`Executed ${trimmed}`);
    return response;
  }

  async function sendTurn(promptOverride, options = {}) {
    if (blockInSandbox("send turn")) return;
    const prompt = String(promptOverride == null ? getPromptValue() : promptOverride).trim();
    const preservedDraftValue =
      options.fromQueuedTurn === true ? String(byId("mobilePromptInput")?.value || "") : "";
    if (!prompt) {
      if (state.activeThreadPendingTurnRunning === true && promptOverride == null) {
        return interruptTurn();
      }
      return;
    }
    const workspace = getWorkspaceTarget();
    const startCwd = getStartCwdForWorkspace(workspace);
    if (state.activeThreadPendingTurnRunning === true && options.fromQueuedTurn !== true) {
      if (isSlashCommandPrompt(prompt)) {
        throw new Error("Wait for the current turn to finish before using slash commands.");
      }
      const queued = queuePendingTurn(prompt, "queue");
      if (queued) {
        setStatus("Queued after the current turn.");
        return;
      }
    }
    if (isSlashCommandPrompt(prompt)) {
      await executeSlashCommand(prompt);
      return;
    }
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
            serviceTier: state.fastModeEnabled === true ? "fast" : null,
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
            fastModeEnabled: state.fastModeEnabled,
            permissionPreset: state.permissionPresetByWorkspace?.[state.activeThreadWorkspace || workspace],
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
      planModeEnabled: state.planModeEnabled,
      fastModeEnabled: state.fastModeEnabled,
      permissionPreset: state.permissionPresetByWorkspace?.[workspace],
    });
    const shouldAnimateWorkspaceBadge = !state.activeThreadStarted;
    state.activeThreadStarted = true;
    state.activeThreadWorkspace = workspace;
    state.activeThreadPendingTurnThreadId = activeThreadId;
    state.activeThreadPendingTurnId = "";
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
    if (options.fromQueuedTurn === true && preservedDraftValue) {
      const input = byId("mobilePromptInput");
      if (input) input.value = preservedDraftValue;
    }
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
      state.activeThreadPendingTurnId = String(
        started?.turnId || started?.turn_id || started?.result?.turn?.id || ""
      ).trim();
      state.activeThreadPendingTurnRunning = true;
      state.activeThreadPendingTurnBaselineTurnCount = activeThreadHistoryTurnCount(startedThreadId);
      state.activeThreadNeedsResume = false;
    }
    if (startedRolloutPath) state.activeThreadRolloutPath = startedRolloutPath;
    pushLiveDebugEvent("turn.start.ack", {
      threadId: startedThreadId,
      turnId: state.activeThreadPendingTurnId,
    });
    await refreshThreads();
    updateMobileComposerState();
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
    beginEditQueuedTurn,
    cancelQueuedTurnEditing,
    clearQueuedTurn,
    editQueuedTurn,
    executeSlashCommand,
    flushQueuedTurn,
    interruptTurn,
    maybeRestoreDeferredQueuedTurnEdit,
    newThread,
    queueFollowUpTurn,
    resolveApproval,
    resolveUserInput,
    saveQueuedTurnEdit,
    sendNowTurn,
    sendQueuedTurnNow,
    sendTurn,
    steerTurn,
    uploadAttachment,
    updateQueuedTurnEditingDraft,
  };
  }
