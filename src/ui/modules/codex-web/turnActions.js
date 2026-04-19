import {
  activeThreadHistoryTurnCount,
  clearPendingTurnRuntimePlaceholder as clearPendingTurnRuntimePlaceholderState,
  primePendingTurnRuntime as primePendingTurnRuntimeState,
  resetPendingTurnRuntime,
  resetTurnPresentationState,
  resolveCurrentThreadId,
  syncPendingTurnRuntime,
} from "./runtimeState.js";
import {
  clearProposedPlanConfirmation,
  getProposedPlanConfirmation,
} from "./proposedPlan.js";
import {
  resolveThreadOpenState,
  setThreadOpenState,
} from "./threadOpenState.js";

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
      approvalPolicy: "untrusted",
      sandbox: "readOnly",
      sandboxPolicy: { type: "readOnly" },
    };
  }
  return {
    approvalPolicy: "on-request",
    sandbox: "workspaceWrite",
    sandboxPolicy: { type: "workspaceWrite" },
  };
}

export function buildThreadCreatePayload({
  workspace,
  startCwd,
  fastModeEnabled,
  permissionPreset,
}) {
  const permission = buildPermissionRuntimeOptions(permissionPreset);
  return {
    workspace,
    cwd: startCwd || undefined,
    serviceTier: fastModeEnabled === true ? "fast" : null,
    approvalPolicy: permission.approvalPolicy,
    sandbox: permission.sandbox,
  };
}

export function buildManagedTerminalUrl(threadId) {
  return `/codex/threads/${encodeURIComponent(threadId)}/managed-terminal`;
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

function readSlashStatusSessionId(value, fallback = "") {
  return String(
    value?.sessionId ||
    value?.session_id ||
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

function attachedLiveThread(response) {
  return response?.attached === true || String(response?.transport || "").trim() === "terminal-session";
}

function attachedLiveThreadTransport(response) {
  if (response?.attached === true) {
    return String(response?.transport || "terminal-session").trim();
  }
  const transport = String(response?.transport || "").trim();
  return transport === "terminal-session" ? transport : "";
}

function setThreadAttachTransport(state, threadId, transport) {
  const id = String(threadId || "").trim();
  const normalizedTransport = String(transport || "").trim();
  if (!state || !id) return;
  if (!(state.threadAttachTransportById instanceof Map)) {
    state.threadAttachTransportById = new Map();
  }
  if (normalizedTransport) state.threadAttachTransportById.set(id, normalizedTransport);
  else state.threadAttachTransportById.delete(id);
}

function activeThreadAttachPending(state) {
  return Number(state?.activeThreadAttachPendingUntil || 0) > Date.now();
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
    refreshWorkspaceRuntimeState = async () => null,
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
    clearPendingUserInputs = () => false,
    clearSyntheticPendingUserInputById = () => false,
    setSyntheticPendingUserInputs = () => false,
    suppressSyntheticPendingUserInputs = () => false,
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
    setThreadStatusCard = () => {},
    blockInSandbox,
    localStorageRef,
    FAST_MODE_DEVICE_DEFAULT_KEY = "web_codex_fast_mode_device_default_v1",
    PERMISSION_PRESET_STORAGE_KEY = "web_codex_permission_preset_by_workspace_v1",
    TextDecoderRef = TextDecoder,
  } = deps;
  const storage = localStorageRef ?? globalThis.localStorage ?? { setItem() {} };
  function setActiveThreadOpenState(nextState, options = {}) {
    return setThreadOpenState(state, nextState, options);
  }

  function activeThreadRequiresResume() {
    const openState = state.activeThreadOpenState;
    if (openState && openState.loaded !== true) return true;
    return (openState || resolveThreadOpenState()).resumeRequired === true;
  }

  function shouldMirrorPendingResolutionToChat() {
    return !(globalThis.window?.__webCodexDebug?.isPreviewPendingActive?.() === true);
  }

  function buildApprovedPlanPrompt(confirmation) {
    const plan = confirmation?.plan && typeof confirmation.plan === "object" ? confirmation.plan : null;
    const markdownBody = String(plan?.markdownBody || "").trim();
    if (markdownBody) {
      return `Implement this approved plan exactly:\n\n${markdownBody}`;
    }
    const title = String(plan?.title || "").trim();
    const explanation = String(plan?.explanation || "").trim();
    const stepLines = Array.isArray(plan?.steps)
      ? plan.steps
          .map((step) => String(step?.step || "").trim())
          .filter(Boolean)
          .map((step) => `- ${step}`)
      : [];
    return [
      title ? `Implement this approved plan: ${title}` : "Implement this approved plan.",
      explanation,
      ...stepLines,
    ].filter(Boolean).join("\n");
  }

  function setAttachPending(active = false) {
    state.activeThreadAttachPendingUntil = active ? Date.now() + 2400 : 0;
    updateHeaderUi();
  }

  function resolveManagedTerminalCwd(workspace = getWorkspaceTarget()) {
    const activeThreadId = resolveCurrentThreadId(state);
    const workspaceKey = String(workspace || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
    const threadItem = Array.isArray(state.threadItemsAll)
      ? state.threadItemsAll.find((item) => String(item?.id || item?.threadId || "").trim() === activeThreadId)
      : null;
    const threadCwd = String(threadItem?.cwd || "").trim();
    if (threadCwd) return threadCwd;
    return String(getStartCwdForWorkspace(workspaceKey) || "").trim();
  }

  async function openManagedTerminalSurface(options = {}) {
    if (blockInSandbox("open linked terminal")) return null;
    const threadId = String(options.threadId || resolveCurrentThreadId(state) || "").trim();
    if (!threadId) throw new Error("No active chat to link.");
    if (activeThreadAttachPending(state)) return null;
    if (String(state.activeThreadAttachTransport || "").trim().toLowerCase() === "terminal-session") {
      setStatus("Terminal already linked to this chat.");
      return null;
    }
    const workspace = String(
      options.workspace || state.activeThreadWorkspace || getWorkspaceTarget() || "windows"
    )
      .trim()
      .toLowerCase() === "wsl2"
      ? "wsl2"
      : "windows";
    const cwd = String(options.cwd || resolveManagedTerminalCwd(workspace) || "").trim();
    setAttachPending(true);
    setStatus("Opening linked terminal...");
    try {
      const response = await api(buildManagedTerminalUrl(threadId), {
        method: "POST",
        body: {
          workspace,
          cwd: cwd || undefined,
        },
      });
      const attachTransport = attachedLiveThreadTransport(response);
      state.activeThreadAttachTransport = attachTransport;
      setThreadAttachTransport(state, threadId, attachTransport);
      if (String(response?.path || "").trim()) {
        state.activeThreadRolloutPath = String(response.path).trim();
      }
      setAttachPending(false);
      await refreshRuntimeForWorkspace(workspace);
      updateHeaderUi();
      setStatus(
        attachTransport
          ? "Terminal linked to this chat."
          : "Linked terminal launched for this chat."
      );
      return response;
    } catch (error) {
      setAttachPending(false);
      throw error;
    }
  }

  function persistPermissionPresetState() {
    try {
      storage.setItem(
        PERMISSION_PRESET_STORAGE_KEY,
        JSON.stringify(state.permissionPresetByWorkspace || { windows: "/permission auto", wsl2: "/permission auto" })
      );
    } catch {}
  }

  function refreshRuntimeForWorkspace(workspace = getWorkspaceTarget()) {
    const target = String(workspace || "").trim().toLowerCase();
    if (target !== "windows" && target !== "wsl2") return Promise.resolve(null);
    return refreshWorkspaceRuntimeState(target, { silent: true, updateHeader: true }).catch(() => null);
  }

  function resetLiveTurnStateForNewTurn() {
    const threadId = resolveCurrentThreadId(state);
    state.activeThreadHistoryReqSeq = Math.max(0, Number(state.activeThreadHistoryReqSeq || 0)) + 1;
    resetTurnPresentationState(state, { bumpLiveEpoch: true });
    if (threadId && state.suppressedIncompleteHistoryRuntimeByThreadId) {
      delete state.suppressedIncompleteHistoryRuntimeByThreadId[threadId];
    }
    if (threadId) clearProposedPlanConfirmation(state, threadId);
    if (threadId) setSyntheticPendingUserInputs(threadId, []);
    clearTransientToolMessages();
    clearTransientThinkingMessages();
    syncPendingTurnUi();
    updateMobileComposerState();
  }

  function clearPlanTurnArtifacts(threadId, options = {}) {
    const normalizedThreadId = String(threadId || resolveCurrentThreadId(state) || "").trim();
    const liveAssistantThreadId = String(state.activeThreadLiveAssistantThreadId || "").trim();
    const liveAssistantIndex = Number(state.activeThreadLiveAssistantIndex);
    const liveAssistantMsgNode = state.activeThreadLiveAssistantMsgNode;
    if (
      normalizedThreadId &&
      liveAssistantThreadId === normalizedThreadId &&
      Array.isArray(state.activeThreadMessages) &&
      liveAssistantIndex >= 0 &&
      liveAssistantIndex < state.activeThreadMessages.length
    ) {
      state.activeThreadMessages.splice(liveAssistantIndex, 1);
    }
    liveAssistantMsgNode?.remove?.();
    resetTurnPresentationState(state, { bumpLiveEpoch: options.bumpLiveEpoch === true });
    resetPendingTurnRuntime(state);
    if (normalizedThreadId) {
      state.suppressedIncompleteHistoryRuntimeByThreadId = {
        ...(state.suppressedIncompleteHistoryRuntimeByThreadId && typeof state.suppressedIncompleteHistoryRuntimeByThreadId === "object"
          ? state.suppressedIncompleteHistoryRuntimeByThreadId
          : {}),
        [normalizedThreadId]: true,
      };
      state.suppressedLiveInterruptByThreadId = {
        ...(state.suppressedLiveInterruptByThreadId && typeof state.suppressedLiveInterruptByThreadId === "object"
          ? state.suppressedLiveInterruptByThreadId
          : {}),
        [normalizedThreadId]: true,
      };
      clearProposedPlanConfirmation(state, normalizedThreadId);
      clearPendingUserInputs({ threadId: normalizedThreadId });
      setSyntheticPendingUserInputs(normalizedThreadId, []);
      suppressSyntheticPendingUserInputs(normalizedThreadId, true);
    }
    clearTransientToolMessages();
    clearTransientThinkingMessages();
    syncPendingTurnUi();
    updateMobileComposerState();
  }

  function primePendingTurnRuntime(threadId, prompt = "") {
    const primed = primePendingTurnRuntimeState(state, threadId, prompt);
    if (!primed) return false;
    resetLiveTurnStateForNewTurn();
    return true;
  }

  function clearPendingTurnRuntimePlaceholder(threadId, options = {}) {
    if (!clearPendingTurnRuntimePlaceholderState(state, threadId, options)) return;
    syncPendingTurnUi();
    updateMobileComposerState();
  }

  function rollbackOptimisticPendingTurn(prompt = "", options = {}) {
    const normalizedPrompt = String(prompt || "");
    clearPendingTurnRuntimePlaceholder(resolveCurrentThreadId(state), {
      force: true,
    });
    if (Array.isArray(state.activeThreadMessages) && state.activeThreadMessages.length > 0) {
      const last = state.activeThreadMessages[state.activeThreadMessages.length - 1];
      if (
        last &&
        last.role === "user" &&
        !String(last.kind || "").trim() &&
        String(last.text || "") === normalizedPrompt
      ) {
        state.activeThreadMessages = state.activeThreadMessages.slice(0, -1);
      }
    }
    const box = byId("chatBox");
    const userNodes = Array.from(box?.querySelectorAll?.(".msg.user") || []);
    const lastUserNode = userNodes.length ? userNodes[userNodes.length - 1] : null;
    const lastUserText = String(lastUserNode?.__webCodexRawText || lastUserNode?.textContent || "").trim();
    if (lastUserNode && lastUserText === normalizedPrompt) {
      lastUserNode.remove();
    }
    if (!state.activeThreadMessages.length) {
      showWelcomeCard();
    }
    if (options.restorePrompt === true) {
      const input = byId("mobilePromptInput");
      if (input && !String(input.value || "").trim()) {
        input.value = normalizedPrompt;
      }
    }
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

  function createQueuedTurn(prompt, mode = "queue", threadId = resolveCurrentThreadId(state)) {
    const normalizedPrompt = String(prompt || "").trim();
    const normalizedThreadId = String(threadId || resolveCurrentThreadId(state) || "").trim();
    if (!normalizedPrompt || !normalizedThreadId) return null;
    return {
      id: `queued_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      threadId: normalizedThreadId,
      prompt: normalizedPrompt,
      mode: mode === "steer" || mode === "send-now" ? mode : "queue",
    };
  }

  function queuePendingTurn(prompt, mode = "queue", threadId = resolveCurrentThreadId(state)) {
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
    const targetThreadId = String(threadId || resolveCurrentThreadId(state) || "").trim();
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
    const threadId = resolveCurrentThreadId(state);
    const turnId = String(state.activeThreadPendingTurnId || "").trim();
    if (!threadId) throw new Error("No running turn to stop.");
    const workspace = String(state.activeThreadWorkspace || state.workspaceTarget || "").trim();
    const attachTransport =
      String(
        state.activeThreadAttachTransport ||
        state.threadAttachTransportById?.get?.(threadId) ||
        ""
      )
        .trim()
        .toLowerCase();
    const useThreadInterrupt = attachTransport === "terminal-session" || !turnId;
    pushLiveDebugEvent("turn.interrupt:request", {
      threadId,
      turnId,
      workspace,
      attachTransport,
      useThreadInterrupt,
      historyStatusType: String(state.activeThreadHistoryStatusType || "").trim().toLowerCase(),
      pendingRunning: state.activeThreadPendingTurnRunning === true,
    });
    const result = useThreadInterrupt
      ? await api(
          `/codex/threads/${encodeURIComponent(threadId)}/interrupt${
            workspace === "windows" || workspace === "wsl2"
              ? `?workspace=${encodeURIComponent(workspace)}`
              : ""
          }`,
          { method: "POST" }
        )
      : await api(`/codex/turns/${encodeURIComponent(turnId)}/interrupt`, {
          method: "POST",
          body: {
            threadId,
          },
        });
    clearPlanTurnArtifacts(threadId, { bumpLiveEpoch: true });
    await refreshPending().catch(() => {});
    pushLiveDebugEvent("turn.interrupt:cleared", {
      threadId,
      turnId,
      historyStatusType: String(state.activeThreadHistoryStatusType || "").trim().toLowerCase(),
      pendingRunning: state.activeThreadPendingTurnRunning === true,
    });
    if (options.setStatus !== false) setStatus("Stopping current turn...");
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
    const threadId = resolveCurrentThreadId(state);
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
    const threadId = resolveCurrentThreadId(state);
    if (!threadId) throw new Error("No active thread to queue.");
    queuePendingTurn(prompt, "queue", threadId);
    setStatus("Queued follow-up after the current turn.");
  }

  async function sendNowTurn() {
    const prompt = String(getPromptValue() || "").trim();
    if (!prompt) return interruptTurn();
    if (isSlashCommandPrompt(prompt)) {
      if (state.activeThreadPendingTurnRunning === true) {
        if (String(prompt || "").trim() !== "/status") {
          throw new Error("Wait for the current turn to finish before using slash commands.");
        }
      }
      return sendTurn();
    }
    if (state.activeThreadPendingTurnRunning !== true) {
      return sendTurn();
    }
    const threadId = resolveCurrentThreadId(state);
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
      const threadId = String(queued.threadId || resolveCurrentThreadId(state) || "").trim();
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
    const targetThreadId = String(threadId || resolveCurrentThreadId(state) || "").trim();
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
    setChatOpening(false);
    setActiveThread("");
    state.activeThreadStarted = false;
    state.activeThreadWorkspace = workspace;
    state.planModeEnabled = false;
    state.activeThreadRolloutPath = "";
    state.activeThreadAttachTransport = "";
    setActiveThreadOpenState(resolveThreadOpenState());
    state.activeThreadTokenUsage = null;
    state.activeThreadPendingTurnId = "";
    writeQueuedTurns([]);
    clearPromptValue();
    hideSlashCommandMenu();
    renderComposerContextLeft();
    clearChatMessages();
    showWelcomeCard();
    updateHeaderUi();
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
    if (trimmed === "/status") {
      const sessionThreadId = resolveCurrentThreadId(state);
      const response = await api("/codex/slash/execute", {
        method: "POST",
        body: {
          command: trimmed,
          threadId: sessionThreadId || undefined,
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
      const result = response?.result || null;
      const sessionId = readSlashStatusSessionId(result, sessionThreadId);
      const statusSessionId = sessionId || sessionThreadId || "";
      if (options.clearPrompt !== false) clearPromptValue();
      if (options.hideMenu !== false) hideSlashCommandMenu();
      if (options.switchToChat !== false) setMainTab("chat");
      if (options.setStatus !== false) setStatus("Status opened.");
      setThreadStatusCard({
        threadId: sessionThreadId || activeThreadId || "",
        sessionId: statusSessionId,
        title: "Status",
      });
      return response;
    }
    let activeThreadId = resolveCurrentThreadId(state);
    if (!activeThreadId && requiresActiveThreadForSlashCommand(trimmed)) {
      const created = await api("/codex/threads", {
        method: "POST",
        body: buildThreadCreatePayload({
          workspace,
          startCwd,
          fastModeEnabled: state.fastModeEnabled,
          permissionPreset: state.permissionPresetByWorkspace?.[workspace],
        }),
      });
      const attached = attachedLiveThread(created);
      activeThreadId = String(created?.id || created?.threadId || created?.thread?.id || "").trim();
      const createdRolloutPath = String(
        created?.thread?.path || created?.path || created?.rolloutPath || created?.rollout_path || ""
      ).trim();
      if (activeThreadId) {
        setActiveThread(activeThreadId);
        const attachTransport = attachedLiveThreadTransport(created);
        state.activeThreadStarted = false;
        state.activeThreadWorkspace = workspace;
        state.activeThreadRolloutPath = createdRolloutPath;
        state.activeThreadTokenUsage = null;
        setActiveThreadOpenState(
          resolveThreadOpenState({
            threadId: activeThreadId,
            loaded: true,
          })
        );
        state.activeThreadAttachTransport = attachTransport;
        setThreadAttachTransport(state, activeThreadId, attachTransport);
      }
      refreshRuntimeForWorkspace(workspace);
    }
    await waitPendingThreadResume(activeThreadId);
    activeThreadId = String(resolveCurrentThreadId(state, activeThreadId) || "").trim();
    if (activeThreadId && activeThreadRequiresResume()) {
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
        setActiveThreadOpenState(
          resolveThreadOpenState({
            threadId: activeThreadId,
            loaded: true,
          })
        );
      refreshRuntimeForWorkspace(state.activeThreadWorkspace || workspace);
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
    if (nextThreadId) {
        setActiveThreadOpenState(
          resolveThreadOpenState({
            threadId: nextThreadId,
            loaded: true,
          })
        );
    }
    if (nextRolloutPath) state.activeThreadRolloutPath = nextRolloutPath;
    if (method === "thread/start") {
      const attachTransport = attachedLiveThreadTransport(result);
      state.activeThreadStarted = false;
        setActiveThreadOpenState(
          resolveThreadOpenState({
            threadId: nextThreadId,
            loaded: true,
          })
        );
      state.activeThreadAttachTransport = attachTransport;
      setThreadAttachTransport(state, nextThreadId, attachTransport);
      state.activeThreadWorkspace = workspace;
      state.planModeEnabled = false;
      state.activeThreadTokenUsage = null;
      renderComposerContextLeft();
      clearChatMessages();
      showWelcomeCard();
      updateHeaderUi();
      refreshRuntimeForWorkspace(workspace);
    } else if (nextThreadId) {
      state.activeThreadWorkspace = workspace;
      refreshRuntimeForWorkspace(workspace);
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
        if (String(prompt || "").trim() !== "/status") {
          throw new Error("Wait for the current turn to finish before using slash commands.");
        }
      } else {
        const queued = queuePendingTurn(prompt, "queue");
        if (queued) {
          setStatus("Queued after the current turn.");
          return;
        }
      }
    }
    if (isSlashCommandPrompt(prompt)) {
      await executeSlashCommand(prompt);
      return;
    }
    let activeThreadId = resolveCurrentThreadId(state);
    const primedPendingRuntime = primePendingTurnRuntime(activeThreadId, prompt);
    try {
      await waitPendingThreadResume(activeThreadId);
      activeThreadId = String(resolveCurrentThreadId(state, activeThreadId) || "").trim();
      if (!activeThreadId) {
        const created = await api("/codex/threads", {
          method: "POST",
          body: buildThreadCreatePayload({
            workspace,
            startCwd,
            fastModeEnabled: state.fastModeEnabled,
            permissionPreset: state.permissionPresetByWorkspace?.[workspace],
          }),
        });
        const attached = attachedLiveThread(created);
        const createdRolloutPath = String(
          created?.thread?.path || created?.path || created?.rolloutPath || created?.rollout_path || ""
        ).trim();
        activeThreadId = String(created?.id || created?.threadId || created?.thread?.id || "").trim();
        if (!activeThreadId) throw new Error("turn start failed: missing threadId");
        setActiveThread(activeThreadId);
        const attachTransport = attachedLiveThreadTransport(created);
        state.activeThreadWorkspace = workspace;
        state.activeThreadRolloutPath = createdRolloutPath;
        setActiveThreadOpenState(
          resolveThreadOpenState({
            threadId: activeThreadId,
            loaded: true,
          })
        );
        state.activeThreadAttachTransport = attachTransport;
        setThreadAttachTransport(state, activeThreadId, attachTransport);
        refreshRuntimeForWorkspace(workspace);
      } else if (activeThreadRequiresResume()) {
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
        setActiveThreadOpenState(
          resolveThreadOpenState({
            threadId: resumedThreadId,
            loaded: true,
          })
        );
        refreshRuntimeForWorkspace(state.activeThreadWorkspace || workspace);
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
    syncPendingTurnRuntime(state, activeThreadId, {
      turnId: "",
      running: true,
      userMessage: prompt,
      assistantMessage: "",
      baselineTurnCount: activeThreadHistoryTurnCount(activeThreadId),
    });
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
    let started;
    try {
      started = await api("/codex/turns/start", { method: "POST", body: payload });
    } catch (error) {
      rollbackOptimisticPendingTurn(prompt, {
        restorePrompt: options.fromQueuedTurn !== true,
      });
      throw error;
    }
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
      syncPendingTurnRuntime(state, startedThreadId, {
        turnId: started?.turnId || started?.turn_id || started?.result?.turn?.id || "",
        running: true,
        userMessage: prompt,
        assistantMessage: "",
        baselineTurnCount: activeThreadHistoryTurnCount(startedThreadId),
      });
      setActiveThreadOpenState(
        resolveThreadOpenState({
          threadId: startedThreadId,
          loaded: true,
        })
      );
    }
    if (startedRolloutPath) state.activeThreadRolloutPath = startedRolloutPath;
    refreshRuntimeForWorkspace(workspace);
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
        threadId: resolveCurrentThreadId(state) || "unassigned",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        base64Data,
      },
    });
    renderAttachmentPills([file]);
    setStatus(`Attachment uploaded: ${data.fileName || file.name}`);
  }

  async function resolveApproval(options = {}) {
    if (blockInSandbox("approval resolve")) return;
    const id = String(options.id || state.selectedPendingApprovalId || byId("approvalIdInput")?.value || "").trim();
    const decision = String(options.decision || byId("approvalDecisionSelect")?.value || "").trim();
    if (!id) throw new Error("approval id required");
    if (!decision) throw new Error("approval decision required");
    connectWs();
    let data;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      data = await wsCall("approval.resolve", { id, decision, workspace: getWorkspaceTarget() }, "approval.resolved");
    } else {
      data = await api(`/codex/approvals/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: { decision, workspace: getWorkspaceTarget() },
      });
    }
    if (shouldMirrorPendingResolutionToChat()) {
      addChat("system", `approval resolved: ${JSON.stringify(data)}`);
    }
    await refreshPending();
  }

  async function resolveUserInput(options = {}) {
    if (blockInSandbox("user input resolve")) return;
    const id = String(options.id || state.selectedPendingUserInputId || byId("userInputIdInput")?.value || "").trim();
    const explicitAnswers =
      options.answers && typeof options.answers === "object" ? options.answers : null;
    const answerKey = String(byId("userInputAnswerKeyInput")?.value || "").trim();
    const answerValue = String(byId("userInputAnswerValueInput")?.value || "").trim();
    const answers = explicitAnswers || (answerKey ? { [answerKey]: answerValue } : null);
    if (!id || !answers || !Object.keys(answers).length) {
      throw new Error("user_input id and answers required");
    }
    connectWs();
    let data;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      data = await wsCall("user_input.resolve", { id, answers, workspace: getWorkspaceTarget() }, "user_input.resolved");
    } else {
      data = await api(`/codex/user-input/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: { answers, workspace: getWorkspaceTarget() },
      });
    }
    if (shouldMirrorPendingResolutionToChat()) {
      addChat("system", `user input resolved: ${JSON.stringify(data)}`);
    }
    clearSyntheticPendingUserInputById(id);
    await refreshPending();
  }

  async function resolveProposedPlanConfirmation(options = {}) {
    const threadId = String(options.threadId || resolveCurrentThreadId(state) || "").trim();
    if (!threadId) throw new Error("thread id required");
    const confirmation = getProposedPlanConfirmation(state, threadId);
    if (!confirmation) throw new Error("no proposed plan confirmation available");
    const decision = String(options.decision || "").trim().toLowerCase();
    if (decision !== "approve" && decision !== "stay") {
      throw new Error("plan decision required");
    }
    clearProposedPlanConfirmation(state, threadId);
    if (decision === "approve") {
      state.planModeEnabled = false;
      renderComposerContextLeft();
      updateHeaderUi();
      setStatus("Switching to Default and implementing plan.");
      await sendTurn(buildApprovedPlanPrompt(confirmation));
      return { ok: true, local: true, action: "implement" };
    }
    setStatus("Staying in Plan mode.");
    return { ok: true, local: true, action: "stay" };
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
    openManagedTerminalSurface,
    queueFollowUpTurn,
    resolveApproval,
    resolveProposedPlanConfirmation,
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
