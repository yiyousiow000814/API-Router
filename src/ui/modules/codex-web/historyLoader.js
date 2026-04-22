import {
  clearPendingTurnRuntimePlaceholder,
  clearPendingUserFallback,
  resetPendingTurnRuntime,
  restorePendingUserFallback,
  setPendingTurnRunning,
  syncPendingTurnRuntime,
} from "./runtimeState.js";
import {
  extractLatestCommentaryArchive,
  extractLatestCommentaryState,
} from "./historyCommentary.js";
import { prepareThreadHistoryView } from "./historyPreparation.js";
import { applyHistoryPageToState } from "./historyPageState.js";
import {
  applyPreparedThreadState,
  clearHistoryWindowState,
  shouldExitHistoryWindowMode,
  shouldSkipHistoryRender,
} from "./historyApplyState.js";
import {
  beginApplyThreadToChat,
  getRenderBaseline,
  reportPreparedHistory,
} from "./historyApplyFlow.js";
import {
  beginHistoryLoad,
  finalizeHistoryLoad,
  runHistoryLoad,
} from "./historyLoadFlow.js";
import {
  captureLiveCommentarySnapshot as captureLiveCommentarySnapshotImpl,
  createCommentarySnapshotFromHistory,
  hasAuthoritativeHistoryMaterialization,
  isTerminalHistoryStatus,
  isTerminalInterruptedHistory,
  latestTurnContainsPendingUserEcho,
  resolveLiveCommentarySnapshot,
  shouldSuppressStalePendingHistoryLiveState,
} from "./historyLiveCommentaryState.js";
import {
  mapSessionHistoryMessages as mapSessionHistoryMessagesImpl,
  mapThreadReadMessages as mapThreadReadMessagesImpl,
} from "./historyMessageMapping.js";
import {
  applyFullHistoryRender,
  applyWindowedHistoryRender,
} from "./historyRenderApply.js";
import { loadOlderHistoryChunk as loadOlderHistoryChunkImpl } from "./historyOlderChunk.js";
import {
  ensureLoadOlderControl as ensureLoadOlderControlImpl,
  updateLoadOlderControl as updateLoadOlderControlImpl,
} from "./historyWindowControl.js";
export {
  extractLatestCommentaryArchive,
  extractLatestCommentaryState,
} from "./historyCommentary.js";

export function buildThreadHistoryUrl(threadId, options = {}, fallbackWorkspace = "") {
  const params = new URLSearchParams();
  const workspace = String(options.workspace || fallbackWorkspace || "").trim();
  const rolloutPath = String(options.rolloutPath || "").trim();
  const before = String(options.before || "").trim();
  const limit = Number(options.limit || 0) || 0;
  if (workspace === "windows" || workspace === "wsl2") params.set("workspace", workspace);
  if (rolloutPath) params.set("rolloutPath", rolloutPath);
  if (before) params.set("before", before);
  if (limit > 0) params.set("limit", String(limit));
  const query = params.toString();
  return `/codex/threads/${encodeURIComponent(threadId)}/history${query ? `?${query}` : ""}`;
}

export function mergeHistoryTurns(existingTurns, incomingTurns) {
  const merged = [];
  const indexes = new Map();
  const seenAnonymous = new Set();
  const pushTurn = (turn) => {
    if (!turn || typeof turn !== "object") return;
    const id = String(turn.id || "").trim();
    if (id) {
      const existingIndex = indexes.get(id);
      if (existingIndex !== undefined) {
        merged[existingIndex] = turn;
        return;
      }
      indexes.set(id, merged.length);
      merged.push(turn);
      return;
    }
    const key = JSON.stringify(turn);
    if (!key || seenAnonymous.has(key)) return;
    seenAnonymous.add(key);
    merged.push(turn);
  };
  for (const turn of Array.isArray(existingTurns) ? existingTurns : []) pushTurn(turn);
  for (const turn of Array.isArray(incomingTurns) ? incomingTurns : []) pushTurn(turn);
  return merged;
}

export function normalizeSessionAssistantText(content, deps = {}) {
  const normalizeTypeRef =
    typeof deps.normalizeType === "function"
      ? deps.normalizeType
      : (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const stripCodexImageBlocksRef =
    typeof deps.stripCodexImageBlocks === "function"
      ? deps.stripCodexImageBlocks
      : (value) => String(value || "");
  const parts = Array.isArray(content) ? content : [];
  const lines = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const partType = normalizeTypeRef(part.type);
    if (partType !== "outputtext" && partType !== "inputtext") continue;
    const text = stripCodexImageBlocksRef(String(part.text || "")).trim();
    if (text) lines.push(text);
  }
  return lines.join("\n").trim();
}

export function isVisibleAssistantHistoryPhase(phase) {
  const value = String(phase || "").trim().toLowerCase();
  if (!value) return true;
  return value === "final_answer";
}

export function shouldUseHistoryWindow(messages, options = {}, state = {}) {
  if (!Array.isArray(messages)) return false;
  if (options.forceHistoryWindow || state.activeThreadHistoryHasMore) return true;
  if (messages.length < Number(state.HISTORY_WINDOW_THRESHOLD || 0)) return false;
  return true;
}

function shouldClearTransientConnectionStatusOnExplicitHistoryOpen(state = {}, threadId = "", options = {}) {
  if (options.forceRender !== true) return false;
  const id = String(threadId || "").trim();
  if (!id) return false;
  if (String(state.activeThreadId || "").trim() !== id) return false;
  if (
    !String(state.activeThreadConnectionStatusKind || "").trim() &&
    !String(state.activeThreadConnectionStatusText || "").trim() &&
    !String(state.activeThreadTerminalConnectionErrorThreadId || "").trim() &&
    !String(state.activeThreadPendingTerminalConnectionErrorThreadId || "").trim() &&
    !String(state.activeThreadPendingTerminalConnectionErrorText || "").trim()
  ) {
    return false;
  }
  if (String(state.activeThreadOpenState?.threadId || "").trim() !== id) return false;
  if (state.activeThreadOpenState?.resumeRequired === true) return false;
  const hasTrackedRuntimeContext =
    (String(state.activeThreadPendingTurnThreadId || "").trim() === id) ||
    (String(state.activeThreadLiveAssistantThreadId || "").trim() === id) ||
    (String(state.activeThreadCommentaryCurrent?.threadId || "").trim() === id) ||
    (String(state.activeThreadPlan?.threadId || "").trim() === id) ||
    (Array.isArray(state.activeThreadActiveCommands) && state.activeThreadActiveCommands.length > 0);
  return !hasTrackedRuntimeContext;
}

function pushHistoryMessage(messages, nextMessage) {
  if (!Array.isArray(messages) || !nextMessage || typeof nextMessage !== "object") return;
  const role = String(nextMessage.role || "").trim();
  const kind = String(nextMessage.kind || "").trim();
  const text = String(nextMessage.text || "");
  const last = messages.length ? messages[messages.length - 1] : null;
  const shouldSkipAdjacentDuplicate =
    !!last &&
    last.role === role &&
    String(last.kind || "").trim() === kind &&
    String(last.text || "") === text &&
    (role === "assistant" || kind === "commentaryArchive");
  if (shouldSkipAdjacentDuplicate) return;
  messages.push(nextMessage);
}

function messageMatches(a, b) {
  return !!a && !!b && a.role === b.role && a.kind === b.kind && a.text === b.text;
}

function findLatestMaterializedPendingUserIndex(messages, pendingUser, options = {}) {
  const items = Array.isArray(messages) ? messages : [];
  const pendingText = String(pendingUser || "");
  if (!pendingText) return -1;
  const baselineUserCount = Math.max(0, Number(options.baselineUserCount || 0));
  const historyUserCount = Math.max(0, Number(options.historyUserCount || 0));
  if (historyUserCount <= baselineUserCount) return -1;
  let lastAssistantIndex = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (String(items[index]?.role || "").trim() === "assistant") lastAssistantIndex = index;
  }
  for (let index = Math.max(0, lastAssistantIndex + 1); index < items.length; index += 1) {
    const entry = items[index];
    if (String(entry?.role || "").trim() !== "user") continue;
    if (String(entry?.text || "") !== pendingText) continue;
    return index;
  }
  return -1;
}

export function mergePendingLiveMessages(messages, state = {}, threadId = "", options = {}) {
  const out = Array.isArray(messages) ? messages.slice() : [];
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!pendingThreadId || !threadId || pendingThreadId !== threadId) return out;

  const pendingUser = String(state.activeThreadPendingUserMessage || "");
  const pendingAssistant = String(state.activeThreadPendingAssistantMessage || "");
  const hasPendingUser = !!pendingUser.trim();
  const hasPendingAssistant = !!pendingAssistant.trim();
  const finalAssistantThreadId = String(state.activeThreadLastFinalAssistantThreadId || "").trim();
  const finalAssistantText = String(state.activeThreadLastFinalAssistantText || "").trim();
  const hasFinalAssistantSnapshot = finalAssistantThreadId === threadId && !!finalAssistantText;
  const historyIncomplete =
    options.historyIncomplete === true ||
    (options.historyIncomplete == null && state.activeThreadHistoryIncomplete === true);
  const historyUserCount = out.filter((entry) => String(entry?.role || "").trim() === "user").length;
  const baselineUserCount = Math.max(0, Number(state.activeThreadPendingTurnBaselineUserCount || 0));
  const historyMaterializedPendingUser = historyUserCount > baselineUserCount;
  const keepPendingUserFallback =
    hasPendingUser &&
    !hasPendingAssistant &&
    state.activeThreadPendingTurnRunning === true;
  const pending = [];
  if (hasPendingUser) pending.push({ role: "user", text: pendingUser, kind: "" });
  if (hasPendingAssistant) pending.push({ role: "assistant", text: pendingAssistant, kind: "" });
  if (!pending.length) return out;
  const materializedPendingUserIndex = hasPendingUser
    ? findLatestMaterializedPendingUserIndex(out, pendingUser, {
        historyUserCount,
        baselineUserCount,
      })
    : -1;
  if (materializedPendingUserIndex >= 0) {
    if (!hasPendingAssistant) {
      if (keepPendingUserFallback) restorePendingUserFallback(state, threadId, pendingUser);
      else clearPendingUserFallback(state, threadId);
      return out;
    }
    const materializedPendingAssistant = out
      .slice(materializedPendingUserIndex + 1)
      .some(
        (entry) =>
          String(entry?.role || "").trim() === "assistant" &&
          String(entry?.text || "") === pendingAssistant
      );
    if (materializedPendingAssistant) {
      if (!historyIncomplete || hasFinalAssistantSnapshot) {
        clearPendingTurnRuntimePlaceholder(state, threadId, {
          force: true,
          reason: "history.merge:pending_materialized_after_user_echo",
        });
      } else if (!keepPendingUserFallback) {
        clearPendingUserFallback(state, threadId);
      } else {
        restorePendingUserFallback(state, threadId, pendingUser);
      }
      return out;
    }
    clearPendingUserFallback(state, threadId);
    return out.concat([{ role: "assistant", text: pendingAssistant, kind: "" }]);
  }

  const canTreatPendingUserAsMaterialized =
    !hasPendingUser ||
    historyMaterializedPendingUser;
  const endsWithPending =
    canTreatPendingUserAsMaterialized &&
    pending.length <= out.length &&
    pending.every((msg, index) => messageMatches(out[out.length - pending.length + index], msg));
  if (endsWithPending) {
    if ((hasPendingAssistant && (!historyIncomplete || hasFinalAssistantSnapshot)) || !hasPendingUser) {
      clearPendingTurnRuntimePlaceholder(state, threadId, {
        force: true,
        reason: "history.merge:pending_already_materialized",
      });
    } else if (!keepPendingUserFallback) {
      clearPendingUserFallback(state, threadId);
    } else {
      restorePendingUserFallback(state, threadId, pendingUser);
    }
    return out;
  }

  let appendFrom = 0;
  if (
    canTreatPendingUserAsMaterialized &&
    pending.length >= 1 &&
    out.length >= 1 &&
    messageMatches(out[out.length - 1], pending[0])
  ) {
    appendFrom = 1;
  }
  return out.concat(pending.slice(appendFrom));
}

export function buildHistoryRenderSig(threadId, turns, messages) {
  let hash = 2166136261;
  const pushChunk = (value) => {
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash ^= 124;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  pushChunk(threadId);
  pushChunk(Array.isArray(turns) ? turns.length : 0);
  const items = Array.isArray(messages) ? messages : [];
  pushChunk(items.length);
  for (const message of items) {
    pushChunk(message?.role || "");
    pushChunk(message?.kind || "");
    pushChunk(message?.text || "");
    pushChunk(message?.archiveKey || "");
  }
  return `${String(threadId || "")}::${hash.toString(16)}`;
}

export function findLatestIncompleteToolMessage(thread, normalizeThreadItemText) {
  const page = thread?.page || {};
  if (!page?.incomplete) return "";
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const type = String(item?.type || "").trim();
    if (!type || type === "userMessage" || type === "assistantMessage" || type === "agentMessage") continue;
    const text = typeof normalizeThreadItemText === "function" ? normalizeThreadItemText(item, { compact: true }) : "";
    if (text) return text;
  }
  return "";
}

function pendingUserLacksAuthoritativeHistory(thread, state = {}, parseUserMessageParts) {
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  const pendingUser = String(state.activeThreadPendingUserMessage || "").trim();
  const pendingAssistant = String(state.activeThreadPendingAssistantMessage || "").trim();
  if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
  if (!pendingUser || pendingAssistant) return false;
  return latestTurnContainsPendingUserEcho(thread, state, parseUserMessageParts) !== true;
}

function shouldPreservePendingUserAcrossTerminalHistory(thread, state = {}, parseUserMessageParts) {
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  const activeThreadId = String(state.activeThreadId || "").trim();
  const connectionStatusKind = String(state.activeThreadConnectionStatusKind || "").trim().toLowerCase();
  const terminalConnectionErrorThreadId = String(state.activeThreadTerminalConnectionErrorThreadId || "").trim();
  if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
  if (pendingUserLacksAuthoritativeHistory(thread, state, parseUserMessageParts)) {
    return true;
  }
  return (
    activeThreadId === threadId &&
    (terminalConnectionErrorThreadId === threadId || connectionStatusKind === "error")
  );
}

function syncLiveConnectionStatusOverlay(threadId, state = {}, addChat = () => {}) {
  const activeThreadId = String(state.activeThreadId || "").trim();
  const connectionStatusKind = String(state.activeThreadConnectionStatusKind || "").trim().toLowerCase();
  const connectionStatusText = String(state.activeThreadConnectionStatusText || "").trim();
  const historyStatusType = String(state.activeThreadHistoryStatusType || "").trim().toLowerCase();
  if (!threadId || activeThreadId !== threadId) return;
  if (!connectionStatusKind || !connectionStatusText) return;
  if (connectionStatusKind === "reconnecting" && isTerminalHistoryStatus(historyStatusType)) return;
  const kind = connectionStatusKind === "reconnecting"
    ? "thinking"
    : (connectionStatusKind === "error" ? "error" : "");
  if (!kind) return;
  addChat("system", connectionStatusText, {
    kind,
    scroll: false,
    messageKey: "live-thread-connection-status",
    source: "historyRenderLiveConnectionStatus",
  });
}

function materializeDeferredTerminalConnectionError(thread, state = {}, setStatus = () => {}) {
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  const historyStatusType = String(thread?.status?.type || state.activeThreadHistoryStatusType || "")
    .trim()
    .toLowerCase();
  const deferredThreadId = String(state.activeThreadPendingTerminalConnectionErrorThreadId || "").trim();
  const deferredText = String(state.activeThreadPendingTerminalConnectionErrorText || "").trim();
  if (!threadId || deferredThreadId !== threadId || !deferredText) return;
  if (!isTerminalHistoryStatus(historyStatusType) || thread?.page?.incomplete === true) return;
  state.activeThreadConnectionStatusKind = "error";
  state.activeThreadConnectionStatusText = deferredText;
  state.activeThreadTerminalConnectionErrorThreadId = threadId;
  state.activeThreadPendingTerminalConnectionErrorThreadId = "";
  state.activeThreadPendingTerminalConnectionErrorText = "";
  setStatus(deferredText, true);
}

function materializeTerminalConnectionErrorFromHistory(thread, state = {}, setStatus = () => {}, pushLiveDebugEvent = () => {}) {
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  const historyStatusType = String(thread?.status?.type || state.activeThreadHistoryStatusType || "")
    .trim()
    .toLowerCase();
  if (!threadId || !isTerminalHistoryStatus(historyStatusType) || historyStatusType === "interrupted" || historyStatusType === "cancelled") {
    return;
  }
  if (thread?.page?.incomplete === true) return;
  const connectionStatusKind = String(state.activeThreadConnectionStatusKind || "").trim().toLowerCase();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  const hasPendingRuntime =
    pendingThreadId === threadId &&
    (
      state.activeThreadPendingTurnRunning === true ||
      !!String(state.activeThreadPendingTurnId || "").trim() ||
      !!String(state.activeThreadPendingUserMessage || "").trim() ||
      !!String(state.activeThreadPendingAssistantMessage || "").trim()
    );
  const deferredThreadId = String(state.activeThreadPendingTerminalConnectionErrorThreadId || "").trim();
  const guardThreadId = String(state.activeThreadConnectionReplayGuardThreadId || "").trim();
  const hasTerminalErrorContext =
    connectionStatusKind === "reconnecting" ||
    hasPendingRuntime ||
    deferredThreadId === threadId ||
    guardThreadId === threadId;
  if (!hasTerminalErrorContext) return;
  const message = String(
    state.activeThreadPendingTerminalConnectionErrorText ||
    state.activeThreadConnectionReplayGuardText ||
    ""
  ).trim();
  if (!message) return;
  pushLiveDebugEvent("history.connection:materialize_terminal_error", {
    threadId,
    historyStatusType,
    fromKind: connectionStatusKind,
    hadPendingRuntime: hasPendingRuntime,
    message: message.slice(0, 180),
  });
  state.activeThreadConnectionStatusKind = "error";
  state.activeThreadConnectionStatusText = message;
  state.activeThreadTerminalConnectionErrorThreadId = threadId;
  state.activeThreadPendingTerminalConnectionErrorThreadId = "";
  state.activeThreadPendingTerminalConnectionErrorText = "";
  setStatus(message, true);
  if (pendingThreadId === threadId) {
    setPendingTurnRunning(state, threadId, false, {
      reason: "history.connection:materialize_terminal_error",
    });
    resetPendingTurnRuntime(state, {
      preserveThreadId: true,
      preserveTurnId: true,
      preserveMessages: true,
      preserveBaselineTurnCount: true,
      preserveBaselineUserCount: true,
      reason: "history.connection:materialize_terminal_error",
    });
  }
}

function syncPendingTurnStateFromIncompleteHistory(thread, state = {}, parseUserMessageParts) {
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  const openStateThreadId = String(state.activeThreadOpenState?.threadId || "").trim();
  const openStateResumeRequired =
    openStateThreadId === threadId && state.activeThreadOpenState?.resumeRequired === true;
  const suppressRuntime = state.suppressedIncompleteHistoryRuntimeByThreadId?.[threadId] === true;
  const suppressedPending = state.suppressedSyntheticPendingUserInputsByThreadId?.[threadId] === true;
  const connectionStatusKind = String(state.activeThreadConnectionStatusKind || "").trim().toLowerCase();
  const terminalConnectionErrorThreadId = String(state.activeThreadTerminalConnectionErrorThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  const pendingTurnId = String(state.activeThreadPendingTurnId || "").trim();
  const pendingRunning = state.activeThreadPendingTurnRunning === true;
  const pendingUser = String(state.activeThreadPendingUserMessage || "").trim();
  const pendingAssistant = String(state.activeThreadPendingAssistantMessage || "").trim();
  const finalAssistantThreadId = String(state.activeThreadLastFinalAssistantThreadId || "").trim();
  const finalAssistantText = String(state.activeThreadLastFinalAssistantText || "").trim();
  const hasFinalAssistantSnapshot = finalAssistantThreadId === threadId && !!finalAssistantText;
  const pageIncomplete = !!thread?.page?.incomplete;
  const hasMaterializedHistory = hasAuthoritativeHistoryMaterialization(thread);
  const terminalInterruptedHistory = isTerminalInterruptedHistory(thread, state);
  const hasPendingEcho = latestTurnContainsPendingUserEcho(thread, state, parseUserMessageParts) === true;
  const historyStatusType = String(thread?.status?.type || state.activeThreadHistoryStatusType || "")
    .trim()
    .toLowerCase();
  const pendingUserNeedsAuthoritativeHistory =
    pendingUserLacksAuthoritativeHistory(thread, state, parseUserMessageParts);
  const preservePendingUserAcrossTerminalHistory = shouldPreservePendingUserAcrossTerminalHistory(
    thread,
    state,
    parseUserMessageParts,
  );
  if (!threadId) return;
  if (!pageIncomplete || terminalInterruptedHistory) {
    if (Array.isArray(state.liveDebugEvents)) {
      state.liveDebugEvents.push({
        at: Date.now(),
        kind: "history.pending_terminal_preserve_decision",
        __tracePersist: true,
        threadId,
        pageIncomplete,
        terminalInterruptedHistory,
        hasMaterializedHistory,
        preservePendingUserAcrossTerminalHistory,
        hasPendingEcho,
        pendingThreadId,
        pendingRunning,
        pendingUserChars: pendingUser.length,
        pendingAssistantChars: pendingAssistant.length,
        baselineTurnCount: Math.max(0, Number(state.activeThreadPendingTurnBaselineTurnCount || 0)),
        baselineUserCount: Math.max(0, Number(state.activeThreadPendingTurnBaselineUserCount || 0)),
        connectionStatusKind: String(state.activeThreadConnectionStatusKind || "").trim().toLowerCase(),
        terminalConnectionErrorThreadId:
          String(state.activeThreadTerminalConnectionErrorThreadId || "").trim(),
      });
      if (state.liveDebugEvents.length > 220) {
        state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 220);
      }
    }
    if (
      state.suppressedIncompleteHistoryRuntimeByThreadId &&
      state.suppressedIncompleteHistoryRuntimeByThreadId[threadId] === true
    ) {
      delete state.suppressedIncompleteHistoryRuntimeByThreadId[threadId];
    }
    if (preservePendingUserAcrossTerminalHistory) {
      const shouldSettlePreservedPendingUser =
        terminalInterruptedHistory &&
        (
          (connectionStatusKind === "reconnecting" && historyStatusType !== "systemerror") ||
          connectionStatusKind === "error" ||
          terminalConnectionErrorThreadId === threadId
        );
      if (!shouldSettlePreservedPendingUser) {
        return;
      }
      if (pendingThreadId && pendingThreadId === threadId) {
        setPendingTurnRunning(state, threadId, false, {
          reason: "history.sync:terminal_preserve_pending_user",
        });
        resetPendingTurnRuntime(state, {
          preserveThreadId: true,
          preserveTurnId: true,
          preserveMessages: true,
          preserveBaselineTurnCount: true,
          preserveBaselineUserCount: true,
          reason: "history.sync:terminal_preserve_pending_user",
        });
      }
      return;
    }
    if (
      pendingThreadId &&
      pendingThreadId === threadId &&
      pendingTurnId &&
      (pendingUser || pendingAssistant)
    ) {
      return;
    }
    if (
      pendingThreadId &&
      pendingThreadId === threadId &&
      (terminalInterruptedHistory || hasMaterializedHistory)
    ) {
      setPendingTurnRunning(state, threadId, false, { reason: "history.sync:not_incomplete_or_terminal" });
      resetPendingTurnRuntime(state, preservePendingUserAcrossTerminalHistory
        ? {
            preserveThreadId: true,
            preserveMessages: true,
            preserveBaselineTurnCount: true,
            preserveBaselineUserCount: true,
            reason: "history.sync:not_incomplete_or_terminal_preserve_pending_user",
          }
        : { reason: "history.sync:not_incomplete_or_terminal" });
    }
    if (pageIncomplete) return;
    if (!hasMaterializedHistory) {
      if (
        pendingThreadId &&
        pendingThreadId === threadId &&
        pendingRunning &&
        !pendingUser &&
        !pendingAssistant
      ) {
        setPendingTurnRunning(state, threadId, false, {
          reason: "history.sync:complete_without_materialized_history",
        });
        resetPendingTurnRuntime(state, {
          preserveThreadId: true,
          reason: "history.sync:complete_without_materialized_history",
        });
      }
      return;
    }
  }
  if (suppressRuntime) {
    if (pendingThreadId && pendingThreadId === threadId) {
      setPendingTurnRunning(state, threadId, false, { reason: "history.sync:suppressed_runtime" });
      resetPendingTurnRuntime(state, { reason: "history.sync:suppressed_runtime" });
    }
    return;
  }
  if (suppressedPending) {
    if (Array.isArray(state.liveDebugEvents)) {
      state.liveDebugEvents.push({
        at: Date.now(),
        kind: "history.sync:suppressed_pending_inputs_only",
        __tracePersist: true,
        threadId,
        pendingThreadId,
        pendingTurnId,
        pendingRunning,
        pendingUserChars: pendingUser.length,
        pendingAssistantChars: pendingAssistant.length,
      });
      if (state.liveDebugEvents.length > 220) {
        state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 220);
      }
    }
    return;
  }
  if (!pageIncomplete) {
    if (pendingThreadId && pendingThreadId === threadId && !pendingUser && !pendingAssistant) {
      setPendingTurnRunning(state, threadId, false, { reason: "history.sync:complete_placeholder_only" });
      resetPendingTurnRuntime(state, {
        preserveThreadId: true,
        preserveMessages: true,
        preserveTurnId: false,
        preserveBaselineTurnCount: false,
        reason: "history.sync:complete_placeholder_only",
      });
      clearPendingTurnRuntimePlaceholder(state, threadId, {
        force: true,
        reason: "history.sync:complete_placeholder_only",
      });
    }
    return;
  }
  if (pendingThreadId && pendingThreadId !== threadId) return;
  if (pendingThreadId === threadId && (pendingUser || pendingAssistant)) {
    if (hasFinalAssistantSnapshot && !pendingRunning) return;
    setPendingTurnRunning(state, threadId, true, { reason: "history.sync:incomplete_existing_pending" });
    return;
  }
  if (!openStateResumeRequired) {
    return;
  }
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const lastTurnId = String(lastTurn?.id || "").trim();
  if (!lastTurnId) {
    if (pendingThreadId && pendingThreadId === threadId) {
      setPendingTurnRunning(state, threadId, false, { reason: "history.sync:incomplete_without_turn" });
      resetPendingTurnRuntime(state, { reason: "history.sync:incomplete_without_turn" });
    }
    return;
  }
  syncPendingTurnRuntime(state, threadId, {
    turnId: lastTurnId,
    running: true,
  });
}

export function createHistoryLoaderModule(deps) {
  const {
    state,
    byId,
    api,
    nextFrame,
    waitMs,
    windowRef = window,
    documentRef = document,
    performanceRef = performance,
    setTimeoutRef = setTimeout,
    HISTORY_WINDOW_THRESHOLD,
    normalizeThreadTokenUsage,
    renderComposerContextLeft,
    detectThreadWorkspaceTarget,
    parseUserMessageParts,
    isBootstrapAgentsPrompt,
    normalizeThreadItemText,
    normalizeType,
    stripCodexImageBlocks,
    hideWelcomeCard,
    showWelcomeCard,
    updateHeaderUi,
    updateScrollToBottomBtn,
    scheduleChatLiveFollow,
    scrollChatToBottom,
    scrollToBottomReliable,
    canStartChatLiveFollow,
    setStatus = () => {},
    renderMessageBody,
    addChat,
    buildMsgNode,
    clearChatMessages,
    showTransientToolMessage = () => {},
    showTransientThinkingMessage = () => {},
    clearTransientToolMessages = () => {},
    clearTransientThinkingMessages = () => {},
    clearRuntimeState = () => {},
    renderCommentaryArchive = () => {},
    syncRuntimeStateFromHistory = () => {},
    syncEventSubscription = () => {},
    clearLiveThreadConnectionStatus = () => {},
  } = deps;

  function isSupersededHistoryApply(threadId, options = {}) {
    const requestSeq = Math.max(0, Number(options.historyReqSeq || 0));
    if (requestSeq > 0 && requestSeq !== Math.max(0, Number(state.activeThreadHistoryReqSeq || 0))) {
      pushLiveDebugEvent("history.apply:drop_stale_req", {
        threadId: String(threadId || state.activeThreadId || "").trim(),
        requestSeq,
        activeRequestSeq: Math.max(0, Number(state.activeThreadHistoryReqSeq || 0)),
      });
      return true;
    }
    if (threadId && state.activeThreadId && state.activeThreadId !== threadId) {
      pushLiveDebugEvent("history.apply:drop_thread_mismatch", {
        threadId: String(threadId || "").trim(),
        activeThreadId: String(state.activeThreadId || "").trim(),
      });
      return true;
    }
    return false;
  }

  function pushLiveDebugEvent(kind, payload = {}) {
    if (!Array.isArray(state.liveDebugEvents)) state.liveDebugEvents = [];
    state.liveDebugEvents.push({
      at: Date.now(),
      kind: String(kind || ""),
      ...payload,
    });
    if (state.liveDebugEvents.length > 120) {
      state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 120);
    }
  }

  function syncIncompleteToolMessage(thread) {
    if (shouldSuppressStalePendingHistoryLiveState(thread, state, parseUserMessageParts)) {
      const threadId = String(thread?.id || state.activeThreadId || "").trim();
      const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
      const pendingRunning = state.activeThreadPendingTurnRunning === true;
      const pendingPromptChars = String(state.activeThreadPendingUserMessage || "").trim().length;
      const baselineUserCount = Math.max(0, Number(state.activeThreadPendingTurnBaselineUserCount || 0));
      const connectionStatusKind = String(state.activeThreadConnectionStatusKind || "").trim().toLowerCase();
      const historyStatusType = String(thread?.status?.type || state.activeThreadHistoryStatusType || "").trim().toLowerCase();
      const hasPendingEcho =
        threadId && pendingThreadId === threadId
          ? latestTurnContainsPendingUserEcho(thread, state, parseUserMessageParts) === true
          : false;
      if (threadId && pendingThreadId === threadId) {
        setPendingTurnRunning(state, threadId, false, { reason: "history.runtime:suppress_stale_pending" });
        resetPendingTurnRuntime(state, {
          preserveTurnId: true,
          reason: "history.runtime:suppress_stale_pending",
        });
      }
      clearRuntimeState();
      clearTransientToolMessages();
      pushLiveDebugEvent("history.runtime:suppress_stale_pending", {
        threadId,
        pendingThreadId,
        pendingRunning,
        promptChars: pendingPromptChars,
        baselineUserCount,
        connectionStatusKind,
        historyStatusType,
        hasPendingEcho,
      });
      return;
    }
    syncPendingTurnStateFromIncompleteHistory(thread, state, parseUserMessageParts);
    syncRuntimeStateFromHistory(thread);
    if (
      (Array.isArray(state.activeThreadActiveCommands) && state.activeThreadActiveCommands.length > 0) ||
      state.activeThreadPlan ||
      state.activeThreadActivity
    ) {
      clearTransientToolMessages();
      return;
    }
    const text = findLatestIncompleteToolMessage(thread, normalizeThreadItemText);
    if (text) showTransientToolMessage(text);
    else clearTransientToolMessages();
  }

  function readLiveStateEpoch() {
    return Math.max(0, Number(state.activeThreadLiveStateEpoch || 0));
  }

  function captureLiveCommentarySnapshot(threadId) {
    return captureLiveCommentarySnapshotImpl(state, threadId, readLiveStateEpoch());
  }

  function restoreLiveCommentarySnapshot(snapshot, thread, options = {}) {
    const threadId = String(thread?.id || state.activeThreadId || "").trim();
    const historySnapshot = createCommentarySnapshotFromHistory(options.historyCommentary, threadId);
    const suppressStalePendingHistory = shouldSuppressStalePendingHistoryLiveState(thread, state, parseUserMessageParts);
    const { effectiveSnapshot, events } = resolveLiveCommentarySnapshot(snapshot, historySnapshot, {
      currentEpoch: readLiveStateEpoch(),
      threadId,
      suppressStalePendingHistory,
      threadIncomplete: thread?.page?.incomplete === true,
    });
    for (const event of events) {
      pushLiveDebugEvent(event.kind, event.payload);
    }
    if (effectiveSnapshot) {
      state.activeThreadCommentaryCurrent = effectiveSnapshot.current;
      state.activeThreadCommentaryArchive = effectiveSnapshot.archive;
      state.activeThreadCommentaryArchiveVisible = effectiveSnapshot.visible === true;
      state.activeThreadCommentaryArchiveExpanded =
        effectiveSnapshot.visible === true && effectiveSnapshot.expanded === true;
    } else {
      state.activeThreadCommentaryCurrent = null;
      state.activeThreadCommentaryArchive = [];
      state.activeThreadCommentaryArchiveVisible = false;
      state.activeThreadCommentaryArchiveExpanded = false;
    }
    if (String(state.activeThreadCommentaryCurrent?.text || "").trim()) {
      showTransientThinkingMessage(state.activeThreadCommentaryCurrent.text);
    } else {
      clearTransientThinkingMessages();
    }
    const box = byId("chatBox");
    const assistantNodes = Array.from(box?.querySelectorAll?.(".assistant") || []);
    const anchorNode = assistantNodes.length ? assistantNodes[assistantNodes.length - 1] : null;
    renderCommentaryArchive(anchorNode ? { anchorNode } : {});
    syncIncompleteToolMessage(thread);
  }

  function finalizeThreadRenderEffects(thread, options = {}, historyCommentary, liveCommentarySnapshot, extra = {}) {
    if (state.activeThreadStarted) hideWelcomeCard();
    else showWelcomeCard();
    updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
    restoreLiveCommentarySnapshot(liveCommentarySnapshot, thread, { historyCommentary });
    materializeTerminalConnectionErrorFromHistory(thread, state, setStatus, pushLiveDebugEvent);
    const historyStatusType = String(
      thread?.status?.type || state.activeThreadHistoryStatusType || ""
    ).trim().toLowerCase();
    const connectionStatusKind = String(state.activeThreadConnectionStatusKind || "")
      .trim()
      .toLowerCase();
    const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
    const hasLivePendingRuntime =
      pendingThreadId === String(thread?.id || state.activeThreadId || "").trim() &&
      state.activeThreadPendingTurnRunning === true;
    const staleReconnectOnCompleteHistory =
      connectionStatusKind === "reconnecting" &&
      thread?.page?.incomplete !== true &&
      !hasLivePendingRuntime;
    const dormantTerminalConnectionOverlay =
      isTerminalHistoryStatus(historyStatusType) &&
      thread?.page?.incomplete !== true &&
      (
        connectionStatusKind === "reconnecting" ||
        (connectionStatusKind === "error" && state.activeThreadStarted !== true)
      );
    if (connectionStatusKind) {
      pushLiveDebugEvent("history.connection_overlay_decision", {
        threadId: String(thread?.id || state.activeThreadId || "").trim(),
        connectionStatusKind,
        historyStatusType,
        pageIncomplete: thread?.page?.incomplete === true,
        pendingThreadId,
        pendingRunning: state.activeThreadPendingTurnRunning === true,
        staleReconnectOnCompleteHistory,
        dormantTerminalConnectionOverlay,
      });
    }
    if (staleReconnectOnCompleteHistory) {
      clearLiveThreadConnectionStatus("history.render:complete_without_live_runtime");
    } else if (dormantTerminalConnectionOverlay) {
      clearLiveThreadConnectionStatus("history.render:dormant_terminal_history");
    }
    materializeDeferredTerminalConnectionError(thread, state, setStatus);
    if (
      isTerminalHistoryStatus(historyStatusType) &&
      thread?.page?.incomplete !== true &&
      !hasLivePendingRuntime &&
      String(state.activeThreadConnectionStatusKind || "").trim().toLowerCase() !== "error"
    ) {
      setStatus("", false);
    }
    syncLiveConnectionStatusOverlay(String(thread?.id || state.activeThreadId || "").trim(), state, addChat);
    if (extra.updateScrollButton) updateScrollToBottomBtn();
  }

  function maybeScheduleChatFollow(delayMs) {
    if (canStartChatLiveFollow()) scheduleChatLiveFollow(delayMs);
  }

  async function mapThreadReadMessages(thread) {
    return mapThreadReadMessagesImpl(thread, {
      nextFrame,
      performanceRef,
      parseUserMessageParts,
      isBootstrapAgentsPrompt,
      normalizeThreadItemText,
      pushHistoryMessage,
      isVisibleAssistantHistoryPhase,
      pushLiveDebugEvent,
    });
  }

  async function mapSessionHistoryMessages(items) {
    return mapSessionHistoryMessagesImpl(items, {
      nextFrame,
      performanceRef,
      parseUserMessageParts,
      isBootstrapAgentsPrompt,
      normalizeSessionAssistantText,
      normalizeType,
      stripCodexImageBlocks,
      pushHistoryMessage,
      isVisibleAssistantHistoryPhase,
      pushLiveDebugEvent,
    });
  }

  function queuePendingActiveThreadHistoryRefresh(threadId, options = {}) {
    if (!threadId) return;
    const previous = state.activeThreadHistoryPendingRefresh;
    const next = {
      threadId,
      animateBadge: !!(previous?.animateBadge || options.animateBadge),
      forceRender: !!(previous?.forceRender || options.forceRender),
      forceHistoryWindow: !!(previous?.forceHistoryWindow || options.forceHistoryWindow),
      workspace: String(options.workspace || previous?.workspace || state.activeThreadWorkspace || "").trim(),
      rolloutPath: String(options.rolloutPath || previous?.rolloutPath || state.activeThreadRolloutPath || "").trim(),
    };
    const limit = Number(options.limit || previous?.limit || 0) || 0;
    if (limit > 0) next.limit = limit;
    state.activeThreadHistoryPendingRefresh = next;
  }

  function ensureLoadOlderControl(box) {
    return ensureLoadOlderControlImpl(box, {
      byId,
      documentRef,
      loadOlderHistoryChunk,
    });
  }

  function updateLoadOlderControl() {
    updateLoadOlderControlImpl(state, {
      byId,
      ensureLoadOlderControl,
    });
  }

  async function renderChatFull(messages, options = {}) {
    const box = byId("chatBox");
    if (!box) return;
    const preservedScrollTop =
      options && options.preserveScroll === true ? Math.max(0, Number(box.scrollTop || 0)) : null;

    state.chatRenderToken = (Number(state.chatRenderToken || 0) + 1) | 0;
    const token = state.chatRenderToken;

    clearChatMessages({
      preserveScroll: options && options.preserveScroll === true,
      preservePendingTurn: true,
    });
    state.activeThreadInlineCommentaryArchiveCount = messages.filter((message) => message?.kind === "commentaryArchive").length;
    state.activeThreadMessages = [];

    const slowYield = !!options.slowRender;
    const batchSize = Math.max(6, Math.min(28, Number(options.batchSize || 14)));
    for (let i = 0; i < messages.length; i += batchSize) {
      if (token !== state.chatRenderToken) return;
      const frag = documentRef.createDocumentFragment();
      const end = Math.min(messages.length, i + batchSize);
      for (let j = i; j < end; j += 1) frag.appendChild(buildMsgNode(messages[j]));
      box.appendChild(frag);
      const now = Date.now();
      const recentGesture = now - Number(state.chatLastUserGestureAt || 0) <= 250;
      if (state.chatShouldStickToBottom && !recentGesture) {
        scrollChatToBottom({ force: true });
      } else if (preservedScrollTop !== null) {
        const maxTop = Math.max(0, Number(box.scrollHeight || 0) - Number(box.clientHeight || 0));
        box.scrollTop = Math.min(preservedScrollTop, maxTop);
      }
      await nextFrame();
      if (slowYield) await waitMs(12);
    }
  }

  async function applyThreadToChat(thread, options = {}) {
    const threadId = beginApplyThreadToChat(state, thread, options, pushLiveDebugEvent);
    if (isSupersededHistoryApply(threadId, options)) return;
    const wasActiveThreadStarted = state.activeThreadStarted === true;
    if (shouldClearTransientConnectionStatusOnExplicitHistoryOpen(state, threadId, options)) {
      state.activeThreadTerminalConnectionErrorThreadId = "";
      state.activeThreadPendingTerminalConnectionErrorThreadId = "";
      state.activeThreadPendingTerminalConnectionErrorText = "";
      clearLiveThreadConnectionStatus("history.open:non_live_thread");
    }
    const prepared = await prepareThreadHistoryView(thread, options, {
      state,
      mapSessionHistoryMessages,
      mapThreadReadMessages,
      normalizeThreadItemText,
      captureLiveCommentarySnapshot,
      normalizeThreadTokenUsage,
      detectThreadWorkspaceTarget,
    });
    if (isSupersededHistoryApply(threadId, options)) return;
    const {
      historyItems,
      turns,
      messages,
      historyCommentary,
      inlineCommentaryArchiveCount,
      liveCommentarySnapshot,
      toolCount,
      renderSig,
      started,
      historyStatusType,
      target,
      resolvedRolloutPath,
      tokenUsage,
    } = prepared;
    state.activeThreadInlineCommentaryArchiveCount = inlineCommentaryArchiveCount;
    reportPreparedHistory(threadId, prepared, pushLiveDebugEvent);
    applyPreparedThreadState(state, threadId, {
      inlineCommentaryArchiveCount,
      tokenUsage,
      started,
      historyStatusType,
      target,
      resolvedRolloutPath,
    }, options, {
      renderComposerContextLeft,
      syncEventSubscription,
    });
    const hasTrackedRuntimeContext =
      (String(state.activeThreadPendingTurnThreadId || "").trim() === threadId) ||
      (String(state.activeThreadLiveAssistantThreadId || "").trim() === threadId) ||
      (String(state.activeThreadCommentaryCurrent?.threadId || "").trim() === threadId) ||
      (String(state.activeThreadPlan?.threadId || "").trim() === threadId) ||
      (Array.isArray(state.activeThreadActiveCommands) && state.activeThreadActiveCommands.length > 0);
    if (
      isTerminalHistoryStatus(historyStatusType) &&
      !thread?.page?.incomplete &&
      !hasTrackedRuntimeContext &&
      !wasActiveThreadStarted
    ) {
      state.activeThreadTerminalConnectionErrorThreadId = "";
      clearLiveThreadConnectionStatus();
    }
    if (shouldSkipHistoryRender(state, renderSig, options)) {
      state.activeThreadMessages = messages;
      pushLiveDebugEvent("history.render:unchanged", {
        threadId,
        messages: messages.length,
        toolMessages: toolCount,
      });
      finalizeThreadRenderEffects(thread, options, historyCommentary, liveCommentarySnapshot);
      if (state.historyWindowEnabled && state.historyWindowThreadId === threadId) updateLoadOlderControl();
      return;
    }

    const { box, prevMessages, preservedScrollTop, forceFullRender } = getRenderBaseline(state, byId);

    if (shouldUseHistoryWindow(messages, options, { activeThreadHistoryHasMore: state.activeThreadHistoryHasMore, HISTORY_WINDOW_THRESHOLD })) {
      const prevAll = Array.isArray(state.historyAllMessages) ? state.historyAllMessages : [];
      applyWindowedHistoryRender({
        state,
        threadId,
        messages,
        prevAll,
        prevMessages,
        box,
        preservedScrollTop,
        inlineCommentaryArchiveCount,
        renderSig,
        toolCount,
        forceFullRender,
        options,
        historyCommentary,
        liveCommentarySnapshot,
        deps: {
          clearChatMessages,
          documentRef,
          buildMsgNode,
          byId,
          ensureLoadOlderControl,
          updateLoadOlderControl,
          renderMessageBody,
          addChat,
          pushLiveDebugEvent,
          scrollToBottomReliable,
          scheduleChatLiveFollow,
          scrollChatToBottom,
          maybeScheduleChatFollow,
          finalizeThreadRenderEffects: (nextHistoryCommentary, nextLiveCommentarySnapshot, extra = {}) =>
            finalizeThreadRenderEffects(thread, options, nextHistoryCommentary, nextLiveCommentarySnapshot, extra),
        },
      });
      return;
    }

    if (shouldExitHistoryWindowMode(state, threadId, messages.length, HISTORY_WINDOW_THRESHOLD)) {
      clearHistoryWindowState(state);
      const wrap = byId("loadOlderWrap");
      if (wrap) wrap.remove();
    }

    await applyFullHistoryRender({
      state,
      threadId,
      messages,
      prevMessages,
      box,
      preservedScrollTop,
      inlineCommentaryArchiveCount,
      renderSig,
      toolCount,
      forceFullRender,
      options,
      historyCommentary,
      liveCommentarySnapshot,
      deps: {
        renderMessageBody,
        addChat,
        clearChatMessages,
        renderChatFull,
        pushLiveDebugEvent,
        scrollChatToBottom,
        canStartChatLiveFollow,
        maybeScheduleChatFollow,
        scrollToBottomReliable,
        scheduleChatLiveFollow,
        finalizeThreadRenderEffects: (nextHistoryCommentary, nextLiveCommentarySnapshot, extra = {}) =>
          finalizeThreadRenderEffects(thread, options, nextHistoryCommentary, nextLiveCommentarySnapshot, extra),
      },
    });
  }

  async function loadThreadMessages(threadId, options = {}) {
    if (!threadId) return;
    pushLiveDebugEvent("history.load", {
      threadId: String(threadId || ""),
      forceRender: !!options.forceRender,
      workspace: String(options.workspace || ""),
    });
    if (state.activeThreadHistoryInFlightPromise && state.activeThreadHistoryInFlightThreadId === threadId) {
      queuePendingActiveThreadHistoryRefresh(threadId, options);
      return state.activeThreadHistoryInFlightPromise;
    }
    const reqSeq = beginHistoryLoad(state);
    const loadPromise = runHistoryLoad(threadId, options, {
      state,
      reqSeq,
      api,
      buildThreadHistoryUrl,
      applyHistoryPageToState,
      applyThreadToChat,
      pushLiveDebugEvent,
      windowRef,
    }).catch((error) => {
      pushLiveDebugEvent("history.load:error", {
        threadId: String(threadId || ""),
        workspace: String(options.workspace || state.activeThreadWorkspace || ""),
        message: String(error?.message || error || "").slice(0, 220),
        rolloutPath: String(options.rolloutPath || state.activeThreadRolloutPath || "").slice(0, 220),
      });
      throw error;
    });
    state.activeThreadHistoryInFlightPromise = loadPromise;
    state.activeThreadHistoryInFlightThreadId = threadId;
    try {
      return await loadPromise;
    } finally {
      await finalizeHistoryLoad(state, threadId, loadPromise, {
        setTimeoutRef,
        loadThreadMessages,
      });
    }
  }

  async function loadOlderHistoryChunk() {
    return loadOlderHistoryChunkImpl(state, {
      byId,
      api,
      buildThreadHistoryUrl,
      applyHistoryPageToState,
      applyThreadToChat,
      updateLoadOlderControl,
      ensureLoadOlderControl,
      documentRef,
      buildMsgNode,
    });
  }

  return {
    applyThreadToChat,
    ensureLoadOlderControl,
    loadOlderHistoryChunk,
    loadThreadMessages,
    mapSessionHistoryMessages,
    mapThreadReadMessages,
    queuePendingActiveThreadHistoryRefresh,
    renderChatFull,
    updateLoadOlderControl,
  };
}
