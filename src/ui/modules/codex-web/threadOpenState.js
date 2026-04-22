import { isTerminalHistoryStatus } from "./historyLiveCommentaryState.js";

const THREAD_RESUME_STATUSES = new Set(["running", "queued", "pending"]);

function normalizeThreadStatusType(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeThreadOpenStateInput(value = {}) {
  return value && typeof value === "object" ? value : {};
}

export function resolveThreadOpenState(value = {}) {
  const {
    threadId = "",
    threadStatusType = "",
    historyThreadId = "",
    historyIncomplete = false,
    historyStatusType = "",
    pendingTurnRunning = false,
    pendingThreadId = "",
    loaded = false,
  } = normalizeThreadOpenStateInput(value);

  const id = String(threadId || "").trim();
  const status = normalizeThreadStatusType(threadStatusType);
  const historyStatus = normalizeThreadStatusType(historyStatusType);
  const historyId = String(historyThreadId || "").trim();
  const pendingId = String(pendingThreadId || "").trim();
  const isLoaded = loaded === true;
  const hasPendingForThread = pendingTurnRunning === true && (!pendingId || pendingId === id);

  const baseState = {
    threadId: id,
    threadStatusType: status,
    historyThreadId: historyId,
    historyStatusType: historyStatus,
    historyIncomplete: historyIncomplete === true,
    pendingTurnRunning: pendingTurnRunning === true,
    pendingThreadId: pendingId,
    loaded: isLoaded,
    resumeRequired: false,
    resumeReason: "thread-idle",
  };

  if (!id) {
    return {
      ...baseState,
      resumeReason: "missing-thread",
    };
  }

  if (isLoaded) {
    return {
      ...baseState,
      resumeReason: "loaded",
    };
  }

  if (historyId === id) {
    if (isTerminalHistoryStatus(historyStatus)) {
      return {
        ...baseState,
        resumeReason: "history-complete",
      };
    }
    if (historyIncomplete === true) {
      return {
        ...baseState,
        resumeRequired: true,
        resumeReason: "history-incomplete",
      };
    }
    if (THREAD_RESUME_STATUSES.has(historyStatus)) {
      return {
        ...baseState,
        resumeRequired: true,
        resumeReason: "history-active",
      };
    }
    return {
      ...baseState,
      resumeReason: "history-complete",
    };
  }

  if (hasPendingForThread) {
    return {
      ...baseState,
      resumeRequired: true,
      resumeReason: "pending-turn",
    };
  }

  if (status === "notloaded") {
    return {
      ...baseState,
      resumeReason: "thread-not-loaded",
    };
  }

  if (THREAD_RESUME_STATUSES.has(status)) {
    return {
      ...baseState,
      resumeRequired: true,
      resumeReason: "thread-active",
    };
  }

  return baseState;
}

export function getThreadOpenState(state = {}) {
  return resolveThreadOpenState(state?.activeThreadOpenState);
}

export function resetTransientConnectionStatusForThreadOpen(state, openState = {}, clearLiveThreadConnectionStatus = () => {}) {
  const normalized = resolveThreadOpenState(openState);
  const threadId = String(normalized.threadId || "").trim();
  if (!state || !threadId) return false;
  const hasTransientConnectionStatus =
    !!String(state.activeThreadConnectionStatusKind || "").trim() ||
    !!String(state.activeThreadConnectionStatusText || "").trim() ||
    !!String(state.activeThreadTerminalConnectionErrorThreadId || "").trim();
  if (!hasTransientConnectionStatus) return false;
  const hasTrackedRuntimeContext =
    (String(state.activeThreadPendingTurnThreadId || "").trim() === threadId) ||
    (String(state.activeThreadLiveAssistantThreadId || "").trim() === threadId) ||
    (String(state.activeThreadCommentaryCurrent?.threadId || "").trim() === threadId) ||
    (String(state.activeThreadPlan?.threadId || "").trim() === threadId) ||
    (Array.isArray(state.activeThreadActiveCommands) && state.activeThreadActiveCommands.length > 0);
  if (hasTrackedRuntimeContext) return false;
  state.activeThreadTerminalConnectionErrorThreadId = "";
  state.activeThreadPendingTerminalConnectionErrorThreadId = "";
  state.activeThreadPendingTerminalConnectionErrorText = "";
  clearLiveThreadConnectionStatus("thread.open:history_only");
  return true;
}

export function setThreadOpenState(state, value = {}, options = {}) {
  const nextState = resolveThreadOpenState(value);
  const normalized =
    options.loaded === true && nextState.loaded !== true
      ? resolveThreadOpenState({ ...nextState, loaded: true })
      : nextState;
  if (state && typeof state === "object") {
    state.activeThreadOpenState = normalized;
  }
  return normalized;
}
