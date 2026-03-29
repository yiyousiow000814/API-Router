import { subscriptionIncludesWorkspace } from "./wsClient.js";

function resolveSubscribedWorkspaces(state = {}) {
  if (Array.isArray(state.wsSubscribedWorkspaceTargets) && state.wsSubscribedWorkspaceTargets.length) {
    return state.wsSubscribedWorkspaceTargets;
  }
  if (Array.isArray(state.wsRequestedWorkspaceTargets) && state.wsRequestedWorkspaceTargets.length) {
    return state.wsRequestedWorkspaceTargets;
  }
  return [String(state.wsSubscribedWorkspaceTarget || state.wsRequestedWorkspaceTarget || "").trim().toLowerCase()];
}

export function applyPreparedThreadState(state = {}, threadId = "", prepared = {}, options = {}, deps = {}) {
  const {
    renderComposerContextLeft = () => {},
    syncEventSubscription = () => {},
  } = deps;
  const {
    inlineCommentaryArchiveCount = 0,
    tokenUsage = null,
    started = false,
    historyStatusType = "",
    target = "unknown",
    resolvedRolloutPath = "",
  } = prepared;

  state.activeThreadInlineCommentaryArchiveCount = inlineCommentaryArchiveCount;
  state.activeThreadTokenUsage = tokenUsage;
  renderComposerContextLeft();
  state.activeThreadStarted = started;
  state.activeThreadHistoryStatusType = historyStatusType;
  if (target !== "unknown") state.activeThreadWorkspace = target;
  if (resolvedRolloutPath) state.activeThreadRolloutPath = resolvedRolloutPath;

  const subscribedWorkspaces = resolveSubscribedWorkspaces(state);
  if (
    target !== "unknown" &&
    state.activeThreadId === threadId &&
    (
      state.wsSubscribedEvents !== true ||
      !subscriptionIncludesWorkspace(subscribedWorkspaces, target)
    )
  ) {
    syncEventSubscription();
  }
}

export function shouldSkipHistoryRender(state = {}, renderSig = "", options = {}) {
  return !options.forceRender && state.activeThreadRenderSig === renderSig;
}

export function shouldExitHistoryWindowMode(state = {}, threadId = "", messageCount = 0, threshold = 0) {
  return (
    state.historyWindowEnabled &&
    state.historyWindowThreadId === threadId &&
    messageCount < threshold
  );
}

export function clearHistoryWindowState(state = {}) {
  state.historyWindowEnabled = false;
  state.historyWindowThreadId = "";
  state.historyWindowStart = 0;
  state.historyAllMessages = [];
}
