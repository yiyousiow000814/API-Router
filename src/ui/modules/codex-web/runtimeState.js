export function resolveCurrentThreadId(state = {}, fallback = "") {
  const candidates = [
    state?.activeThreadPendingTurnThreadId,
    state?.activeThreadId,
    state?.activeThreadOpenState?.threadId,
    state?.activeThreadActivity?.threadId,
    state?.activeThreadCommentaryCurrent?.threadId,
    state?.activeThreadPlan?.threadId,
    state?.activeThreadLiveAssistantThreadId,
    state?.activeThreadHistoryThreadId,
    fallback,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function pushPendingRuntimeDebug(state, kind, payload = {}) {
  if (!Array.isArray(state?.liveDebugEvents)) return;
  state.liveDebugEvents.push({
    at: Date.now(),
    kind,
    __tracePersist: true,
    ...payload,
  });
  if (state.liveDebugEvents.length > 200) {
    state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 200);
  }
}

export function activeThreadHistoryTurnCount(state, threadId = resolveCurrentThreadId(state)) {
  const normalizedThreadId = String(threadId || resolveCurrentThreadId(state) || "").trim();
  if (!normalizedThreadId) return 0;
  if (String(state.activeThreadHistoryThreadId || "").trim() !== normalizedThreadId) return 0;
  return Array.isArray(state.activeThreadHistoryTurns) ? state.activeThreadHistoryTurns.length : 0;
}

export function activeThreadHistoryUserCount(state, threadId = resolveCurrentThreadId(state)) {
  const normalizedThreadId = String(threadId || resolveCurrentThreadId(state) || "").trim();
  if (!normalizedThreadId) return 0;
  if (String(state.activeThreadHistoryThreadId || "").trim() === normalizedThreadId) {
    const authoritativeCount = Math.max(0, Number(state.activeThreadHistoryUserCount || 0));
    if (authoritativeCount > 0) return authoritativeCount;
  }
  const messages = Array.isArray(state.activeThreadMessages) ? state.activeThreadMessages : [];
  return messages.filter((message) => String(message?.role || "").trim() === "user").length;
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

export function finishPendingTurnRun(state, threadId, options = {}) {
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
  pushPendingRuntimeDebug(state, "pending.runtime:finish", {
    threadId: String(threadId || "").trim(),
    pendingThreadId,
    pendingTurnId: String(state.activeThreadPendingTurnId || "").trim(),
    running: state.activeThreadPendingTurnRunning === true,
  });
  if (options.preserveTurnId !== true) {
    state.activeThreadPendingTurnId = "";
  }
  state.activeThreadPendingTurnRunning = false;
  if (options.preserveBaselineTurnCount !== true) {
    state.activeThreadPendingTurnBaselineTurnCount = 0;
  }
  if (options.preserveBaselineUserCount !== true) {
    state.activeThreadPendingTurnBaselineUserCount = 0;
  }
  return true;
}

export function syncPendingTurnRuntime(state, threadId, options = {}) {
  const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
  if (!normalizedThreadId) return false;
  pushPendingRuntimeDebug(state, "pending.runtime:sync", {
    threadId: normalizedThreadId,
    running:
      options.running !== undefined ? options.running === true : state.activeThreadPendingTurnRunning === true,
    turnId:
      options.turnId !== undefined
        ? String(options.turnId || "").trim()
        : String(state.activeThreadPendingTurnId || "").trim(),
    userChars:
      options.userMessage !== undefined
        ? String(options.userMessage || "").length
        : String(state.activeThreadPendingUserMessage || "").length,
    assistantChars:
      options.assistantMessage !== undefined
        ? String(options.assistantMessage || "").length
        : String(state.activeThreadPendingAssistantMessage || "").length,
    baselineTurnCount:
      options.baselineTurnCount !== undefined
        ? Math.max(0, Number(options.baselineTurnCount || 0))
        : Math.max(0, Number(state.activeThreadPendingTurnBaselineTurnCount || 0)),
    baselineUserCount:
      options.baselineUserCount !== undefined
        ? Math.max(0, Number(options.baselineUserCount || 0))
        : Math.max(0, Number(state.activeThreadPendingTurnBaselineUserCount || 0)),
  });
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
  if (options.baselineUserCount !== undefined) {
    const baseline = Number(options.baselineUserCount || 0);
    state.activeThreadPendingTurnBaselineUserCount = Number.isFinite(baseline) && baseline > 0 ? baseline : 0;
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
    baselineUserCount: activeThreadHistoryUserCount(state, normalizedThreadId),
  });
  return true;
}

export function resetPendingTurnRuntime(state, options = {}) {
  pushPendingRuntimeDebug(state, "pending.runtime:reset", {
    pendingThreadId: String(state.activeThreadPendingTurnThreadId || "").trim(),
    pendingTurnId: String(state.activeThreadPendingTurnId || "").trim(),
    running: state.activeThreadPendingTurnRunning === true,
    preserveThreadId: options.preserveThreadId === true,
    preserveTurnId: options.preserveTurnId === true,
    preserveMessages: options.preserveMessages === true,
    preserveBaselineTurnCount: options.preserveBaselineTurnCount === true,
    preserveBaselineUserCount: options.preserveBaselineUserCount === true,
    nextRunning: options.running === true,
    reason: String(options.reason || "").trim(),
  });
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
  if (options.preserveBaselineUserCount !== true) {
    state.activeThreadPendingTurnBaselineUserCount = 0;
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
  pushPendingRuntimeDebug(state, "pending.runtime:clear_placeholder", {
    threadId: normalizedThreadId,
    pendingThreadId,
    force: options.force === true,
    reason: String(options.reason || "").trim(),
  });
  resetPendingTurnRuntime(state, {
    reason: String(options.reason || "").trim() || "pending.runtime:clear_placeholder",
  });
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
  pushPendingRuntimeDebug(state, "pending.runtime:set_running", {
    threadId: normalizedThreadId,
    pendingThreadId: String(state.activeThreadPendingTurnThreadId || "").trim(),
    turnId: String(state.activeThreadPendingTurnId || "").trim(),
    running: state.activeThreadPendingTurnRunning === true,
    reason: String(options.reason || "").trim(),
  });
  return true;
}
