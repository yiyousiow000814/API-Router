import { mergeHistoryTurns } from "./historyLoader.js";

export function applyHistoryPageToState(state, threadId, history, options = {}) {
  const page = history?.page || {};
  const incomingThread = history?.thread || null;
  const incomingTurns = Array.isArray(incomingThread?.turns) ? incomingThread.turns : [];
  const mergeDirection = options.mergeDirection === "prepend" ? "prepend" : "replace_or_append";
  let mergedTurns = incomingTurns;

  if (mergeDirection === "prepend") {
    const existingTurns = Array.isArray(state.activeThreadHistoryTurns) ? state.activeThreadHistoryTurns : [];
    mergedTurns = mergeHistoryTurns(incomingTurns, existingTurns);
  } else {
    const shouldReplaceTurns = !!page?.incomplete || !!state.activeThreadHistoryIncomplete;
    mergedTurns = shouldReplaceTurns
      ? incomingTurns
      : mergeHistoryTurns(
          state.activeThreadHistoryThreadId === threadId ? state.activeThreadHistoryTurns : [],
          incomingTurns
        );
  }

  state.activeThreadHistoryTurns = mergedTurns;
  state.activeThreadHistoryThreadId = threadId;
  state.activeThreadHistoryHasMore = !!page?.hasMore;
  state.activeThreadHistoryIncomplete = !!page?.incomplete;
  state.activeThreadHistoryStatusType = String(incomingThread?.status?.type || "").trim().toLowerCase();
  state.activeThreadHistoryBeforeCursor = String(page?.beforeCursor || "").trim();
  state.activeThreadHistoryTotalTurns =
    Number(page?.totalTurns || mergedTurns.length || incomingTurns.length || 0) ||
    mergedTurns.length ||
    incomingTurns.length ||
    0;

  return {
    page,
    incomingThread,
    mergedTurns,
    thread: incomingThread ? { ...incomingThread, turns: mergedTurns, page } : null,
  };
}
