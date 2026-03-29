export function beginHistoryLoad(state = {}) {
  const reqSeq = (Number(state.activeThreadHistoryReqSeq || 0) + 1) | 0;
  state.activeThreadHistoryReqSeq = reqSeq;
  state.activeThreadLiveLastPollMs = Date.now();
  return reqSeq;
}

export async function tryApplySeededHistory(threadId, options = {}, deps = {}) {
  const {
    windowRef = {},
    applyThreadToChat = async () => {},
  } = deps;
  try {
    const e2e = windowRef.__webCodexE2E;
    if (e2e && typeof e2e.getThreadHistory === "function") {
      const seeded = e2e.getThreadHistory(threadId);
      if (seeded) {
        try { windowRef.__webCodexE2E_lastHistorySource = "seed"; } catch {}
        await applyThreadToChat(seeded, options);
        return true;
      }
    }
  } catch (error) {
    try {
      if (windowRef.__webCodexE2E) {
        windowRef.__webCodexE2E_seedHistoryError = String(error && error.message ? error.message : error);
      }
    } catch {}
  }
  return false;
}

export async function fetchAndApplyThreadHistory(threadId, options = {}, deps = {}) {
  const {
    state = {},
    reqSeq = 0,
    api,
    buildThreadHistoryUrl,
    applyHistoryPageToState,
    applyThreadToChat,
    pushLiveDebugEvent = () => {},
    windowRef = {},
  } = deps;
  const limit = Number(options.limit || state.historyWindowSize || 160) || 160;
  const history = await api(buildThreadHistoryUrl(threadId, {
    workspace: options.workspace,
    rolloutPath: options.rolloutPath,
    limit,
  }, state.activeThreadWorkspace), {
    signal: options.signal,
  });
  if (reqSeq !== state.activeThreadHistoryReqSeq) return;
  if (state.activeThreadId && state.activeThreadId !== threadId) return;
  const { page, mergedTurns, thread } = applyHistoryPageToState(state, threadId, history);
  if (!thread) return;
  try { windowRef.__webCodexE2E_lastHistorySource = "history"; } catch {}
  await applyThreadToChat(thread, {
    ...options,
    forceHistoryWindow: !!page?.hasMore,
    historyReqSeq: reqSeq,
  });
  pushLiveDebugEvent("history.load:success", {
    threadId: String(threadId || ""),
    workspace: String(options.workspace || state.activeThreadWorkspace || ""),
    turns: mergedTurns.length,
    hasMore: !!page?.hasMore,
  });
}

export async function runHistoryLoad(threadId, options = {}, deps = {}) {
  const {
    tryApplySeededHistory: tryApplySeededHistoryRef = tryApplySeededHistory,
    fetchAndApplyThreadHistory: fetchAndApplyThreadHistoryRef = fetchAndApplyThreadHistory,
  } = deps;
  const usedSeed = await tryApplySeededHistoryRef(threadId, options, deps);
  if (usedSeed) return;
  await fetchAndApplyThreadHistoryRef(threadId, options, deps);
}

export async function finalizeHistoryLoad(state = {}, threadId = "", loadPromise, deps = {}) {
  const {
    setTimeoutRef = setTimeout,
    loadThreadMessages = async () => {},
  } = deps;
  if (state.activeThreadHistoryInFlightPromise === loadPromise) {
    state.activeThreadHistoryInFlightPromise = null;
    state.activeThreadHistoryInFlightThreadId = "";
    const pending = state.activeThreadHistoryPendingRefresh;
    if (pending && pending.threadId === threadId) {
      state.activeThreadHistoryPendingRefresh = null;
      setTimeoutRef(() => {
        if (state.activeThreadId !== threadId) return;
        loadThreadMessages(threadId, pending).catch(() => {});
      }, 0);
    }
  }
}
