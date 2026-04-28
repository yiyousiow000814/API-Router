import { upsertThreadItem } from "./threadMeta.js";

export function createThreadListRefreshModule(deps) {
  const {
    state,
    byId,
    windowRef = window,
    documentRef = document,
    api,
    ensureArrayItems,
    normalizeWorkspaceTarget,
    getWorkspaceTarget,
    getStartCwdForWorkspace,
    sortThreadsByNewest,
    filterThreadsForWorkspace,
    hasDualWorkspaceTargets,
    detectWorkspaceAvailabilityFromThreads,
    buildThreadRenderSig,
    persistThreadsCache,
    syncActiveThreadMetaFromList,
    updateHeaderUi,
    pushThreadAnimDebug,
    recordLocalTask = () => {},
    renderThreads,
    applyWorkspaceUi,
    setStatus,
    THREAD_FORCE_REFRESH_MIN_INTERVAL_MS,
    performanceRef = performance,
    nowRef = Date.now,
  } = deps;

  function isThreadListActuallyVisible() {
    const list = byId("threadList");
    if (!list || !list.isConnected) return false;
    const isActuallyOnscreen = (node) => {
      if (!node) return false;
      const styles = windowRef.getComputedStyle(node);
      if (styles.display === "none" || styles.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const viewportWidth = Math.max(windowRef.innerWidth || 0, documentRef.documentElement?.clientWidth || 0);
      const viewportHeight = Math.max(windowRef.innerHeight || 0, documentRef.documentElement?.clientHeight || 0);
      return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
    };
    if (!isActuallyOnscreen(list)) return false;
    const panel = list.closest(".leftPanel");
    if (panel && !isActuallyOnscreen(panel)) return false;
    return true;
  }

  function scheduleThreadListVisibleAnimationRender(delayMs = 0) {
    if (state.threadListVisibleAnimationTimer) {
      clearTimeout(state.threadListVisibleAnimationTimer);
      state.threadListVisibleAnimationTimer = 0;
    }
    const waitMs = Math.max(0, Number(delayMs || 0));
    state.threadListVisibleAnimationTimer = setTimeout(() => {
      state.threadListVisibleAnimationTimer = 0;
      if (!Array.isArray(state.threadItems) || !state.threadItems.length) return;
      if (!isThreadListActuallyVisible()) return;
      state.threadListAnimateNextRender = true;
      state.threadListAnimateThreadIds = new Set();
      state.threadListExpandAnimateGroupKeys = new Set();
      state.threadListSkipScrollRestoreOnce = true;
      renderThreads(state.threadItems);
    }, waitMs);
  }

  function scheduleThreadListDeferredRender(workspaceTarget, delayMs = 0) {
    const target = normalizeWorkspaceTarget(workspaceTarget);
    const existingTimer = Number(state.threadListDeferredRenderTimerByWorkspace?.[target] || 0);
    if (existingTimer) {
      clearTimeout(existingTimer);
      state.threadListDeferredRenderTimerByWorkspace[target] = 0;
    }
    const waitMs = Math.max(0, Number(delayMs || 0));
    state.threadListDeferredRenderTimerByWorkspace[target] = setTimeout(() => {
      state.threadListDeferredRenderTimerByWorkspace[target] = 0;
      if (getWorkspaceTarget() !== target) return;
      const latest = Array.isArray(state.threadItemsByWorkspace[target]) ? state.threadItemsByWorkspace[target] : [];
      state.threadItemsAll = latest;
      syncActiveThreadMetaFromList();
      state.threadListAnimateNextRender = false;
      state.threadListAnimateThreadIds = new Set();
      applyThreadFilter();
      updateHeaderUi();
      pushThreadAnimDebug("threadListDeferredRender:flush", {
        target,
        count: latest.length,
      });
    }, waitMs);
  }

  function applyThreadFilter() {
    const startedAt = performanceRef.now();
    const currentTarget = getWorkspaceTarget();
    const sourceCount = Array.isArray(state.threadItemsAll) ? state.threadItemsAll.length : 0;
    try {
      state.threadItems = sortThreadsByNewest(
        filterThreadsForWorkspace(state.threadItemsAll, {
          hasDualWorkspaceTargets: hasDualWorkspaceTargets(),
          currentTarget,
          startCwd: getStartCwdForWorkspace(currentTarget),
        })
      );
      renderThreads(state.threadItems);
    } finally {
      recordLocalTask({
        command: "thread filter render",
        elapsedMs: performanceRef.now() - startedAt,
        fields: {
          workspace: currentTarget,
          sourceCount,
          renderedCount: Array.isArray(state.threadItems) ? state.threadItems.length : 0,
        },
      });
    }
  }

  function updateWorkspaceAvailabilityFromThreads(items) {
    if (!Array.isArray(items) || !items.length) return;
    const nextAvailability = detectWorkspaceAvailabilityFromThreads(items, state.workspaceAvailability);
    updateWorkspaceAvailability(nextAvailability.windowsInstalled, nextAvailability.wsl2Installed, { applyFilter: false });
  }

  function updateWorkspaceAvailability(windowsInstalled, wsl2Installed, options = {}) {
    state.workspaceAvailability = {
      windowsInstalled: !!windowsInstalled,
      wsl2Installed: !!wsl2Installed,
    };
    applyWorkspaceUi();
    if (state.threadItemsAll.length && options.applyFilter !== false) applyThreadFilter();
  }

  function upsertProvisionalThreadItem(item) {
    const threadId = String(item?.id || item?.threadId || "").trim();
    if (!threadId) return false;
    const target = normalizeWorkspaceTarget(
      String(item?.__workspaceQueryTarget || item?.workspace || getWorkspaceTarget()).trim()
    );
    const previousItems = Array.isArray(state.threadItemsByWorkspace[target])
      ? state.threadItemsByWorkspace[target]
      : [];
    const nextItems = upsertThreadItem(previousItems, {
      ...item,
      __workspaceQueryTarget: target,
    });
    state.threadItemsByWorkspace[target] = nextItems;
    state.threadWorkspaceHydratedByWorkspace[target] = true;
    state.threadListRenderSigByWorkspace[target] = buildThreadRenderSig(nextItems);
    persistThreadsCache();
    updateWorkspaceAvailabilityFromThreads(nextItems);
    if (getWorkspaceTarget() === target) {
      state.threadItemsAll = nextItems;
      syncActiveThreadMetaFromList();
      applyThreadFilter();
      updateHeaderUi();
    }
    return true;
  }

  async function refreshThreads(workspaceTarget = getWorkspaceTarget(), options = {}) {
    const refreshStartedAt = performanceRef.now();
    const target = normalizeWorkspaceTarget(workspaceTarget);
    const force = options.force === true;
    if (force) {
      const now = Date.now();
      const last = Number(state.threadForceRefreshLastMsByWorkspace[target] || 0);
      if (now - last < THREAD_FORCE_REFRESH_MIN_INTERVAL_MS) return;
      state.threadForceRefreshLastMsByWorkspace[target] = now;
    }
    const reqSeq = (state.threadRefreshReqSeqByWorkspace[target] || 0) + 1;
    state.threadRefreshReqSeqByWorkspace[target] = reqSeq;

    if (state.threadRefreshAbortByWorkspace[target]) {
      try {
        state.threadRefreshAbortByWorkspace[target].abort();
      } catch {}
    }
    const controller = new AbortController();
    state.threadRefreshAbortByWorkspace[target] = controller;

    const silent = options.silent === true;
    const workspace = encodeURIComponent(target);
    const query = force ? `workspace=${workspace}&force=true` : `workspace=${workspace}`;
    const activeBefore = getWorkspaceTarget() === target;
    pushThreadAnimDebug("refreshThreads:start", {
      target,
      force,
      silent,
      activeBefore,
    });

    if (activeBefore && !silent) {
      state.threadListLoading = true;
      state.threadListLoadingTarget = target;
      if (!state.threadListPreferLoadingPlaceholder) {
        renderThreads(state.threadItems);
      }
    }

    try {
      const previousItems = Array.isArray(state.threadItemsByWorkspace[target])
        ? state.threadItemsByWorkspace[target]
        : [];
      const threadListNode = byId("threadList");
      const domWasPlaceholder =
        !!threadListNode?.querySelector?.(".threadListState, .threadListPlainState") ||
        !threadListNode?.querySelector?.(".groupCard, .itemCard");
      const previousIdSet = new Set(previousItems.map((item) => item?.id || item?.threadId || "").filter(Boolean));
      const data = await api(`/codex/threads?${query}`, { signal: controller.signal });
      const apiTrace = data && typeof data === "object" ? data.__apiTrace || null : null;
      recordLocalTask({
        command: "thread refresh fetch",
        elapsedMs: performanceRef.now() - refreshStartedAt,
        fields: {
          workspace: target,
          force,
          requestId: String(apiTrace?.requestId || ""),
          responseBytes: Number(apiTrace?.responseBytes || 0),
          headersMs: Number(apiTrace?.headersMs || 0),
          bodyReadMs: Number(apiTrace?.bodyReadMs || 0),
          parseMs: Number(apiTrace?.parseMs || 0),
        },
      });
      const meta = data && typeof data === "object" ? data.meta || null : null;
      if (meta && typeof meta === "object") {
        const totalMs = Number(meta.totalMs || 0);
        const rebuildMs = Number(meta.rebuildMs || 0);
        const pagesScanned = Number(meta.pagesScanned || 0);
        const cacheHit = !!meta.cacheHit;
        if (totalMs >= 1500) {
          const cacheLabel = cacheHit ? "cache" : "rebuild";
          setStatus(
            `${target.toUpperCase()} chats ${cacheLabel} total ${Math.round(totalMs)}ms` +
              (rebuildMs > 0 ? ` rebuild ${Math.round(rebuildMs)}ms` : "") +
              (pagesScanned > 0 ? ` pages ${pagesScanned}` : "")
          );
        }
      }
      if ((state.threadRefreshReqSeqByWorkspace[target] || 0) !== reqSeq) return;
      const materializeStartedAt = performanceRef.now();
      const items = ensureArrayItems(data.items).map((item) => {
        if (!item || typeof item !== "object") return item;
        return {
          ...item,
          __workspaceQueryTarget: target,
        };
      });
      recordLocalTask({
        command: "thread refresh materialize",
        elapsedMs: performanceRef.now() - materializeStartedAt,
        fields: {
          workspace: target,
          force,
          requestId: String(apiTrace?.requestId || ""),
          itemCount: items.length,
          responseBytes: Number(apiTrace?.responseBytes || 0),
        },
      });
      const refreshPendingWithEmptyResult =
        !force && !!meta?.refreshing && items.length === 0 && previousItems.length > 0;
      if (refreshPendingWithEmptyResult) {
        pushThreadAnimDebug("refreshThreads:keepStaleWhileRefreshing", {
          target,
          previousCount: previousItems.length,
        });
        state.threadWorkspaceHydratedByWorkspace[target] = true;
        if (!state.threadRefreshCompletedAtByWorkspace || typeof state.threadRefreshCompletedAtByWorkspace !== "object") {
          state.threadRefreshCompletedAtByWorkspace = {};
        }
        state.threadRefreshCompletedAtByWorkspace[target] = nowRef();
        if (getWorkspaceTarget() === target) {
          state.threadItemsAll = previousItems;
          applyThreadFilter();
          updateHeaderUi();
        }
        return;
      }
      const nextSig = buildThreadRenderSig(items);
      const nextNewThreadIdSet = new Set();
      for (const item of items) {
        const id = item?.id || item?.threadId || "";
        if (!id || previousIdSet.has(id)) continue;
        nextNewThreadIdSet.add(id);
      }
      const shouldAnimateFullList = previousItems.length === 0 && items.length > 0;
      const canAnimatePendingVisibleNow =
        !!state.threadListPendingVisibleAnimationByWorkspace?.[target] && isThreadListActuallyVisible() && items.length > 0;
      state.threadItemsByWorkspace[target] = items;
      state.threadWorkspaceHydratedByWorkspace[target] = true;
      if (!state.threadRefreshCompletedAtByWorkspace || typeof state.threadRefreshCompletedAtByWorkspace !== "object") {
        state.threadRefreshCompletedAtByWorkspace = {};
      }
      state.threadRefreshCompletedAtByWorkspace[target] = nowRef();
      const persistStartedAt = performanceRef.now();
      try {
        persistThreadsCache();
      } finally {
        recordLocalTask({
          command: "thread cache persist",
          elapsedMs: performanceRef.now() - persistStartedAt,
          fields: {
            workspace: target,
            force,
            requestId: String(apiTrace?.requestId || ""),
            itemCount: items.length,
          },
        });
      }
      if (getWorkspaceTarget() !== target) return;
      const shouldAnimateVisibleListFromPlaceholder = domWasPlaceholder && items.length > 0;
      const animationHoldRemainingMs = Math.max(
        0,
        Number(state.threadListAnimationHoldUntilByWorkspace?.[target] || 0) - Date.now()
      );
      const shouldDeferVisibleRerender =
        !force &&
        getWorkspaceTarget() === target &&
        documentRef.body.classList.contains("drawer-left-open") &&
        animationHoldRemainingMs > 0 &&
        !shouldAnimateFullList &&
        !shouldAnimateVisibleListFromPlaceholder &&
        !canAnimatePendingVisibleNow;
      pushThreadAnimDebug("refreshThreads:data", {
        target,
        force,
        silent,
        domWasPlaceholder,
        previousCount: previousItems.length,
        nextCount: items.length,
        sigSame: state.threadListRenderSigByWorkspace[target] === nextSig,
        prevSig: String(state.threadListRenderSigByWorkspace[target] || "").slice(0, 180),
        nextSig: String(nextSig || "").slice(0, 180),
        shouldAnimateFullList,
        shouldAnimateVisibleListFromPlaceholder,
        canAnimatePendingVisibleNow,
        animationHoldRemainingMs,
        shouldDeferVisibleRerender,
        pendingVisibleAnimation: !!state.threadListPendingVisibleAnimationByWorkspace?.[target],
        listActuallyVisible: isThreadListActuallyVisible(),
      });
      if (
        !force &&
        state.threadListRenderSigByWorkspace[target] === nextSig &&
        !shouldAnimateVisibleListFromPlaceholder &&
        !canAnimatePendingVisibleNow
      ) {
        state.threadListAnimateThreadIds = new Set();
        return;
      }
      state.threadListRenderSigByWorkspace[target] = nextSig;
      if (shouldDeferVisibleRerender) {
        pushThreadAnimDebug("refreshThreads:deferVisibleRerender", {
          target,
          remainingMs: animationHoldRemainingMs,
        });
        scheduleThreadListDeferredRender(target, animationHoldRemainingMs + 16);
        return;
      }
      state.threadItemsAll = items;
      if (items.length > 0 && !isThreadListActuallyVisible()) {
        state.threadListPendingVisibleAnimationByWorkspace[target] = true;
      }
      if (shouldAnimateFullList || shouldAnimateVisibleListFromPlaceholder || canAnimatePendingVisibleNow) {
        state.threadListAnimateNextRender = true;
        state.threadListAnimateThreadIds = new Set();
      } else {
        state.threadListAnimateNextRender = false;
        state.threadListAnimateThreadIds = nextNewThreadIdSet;
      }
      updateWorkspaceAvailabilityFromThreads(items);
      syncActiveThreadMetaFromList();
      applyThreadFilter();
      updateHeaderUi();
    } finally {
      recordLocalTask({
        command: "thread refresh total",
        elapsedMs: performanceRef.now() - refreshStartedAt,
        fields: {
          workspace: target,
          force,
          silent,
        },
      });
      if (state.threadRefreshAbortByWorkspace[target] === controller) {
        state.threadRefreshAbortByWorkspace[target] = null;
      }
      if ((state.threadRefreshReqSeqByWorkspace[target] || 0) === reqSeq && getWorkspaceTarget() === target && !silent) {
        const list = byId("threadList");
        const hadLoadingPlaceholder = !!list?.querySelector?.(".threadListState");
        const needsFinalRender = hadLoadingPlaceholder || !Array.isArray(state.threadItems) || state.threadItems.length === 0;
        state.threadListLoading = false;
        state.threadListLoadingTarget = "";
        state.threadListPreferLoadingPlaceholder = false;
        const sidebarOpen = documentRef.body.classList.contains("drawer-left-open");
        pushThreadAnimDebug("refreshThreads:finally", {
          target,
          silent,
          hadLoadingPlaceholder,
          needsFinalRender,
          sidebarOpen,
          pendingSidebarOpenAnimation: !!state.threadListPendingSidebarOpenAnimation,
        });
        if (state.threadListPendingSidebarOpenAnimation) {
          state.threadListPendingSidebarOpenAnimation = false;
          if (sidebarOpen && Array.isArray(state.threadItems) && state.threadItems.length) {
            scheduleThreadListVisibleAnimationRender(230);
            return;
          }
        }
        if (needsFinalRender) renderThreads(state.threadItems);
      }
    }
  }

  return {
    applyThreadFilter,
    isThreadListActuallyVisible,
    refreshThreads,
    scheduleThreadListDeferredRender,
    scheduleThreadListVisibleAnimationRender,
    upsertProvisionalThreadItem,
    updateWorkspaceAvailability,
    updateWorkspaceAvailabilityFromThreads,
  };
}
