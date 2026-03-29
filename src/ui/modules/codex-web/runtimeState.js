export function activeThreadHistoryTurnCount(state, threadId = state.activeThreadId) {
  const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
  if (!normalizedThreadId) return 0;
  if (String(state.activeThreadHistoryThreadId || "").trim() !== normalizedThreadId) return 0;
  return Array.isArray(state.activeThreadHistoryTurns) ? state.activeThreadHistoryTurns.length : 0;
}

export function bumpLiveTurnEpoch(state) {
  state.activeThreadLiveStateEpoch = Math.max(0, Number(state.activeThreadLiveStateEpoch || 0)) + 1;
  state.activeThreadLastFinalAssistantThreadId = "";
  state.activeThreadLastFinalAssistantText = "";
  state.activeThreadLastFinalAssistantAt = 0;
  state.activeThreadLastFinalAssistantEpoch = 0;
}

export function resetTurnPresentationState(state, options = {}) {
  if (options.bumpLiveEpoch === true) {
    bumpLiveTurnEpoch(state);
  }
  if (options.resetLiveRuntimeEpoch === true) {
    state.activeThreadLiveRuntimeEpoch = 0;
  }
  state.activeThreadTransientToolText = "";
  state.activeThreadTransientThinkingText = "";
  state.activeThreadCommentaryPendingPlan = null;
  state.activeThreadCommentaryPendingTools = [];
  state.activeThreadCommentaryPendingToolKeys = [];
  state.activeThreadCommentaryCurrent = null;
  state.activeThreadCommentaryArchive = [];
  state.activeThreadCommentaryArchiveVisible = false;
  state.activeThreadCommentaryArchiveExpanded = false;
  state.activeThreadInlineCommentaryArchiveCount = 0;
  state.activeThreadActivity = null;
  state.activeThreadActiveCommands = [];
  state.activeThreadPlan = null;
  clearActiveAssistantLiveState(state);
}

export function clearActiveAssistantLiveState(state) {
  state.activeThreadLiveAssistantThreadId = "";
  state.activeThreadLiveAssistantIndex = -1;
  state.activeThreadLiveAssistantMsgNode = null;
  state.activeThreadLiveAssistantBodyNode = null;
  state.activeThreadLiveAssistantText = "";
}

export function rememberFinalAssistant(state, threadId, text) {
  state.activeThreadLastFinalAssistantThreadId = String(threadId || "").trim();
  state.activeThreadLastFinalAssistantText = String(text || "");
  state.activeThreadLastFinalAssistantAt = Date.now();
  state.activeThreadLastFinalAssistantEpoch = Math.max(0, Number(state.activeThreadLiveStateEpoch || 0));
}

export function syncPendingAssistantState(state, threadId, text) {
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
  state.activeThreadPendingAssistantMessage = String(text || "");
  return true;
}

export function finishPendingTurnRun(state, threadId) {
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
  state.activeThreadPendingTurnId = "";
  state.activeThreadPendingTurnRunning = false;
  state.activeThreadPendingTurnBaselineTurnCount = 0;
  return true;
}

export function syncPendingTurnRuntime(state, threadId, options = {}) {
  const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
  if (!normalizedThreadId) return false;
  state.activeThreadPendingTurnThreadId = normalizedThreadId;
  if (options.turnId !== undefined) {
    state.activeThreadPendingTurnId = String(options.turnId || "").trim();
  }
  if (options.running !== undefined) {
    state.activeThreadPendingTurnRunning = options.running === true;
  }
  if (options.userMessage !== undefined) {
    state.activeThreadPendingUserMessage = String(options.userMessage || "");
  }
  if (options.assistantMessage !== undefined) {
    state.activeThreadPendingAssistantMessage = String(options.assistantMessage || "");
  }
  if (options.baselineTurnCount !== undefined) {
    const baseline = Number(options.baselineTurnCount || 0);
    state.activeThreadPendingTurnBaselineTurnCount = Number.isFinite(baseline) && baseline > 0 ? baseline : 0;
  }
  return true;
}

export function primePendingTurnRuntime(state, threadId, prompt = "") {
  const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
  if (!normalizedThreadId) return false;
  syncPendingTurnRuntime(state, normalizedThreadId, {
    turnId: "",
    running: true,
    userMessage: String(prompt || ""),
    assistantMessage: "",
    baselineTurnCount: activeThreadHistoryTurnCount(state, normalizedThreadId),
  });
  return true;
}

export function resetPendingTurnRuntime(state, options = {}) {
  if (options.preserveThreadId !== true) state.activeThreadPendingTurnThreadId = "";
  if (options.preserveTurnId !== true) state.activeThreadPendingTurnId = "";
  state.activeThreadPendingTurnRunning = options.running === true;
  if (options.preserveMessages !== true) {
    state.activeThreadPendingUserMessage = "";
    state.activeThreadPendingAssistantMessage = "";
  }
  if (options.preserveBaselineTurnCount !== true) {
    state.activeThreadPendingTurnBaselineTurnCount = 0;
  }
  return true;
}

export function clearPendingTurnRuntimePlaceholder(state, threadId, options = {}) {
  const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!normalizedThreadId || !pendingThreadId || pendingThreadId !== normalizedThreadId) return false;
  if (options.force !== true) {
    if (String(state.activeThreadPendingUserMessage || "").trim()) return false;
    if (String(state.activeThreadPendingAssistantMessage || "").trim()) return false;
  }
  resetPendingTurnRuntime(state);
  return true;
}

export function clearPendingUserFallback(state, threadId) {
  const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!normalizedThreadId || !pendingThreadId || pendingThreadId !== normalizedThreadId) return false;
  state.activeThreadPendingUserMessage = "";
  return true;
}

export function restorePendingUserFallback(state, threadId, prompt = "") {
  const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!normalizedThreadId || !pendingThreadId || pendingThreadId !== normalizedThreadId) return false;
  state.activeThreadPendingUserMessage = String(prompt || "");
  return true;
}

export function setPendingTurnRunning(state, threadId, running, options = {}) {
  const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!normalizedThreadId) return false;
  if (pendingThreadId && pendingThreadId !== normalizedThreadId) return false;
  if (!pendingThreadId) {
    state.activeThreadPendingTurnThreadId = normalizedThreadId;
  }
  if (options.turnId !== undefined) {
    state.activeThreadPendingTurnId = String(options.turnId || "").trim();
  }
  state.activeThreadPendingTurnRunning = running === true;
  return true;
}
