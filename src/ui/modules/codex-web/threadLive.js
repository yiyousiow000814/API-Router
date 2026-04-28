import { resolveCurrentThreadId } from "./runtimeState.js";

export function resolveThreadAutoRefreshInterval(wsOpen, wsSubscribed, connectedMs, disconnectedMs) {
  return wsOpen && wsSubscribed ? connectedMs : disconnectedMs;
}

export function resolveThreadAutoRefreshTargets(currentTarget, availability = {}) {
  const normalizedCurrent =
    String(currentTarget || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
  const windowsAvailable = availability.windowsInstalled !== false;
  const wslAvailable = availability.wsl2Installed !== false;
  if (normalizedCurrent === "wsl2") return wslAvailable ? ["wsl2"] : [];
  return windowsAvailable ? ["windows"] : [];
}

export function resolveActiveThreadLivePollInterval(
  liveMs,
  wsFallbackMs = 0,
  wsOpen = false,
  wsSubscribed = false
) {
  const normalized = Number(liveMs || 0);
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  if (!wsOpen || !wsSubscribed) return normalized;
  const fallback = Number(wsFallbackMs || 0);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

export function shouldPollActiveThreadLive({
  threadId,
  activeMainTab,
  activeThreadStarted,
  activeThreadHistoryIncomplete,
  activeThreadPendingTurnRunning,
  activeThreadPendingUserMessage,
  activeThreadPendingAssistantMessage,
  activeThreadOpenState,
}) {
  if (!String(threadId || "").trim()) return false;
  if (String(activeMainTab || "").trim() !== "chat") return false;
  if (activeThreadHistoryIncomplete === true) return true;
  if (activeThreadPendingTurnRunning === true) return true;
  if (String(activeThreadPendingUserMessage || "").trim()) return true;
  if (String(activeThreadPendingAssistantMessage || "").trim()) return true;
  if (activeThreadOpenState?.resumeRequired === true) return true;
  return false;
}

export function createThreadLiveModule(deps) {
  const {
    state,
    byId,
    waitMs,
    setStatus,
    refreshThreads,
    refreshCodexVersions = async () => {},
    getWorkspaceTarget,
    loadThreadMessages,
    THREAD_PULL_REFRESH_TRIGGER_PX,
    THREAD_PULL_REFRESH_MAX_PX,
    THREAD_PULL_REFRESH_MIN_MS,
    THREAD_PULL_HINT_CLEAR_DELAY_MS,
    THREAD_AUTO_REFRESH_CONNECTED_MS,
    THREAD_AUTO_REFRESH_DISCONNECTED_MS,
    ACTIVE_THREAD_LIVE_POLL_MS,
    ACTIVE_THREAD_LIVE_POLL_WS_FALLBACK_MS = 0,
    WebSocketRef = WebSocket,
    documentRef = typeof document === "undefined" ? null : document,
    setIntervalRef = setInterval,
  } = deps;

  function isThreadAutoRefreshVisible() {
    return String(documentRef?.visibilityState || "visible").trim().toLowerCase() !== "hidden";
  }

  function shouldRecoverWorkspaceAvailability() {
    const availability = state.workspaceAvailability || {};
    return !availability.windowsInstalled || !availability.wsl2Installed;
  }

  function maybeRefreshCodexVersions(now, minInterval) {
    if (!shouldRecoverWorkspaceAvailability()) return;
    if (state.codexVersionRefreshInFlight) return;
    const lastMs = Number(state.codexVersionRefreshLastMs || 0);
    if (now - lastMs < minInterval) return;
    state.codexVersionRefreshLastMs = now;
    state.codexVersionRefreshInFlight = true;
    refreshCodexVersions()
      .catch(() => null)
      .finally(() => {
        state.codexVersionRefreshInFlight = false;
      });
  }

  async function refreshThreadsFromPullGesture() {
    if (state.threadPullRefreshing) return;
    const list = byId("threadList");
    const hint = byId("threadPullHint");
    const hintText = byId("threadPullHintText");
    if (!list || !hint || !hintText) return;
    const startedAt = Date.now();
    state.threadPullRefreshing = true;
    list.style.transition = "transform 140ms ease";
    list.style.transform = `translateY(${Math.round(THREAD_PULL_REFRESH_TRIGGER_PX * 0.45)}px)`;
    hint.classList.add("show");
    hint.classList.add("refreshing");
    hintText.textContent = "Refreshing chats...";
    try {
      await refreshThreads(getWorkspaceTarget(), { force: true });
      setStatus(`Refreshed ${getWorkspaceTarget().toUpperCase()} chats.`);
    } catch (error) {
      setStatus(error?.message || "Refresh failed.", true);
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < THREAD_PULL_REFRESH_MIN_MS) {
        await waitMs(THREAD_PULL_REFRESH_MIN_MS - elapsed);
      }
      state.threadPullRefreshing = false;
      setTimeout(() => {
        list.style.transform = "";
        hint.classList.remove("show");
        hint.classList.remove("refreshing");
        setTimeout(() => {
          if (!state.threadPullRefreshing) hintText.textContent = "";
        }, THREAD_PULL_HINT_CLEAR_DELAY_MS);
      }, 120);
    }
  }

  function wireThreadPullToRefresh() {
    const list = byId("threadList");
    const hint = byId("threadPullHint");
    const hintText = byId("threadPullHintText");
    if (!list || !hint || !hintText) return;
    let startY = 0;
    let pullPx = 0;
    let tracking = false;
    let nestedScrollSource = null;
    let waitingNestedReachTop = false;

    const resetPull = () => {
      pullPx = 0;
      list.style.transition = "transform 140ms ease";
      list.style.transform = "";
      if (!state.threadPullRefreshing) {
        hint.classList.remove("show");
        hint.classList.remove("refreshing");
        hintText.textContent = "";
      }
    };

    list.addEventListener(
      "touchstart",
      (event) => {
        if (state.threadPullRefreshing) return;
        if (event.touches.length !== 1) return;
        const target = event.target instanceof Element ? event.target : null;
        const innerGroupBody = target?.closest?.(".groupBody");
        startY = event.touches[0].clientY;
        pullPx = 0;
        nestedScrollSource = innerGroupBody && list.contains(innerGroupBody) ? innerGroupBody : null;
        waitingNestedReachTop = !!nestedScrollSource;
        if (nestedScrollSource) {
          tracking = nestedScrollSource.scrollTop <= 0 && list.scrollTop <= 0;
          return;
        }
        if (list.scrollTop > 0) return;
        tracking = true;
      },
      { passive: true }
    );

    list.addEventListener(
      "touchmove",
      (event) => {
        if (state.threadPullRefreshing) return;
        const y = event.touches[0]?.clientY ?? startY;
        if (!tracking && waitingNestedReachTop && nestedScrollSource) {
          if (nestedScrollSource.scrollTop > 0) return;
          if (list.scrollTop > 0) return;
          const armRaw = y - startY;
          if (armRaw <= 0) return;
          tracking = true;
          waitingNestedReachTop = false;
          startY = y;
          pullPx = 0;
          return;
        }
        if (!tracking) return;
        const raw = y - startY;
        if (raw <= 0) {
          resetPull();
          return;
        }
        if (list.scrollTop > 0) {
          tracking = false;
          resetPull();
          return;
        }
        event.preventDefault();
        pullPx = Math.min(THREAD_PULL_REFRESH_MAX_PX, raw * 0.55);
        list.style.transition = "none";
        list.style.transform = `translateY(${Math.round(pullPx)}px)`;
        hint.classList.add("show");
        hint.classList.remove("refreshing");
        hintText.textContent =
          pullPx >= THREAD_PULL_REFRESH_TRIGGER_PX ? "Release to refresh" : "Pull to refresh";
      },
      { passive: false }
    );

    const endPull = () => {
      if (!tracking) {
        nestedScrollSource = null;
        waitingNestedReachTop = false;
        return;
      }
      tracking = false;
      nestedScrollSource = null;
      waitingNestedReachTop = false;
      if (pullPx >= THREAD_PULL_REFRESH_TRIGGER_PX && !state.threadPullRefreshing) {
        refreshThreadsFromPullGesture().catch(() => {});
        return;
      }
      resetPull();
    };

    list.addEventListener("touchend", endPull, { passive: true });
    list.addEventListener("touchcancel", endPull, { passive: true });
  }

  function startThreadAutoRefreshLoop() {
    setIntervalRef(() => {
      if (!isThreadAutoRefreshVisible()) return;
      if (state.threadAutoRefreshInFlight) return;
      const refreshTargets = resolveThreadAutoRefreshTargets(
        getWorkspaceTarget(),
        state.workspaceAvailability || {}
      );
      const wsOpen = !!(state.ws && state.ws.readyState === WebSocketRef.OPEN);
      const wsSubscribed = !!(wsOpen && state.wsSubscribedEvents);
      const minInterval = resolveThreadAutoRefreshInterval(
        wsOpen,
        wsSubscribed,
        THREAD_AUTO_REFRESH_CONNECTED_MS,
        THREAD_AUTO_REFRESH_DISCONNECTED_MS
      );
      const now = Date.now();
      const dueTargets = refreshTargets.filter((target) => {
        if (state.threadRefreshAbortByWorkspace?.[target]) return false;
        const lastMs = state.threadAutoRefreshLastMsByWorkspace?.[target] || 0;
        return now - lastMs >= minInterval;
      });
      if (!dueTargets.length) return;
      for (const target of dueTargets) {
        state.threadAutoRefreshLastMsByWorkspace[target] = now;
      }
      maybeRefreshCodexVersions(now, minInterval);
      state.threadAutoRefreshInFlight = true;
      Promise.all(
        dueTargets.map((target) =>
          refreshThreads(target, { force: false, silent: true }).catch(() => null)
        )
      )
        .finally(() => {
          state.threadAutoRefreshInFlight = false;
        });
    }, 1000);
  }

  function startActiveThreadLivePollLoop() {
    setIntervalRef(async () => {
      const threadId = resolveCurrentThreadId(state);
      const wsOpen = !!(state.ws && state.ws.readyState === WebSocketRef.OPEN);
      const wsSubscribed = !!(wsOpen && state.wsSubscribedEvents);
      if (
        !shouldPollActiveThreadLive({
          threadId,
          activeMainTab: state.activeMainTab,
          activeThreadStarted: state.activeThreadStarted,
          activeThreadHistoryIncomplete: state.activeThreadHistoryIncomplete,
          activeThreadPendingTurnRunning: state.activeThreadPendingTurnRunning,
          activeThreadPendingUserMessage: state.activeThreadPendingUserMessage,
          activeThreadPendingAssistantMessage: state.activeThreadPendingAssistantMessage,
          activeThreadOpenState: state.activeThreadOpenState,
        })
      ) return;
      const now = Date.now();
      const last = Number(state.activeThreadLiveLastPollMs || 0);
      const minInterval = resolveActiveThreadLivePollInterval(
        ACTIVE_THREAD_LIVE_POLL_MS,
        ACTIVE_THREAD_LIVE_POLL_WS_FALLBACK_MS,
        wsOpen,
        wsSubscribed
      );
      if (minInterval <= 0) return;
      if (now - last < minInterval) return;
      state.activeThreadLiveLastPollMs = now;
      if (state.activeThreadLivePolling) return;
      state.activeThreadLivePolling = true;
      try {
        await loadThreadMessages(threadId, {
          animateBadge: false,
          workspace: state.activeThreadWorkspace,
          rolloutPath: state.activeThreadRolloutPath,
        });
      } catch {
      } finally {
        state.activeThreadLivePolling = false;
      }
    }, ACTIVE_THREAD_LIVE_POLL_MS);
  }

  return {
    refreshThreadsFromPullGesture,
    wireThreadPullToRefresh,
    startThreadAutoRefreshLoop,
    startActiveThreadLivePollLoop,
  };
}
