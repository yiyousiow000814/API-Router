import { clonePlanState } from "./runtimePlan.js";
import { cloneArchiveBlock } from "./historyCommentary.js";

export function cloneCommentaryBlock(block) {
  if (!block || typeof block !== "object") return null;
  return {
    threadId: String(block.threadId || "").trim(),
    key: String(block.key || "").trim(),
    text: String(block.text || ""),
    tools: Array.isArray(block.tools) ? block.tools.map((tool) => String(tool || "")) : [],
    toolKeys: Array.isArray(block.toolKeys) ? block.toolKeys.map((tool) => String(tool || "")) : [],
    plan: clonePlanState(block.plan, String(block.threadId || "").trim()),
  };
}

function cloneCommentarySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    current: snapshot.current ? cloneCommentaryBlock(snapshot.current) : null,
    archive: Array.isArray(snapshot.archive)
      ? snapshot.archive.map((block) => cloneCommentaryBlock(block)).filter(Boolean)
      : [],
    visible: snapshot.visible === true,
    expanded: snapshot.expanded === true,
  };
}

export function createCommentarySnapshotFromHistory(commentaryState, threadId = "") {
  if (!commentaryState || typeof commentaryState !== "object") return null;
  const normalizedThreadId = String(threadId || "").trim();
  const current = cloneArchiveBlock(commentaryState.current);
  const archive = Array.isArray(commentaryState.archive)
    ? commentaryState.archive.map((block) => cloneArchiveBlock(block)).filter(Boolean)
    : [];
  const visible = commentaryState.visible === true && archive.length > 0;
  if (!current && !archive.length && !visible) return null;
  return {
    current: current
      ? {
          threadId: normalizedThreadId,
          key: String(current.key || "").trim(),
          text: String(current.text || ""),
          tools: Array.isArray(current.tools) ? current.tools.slice() : [],
          toolKeys: [],
          plan: clonePlanState(current.plan, normalizedThreadId),
        }
      : null,
    archive: archive.map((block) => ({
      threadId: normalizedThreadId,
      key: String(block.key || "").trim(),
      text: String(block.text || ""),
      tools: Array.isArray(block.tools) ? block.tools.slice() : [],
      toolKeys: [],
      plan: clonePlanState(block.plan, normalizedThreadId),
    })),
    visible,
    expanded: false,
  };
}

export function latestTurnContainsPendingUserEcho(thread, state = {}, parseUserMessageParts) {
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  const pendingTurnId = String(state.activeThreadPendingTurnId || "").trim();
  const pendingPrompt = String(state.activeThreadPendingUserMessage || "").trim();
  if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
  if (!pendingPrompt) return false;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  if (pendingTurnId) {
    const matchingTurn = turns.find((turn) => String(turn?.id || "").trim() === pendingTurnId);
    if (!matchingTurn) return false;
    const items = Array.isArray(matchingTurn?.items) ? matchingTurn.items : [];
    for (const item of items) {
      if (String(item?.type || "").trim() !== "userMessage") continue;
      const parsed = parseUserMessageParts(item);
      const text = String(parsed?.text || "").trim();
      if (text && text === pendingPrompt) return true;
    }
    return false;
  }
  const baselineTurnCount = Math.max(0, Number(state.activeThreadPendingTurnBaselineTurnCount || 0));
  const baselineUserCount = Math.max(0, Number(state.activeThreadPendingTurnBaselineUserCount || 0));
  let authoritativeUserCount = 0;
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      if (String(item?.type || "").trim() !== "userMessage") continue;
      authoritativeUserCount += 1;
    }
  }
  if (authoritativeUserCount <= baselineUserCount) return false;
  if (turns.length <= baselineTurnCount) return false;
  for (const turn of turns.slice(baselineTurnCount)) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      if (String(item?.type || "").trim() !== "userMessage") continue;
      const parsed = parseUserMessageParts(item);
      const text = String(parsed?.text || "").trim();
      if (text && text === pendingPrompt) return true;
    }
  }
  return false;
}

export function isTerminalHistoryStatus(value) {
  const statusType = String(value || "").trim().toLowerCase();
  if (!statusType) return false;
  return (
    statusType === "interrupted" ||
    statusType === "cancelled" ||
    statusType === "failed" ||
    statusType === "error" ||
    statusType === "systemerror" ||
    statusType === "timeout" ||
    statusType === "denied"
  );
}

export function isInterruptedHistoryStatus(value) {
  const statusType = String(value || "").trim().toLowerCase();
  if (!statusType) return false;
  return statusType === "interrupted" || statusType === "cancelled";
}

export function isTerminalInterruptedHistory(thread, state = {}) {
  const threadStatusType = String(thread?.status?.type || "").trim().toLowerCase();
  const historyStatusType = String(state.activeThreadHistoryStatusType || "").trim().toLowerCase();
  const statusType = threadStatusType || historyStatusType;
  return isInterruptedHistoryStatus(statusType);
}

export function shouldOmitLatestIncompleteTurnArtifacts(thread, state = {}) {
  if (thread?.page?.incomplete !== true) return false;
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  if (threadId && state.suppressedIncompleteHistoryRuntimeByThreadId?.[threadId] === true) {
    return true;
  }
  return isTerminalInterruptedHistory(thread, state);
}

export function omitLatestIncompleteTurnArtifacts(messages, enabled = false) {
  const items = Array.isArray(messages) ? messages : [];
  if (!enabled || !items.length) return items;
  let trimIndex = items.length;
  while (trimIndex > 0) {
    const entry = items[trimIndex - 1];
    const role = String(entry?.role || "").trim().toLowerCase();
    if (role === "assistant" || role === "system") {
      trimIndex -= 1;
      continue;
    }
    break;
  }
  return trimIndex === items.length ? items : items.slice(0, trimIndex);
}

export function hasAuthoritativeHistoryMaterialization(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  if (!turns.length) return false;
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    if (items.length > 0) return true;
  }
  return false;
}

export function shouldSuppressStalePendingHistoryLiveState(thread, state = {}, parseUserMessageParts) {
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  if (threadId && state.suppressedIncompleteHistoryRuntimeByThreadId?.[threadId] === true) return true;
  const historyStatusType = String(thread?.status?.type || state.activeThreadHistoryStatusType || "").trim().toLowerCase();
  const connectionStatusKind = String(state.activeThreadConnectionStatusKind || "").trim().toLowerCase();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  const pendingRunning = state.activeThreadPendingTurnRunning === true;
  const pendingPrompt = String(state.activeThreadPendingUserMessage || "").trim();
  const baselineUserCount = Math.max(0, Number(state.activeThreadPendingTurnBaselineUserCount || 0));
  if (
    threadId &&
    pendingThreadId === threadId &&
    pendingPrompt &&
    baselineUserCount > 0
  ) {
    return false;
  }
  if (connectionStatusKind === "reconnecting") return false;
  if (isTerminalInterruptedHistory(thread, state)) return true;
  if (isTerminalHistoryStatus(historyStatusType)) return true;
  const activeThreadId = String(state.activeThreadId || "").trim();
  const terminalConnectionErrorThreadId = String(state.activeThreadTerminalConnectionErrorThreadId || "").trim();
  if (
    threadId &&
    activeThreadId === threadId &&
    (
      terminalConnectionErrorThreadId === threadId ||
      connectionStatusKind === "error"
    )
  ) {
    return true;
  }
  const finalAssistantThreadId = String(state.activeThreadLastFinalAssistantThreadId || "").trim();
  const finalAssistantText = String(state.activeThreadLastFinalAssistantText || "").trim();
  const hasFinalAssistantSnapshot = finalAssistantThreadId === threadId && !!finalAssistantText;
  if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
  if (hasFinalAssistantSnapshot && !pendingRunning) return true;
  if (!pendingRunning) return false;
  if (!hasAuthoritativeHistoryMaterialization(thread)) return false;
  if (latestTurnContainsPendingUserEcho(thread, state, parseUserMessageParts) === true) return false;
  if (pendingPrompt) return true;
  const baselineTurnCount = Math.max(0, Number(state.activeThreadPendingTurnBaselineTurnCount || 0));
  const incomingTurnCount = Array.isArray(thread?.turns) ? thread.turns.length : 0;
  return incomingTurnCount <= baselineTurnCount;
}

export function captureLiveCommentarySnapshot(state = {}, threadId = "", epoch = 0) {
  const normalizedThreadId = String(threadId || "").trim();
  const current = cloneCommentaryBlock(state.activeThreadCommentaryCurrent);
  const currentThreadId = String(current?.threadId || normalizedThreadId).trim();
  const matchesThread = !!current && (!normalizedThreadId || !currentThreadId || currentThreadId === normalizedThreadId);
  const archive = Array.isArray(state.activeThreadCommentaryArchive)
    ? state.activeThreadCommentaryArchive.map((block) => cloneCommentaryBlock(block)).filter(Boolean)
    : [];
  if (!matchesThread && !archive.length && state.activeThreadCommentaryArchiveVisible !== true) return null;
  return {
    epoch: Math.max(0, Number(epoch || 0)),
    current: matchesThread ? { ...current, threadId: currentThreadId || normalizedThreadId } : null,
    archive,
    visible: state.activeThreadCommentaryArchiveVisible === true,
    expanded: state.activeThreadCommentaryArchiveExpanded === true,
  };
}

export function resolveLiveCommentarySnapshot(snapshot, historySnapshot, options = {}) {
  const {
    currentEpoch = 0,
    threadId = "",
    suppressStalePendingHistory = false,
    threadIncomplete = false,
  } = options;
  const events = [];
  const nextHistorySnapshot = cloneCommentarySnapshot(historySnapshot);

  if (suppressStalePendingHistory && nextHistorySnapshot?.current) {
    events.push({
      kind: "history.commentary:suppress_stale_pending",
      payload: {
        threadId,
        key: String(nextHistorySnapshot.current.key || "").trim(),
        chars: String(nextHistorySnapshot.current.text || "").length,
      },
    });
    nextHistorySnapshot.current = null;
  }

  let effectiveSnapshot =
    snapshot && Math.max(0, Number(snapshot.epoch || 0)) === Math.max(0, Number(currentEpoch || 0))
      ? cloneCommentarySnapshot(snapshot)
      : null;

  if (snapshot && !effectiveSnapshot) {
    events.push({
      kind: "history.commentary:drop_stale_snapshot",
      payload: {
        threadId,
        snapshotEpoch: Math.max(0, Number(snapshot.epoch || 0)),
        currentEpoch: Math.max(0, Number(currentEpoch || 0)),
        key: String(snapshot.current?.key || "").trim(),
      },
    });
  }

  if (!effectiveSnapshot && nextHistorySnapshot) {
    effectiveSnapshot = nextHistorySnapshot;
  } else if (effectiveSnapshot && nextHistorySnapshot) {
    const historyCurrent = nextHistorySnapshot.current ? cloneCommentaryBlock(nextHistorySnapshot.current) : null;
    const effectiveCurrent = effectiveSnapshot.current ? cloneCommentaryBlock(effectiveSnapshot.current) : null;
    const historyCurrentKey = String(historyCurrent?.key || "").trim();
    const effectiveCurrentKey = String(effectiveCurrent?.key || "").trim();
    const historyCurrentText = String(historyCurrent?.text || "");
    const effectiveCurrentText = String(effectiveCurrent?.text || "");
    const historyCurrentTools = JSON.stringify(Array.isArray(historyCurrent?.tools) ? historyCurrent.tools : []);
    const effectiveCurrentTools = JSON.stringify(Array.isArray(effectiveCurrent?.tools) ? effectiveCurrent.tools : []);
    const shouldReplaceCurrent =
      !!historyCurrent &&
      (
        !effectiveCurrent ||
        historyCurrentKey !== effectiveCurrentKey ||
        historyCurrentText !== effectiveCurrentText ||
        historyCurrentTools !== effectiveCurrentTools
      );

    if (shouldReplaceCurrent) {
      effectiveSnapshot.current = historyCurrent;
      effectiveSnapshot.archive = nextHistorySnapshot.archive;
      effectiveSnapshot.visible = false;
      effectiveSnapshot.expanded = false;
      events.push({
        kind: effectiveCurrent ? "history.commentary:replace_current" : "history.commentary:promote_current",
        payload: {
          threadId,
          archiveCount: nextHistorySnapshot.archive.length,
          chars: historyCurrentText.length,
          previousKey: effectiveCurrentKey,
          nextKey: historyCurrentKey,
        },
      });
    }

    const shouldClearCurrent =
      !historyCurrent &&
      !!effectiveCurrent &&
      (
        nextHistorySnapshot.visible === true ||
        suppressStalePendingHistory ||
        !threadIncomplete
      );

    if (shouldClearCurrent) {
      effectiveSnapshot.current = null;
      effectiveSnapshot.archive = nextHistorySnapshot.archive;
      effectiveSnapshot.visible = nextHistorySnapshot.visible === true;
      effectiveSnapshot.expanded = false;
      events.push({
        kind: "history.commentary:clear_current",
        payload: {
          threadId,
          archiveCount: nextHistorySnapshot.archive.length,
          previousKey: effectiveCurrentKey,
          stalePending: suppressStalePendingHistory === true,
          historyVisible: nextHistorySnapshot.visible === true,
          incomplete: !!threadIncomplete,
        },
      });
    }

    if (nextHistorySnapshot.archive.length > effectiveSnapshot.archive.length) {
      effectiveSnapshot.archive = nextHistorySnapshot.archive;
    }
    if (!effectiveSnapshot.visible && nextHistorySnapshot.visible) {
      effectiveSnapshot.visible = true;
    }
    if (effectiveSnapshot.visible !== true) {
      effectiveSnapshot.expanded = false;
    }
  }

  return {
    effectiveSnapshot,
    events,
  };
}
