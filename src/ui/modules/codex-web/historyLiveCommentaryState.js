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
  const pendingPrompt = String(state.activeThreadPendingUserMessage || "").trim();
  if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
  if (!pendingPrompt) return false;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
  for (const item of items) {
    if (String(item?.type || "").trim() !== "userMessage") continue;
    const parsed = parseUserMessageParts(item);
    const text = String(parsed?.text || "").trim();
    if (text && text === pendingPrompt) return true;
  }
  return false;
}

export function shouldSuppressStalePendingHistoryLiveState(thread, state = {}, parseUserMessageParts) {
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  const pendingRunning = state.activeThreadPendingTurnRunning === true;
  const finalAssistantThreadId = String(state.activeThreadLastFinalAssistantThreadId || "").trim();
  const finalAssistantText = String(state.activeThreadLastFinalAssistantText || "").trim();
  const hasFinalAssistantSnapshot = finalAssistantThreadId === threadId && !!finalAssistantText;
  if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
  if (hasFinalAssistantSnapshot && !pendingRunning) return true;
  if (!pendingRunning) return false;
  if (latestTurnContainsPendingUserEcho(thread, state, parseUserMessageParts) === true) return false;
  const pendingPrompt = String(state.activeThreadPendingUserMessage || "").trim();
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
