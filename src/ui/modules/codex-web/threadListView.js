import { syncPendingTurnRuntime } from "./runtimeState.js";
import {
  resetTransientConnectionStatusForThreadOpen,
  resolveThreadOpenState,
  shouldResumeThreadAfterOpen,
  setThreadOpenState,
} from "./threadOpenState.js";

function splitWorkspaceKeySegments(key) {
  return String(key || "")
    .split("/")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
}

function buildWorkspaceLabelSuffix(segments, depth) {
  const normalizedDepth = Math.max(1, Number(depth) || 1);
  if (!Array.isArray(segments) || segments.length <= 1) return "";
  const parentSegments = segments.slice(0, -1);
  return parentSegments.slice(-normalizedDepth).join("/");
}

function buildDisambiguatedWorkspaceLabels(groupEntries) {
  const entries = Array.isArray(groupEntries) ? groupEntries : [];
  const labelGroups = new Map();
  for (const entry of entries) {
    const label = String(entry?.label || "").trim() || String(entry?.key || "").trim();
    if (!labelGroups.has(label)) labelGroups.set(label, []);
    labelGroups.get(label).push(entry);
  }
  return entries.map((entry) => {
    const key = String(entry?.key || "").trim();
    const label = String(entry?.label || "").trim() || key;
    const matchingEntries = labelGroups.get(label) || [];
    if (matchingEntries.length <= 1) return label;
    const segments = splitWorkspaceKeySegments(key);
    if (segments.length <= 1) return label;
    const maxDepth = Math.max(...matchingEntries.map((item) => splitWorkspaceKeySegments(item?.key).length - 1), 1);
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const suffix = buildWorkspaceLabelSuffix(segments, depth);
      if (!suffix || suffix === label.toLowerCase()) continue;
      const collisions = matchingEntries.filter((item) => {
        const itemSuffix = buildWorkspaceLabelSuffix(splitWorkspaceKeySegments(item?.key), depth);
        return itemSuffix === suffix;
      });
      if (collisions.length === 1) return `${label} (${suffix})`;
    }
    return `${label} (${key})`;
  });
}

export function buildWorkspaceEntries(sourceItems, workspaceKeyOfThread) {
  const groups = new Map();
  const groupLabels = new Map();
  for (const thread of Array.isArray(sourceItems) ? sourceItems : []) {
    const workspaceRef = workspaceKeyOfThread(thread);
    const keyLabel =
      workspaceRef && typeof workspaceRef === "object"
        ? String(workspaceRef.label || workspaceRef.key || "")
        : String(workspaceRef || "");
    const key =
      workspaceRef && typeof workspaceRef === "object"
        ? String(workspaceRef.key || workspaceRef.label || "").toLowerCase()
        : String(keyLabel || "").toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    if (!groupLabels.has(key)) groupLabels.set(key, keyLabel);
    groups.get(key).push(thread);
  }
  const groupEntries = Array.from(groups.entries()).map(([key, items]) => ({
    key,
    label: groupLabels.get(key) || key,
    items,
  }));
  const labels = buildDisambiguatedWorkspaceLabels(groupEntries);
  const orderedGroups = groupEntries
    .map((group, index) => ({
      ...group,
      displayLabel: labels[index] || group.label,
    }))
    .sort((a, b) => {
      const leftLabel = String(a?.displayLabel || a?.label || a?.key || "").trim().toLowerCase();
      const rightLabel = String(b?.displayLabel || b?.label || b?.key || "").trim().toLowerCase();
      const labelCompare = leftLabel.localeCompare(rightLabel, undefined, { numeric: true });
      if (labelCompare !== 0) return labelCompare;
      return String(a?.key || "").localeCompare(String(b?.key || ""), undefined, { numeric: true });
    });
  return orderedGroups.map((group) => [group.displayLabel || group.label, group.items, group.key]);
}

export function filterWorkspaceSectionThreads(threads, favoriteSet, query, workspaceLabel) {
  const normalizedWorkspace = String(workspaceLabel || "").toLowerCase();
  const queryText = String(query || "").trim().toLowerCase();
  return (Array.isArray(threads) ? threads : []).filter((thread) => {
    const id = thread?.id || thread?.threadId || "";
    if (id && favoriteSet?.has?.(id)) return false;
    if (!queryText) return true;
    const lookupId = String(id || "").toLowerCase();
    const title = String(thread?.title || thread?.name || "").toLowerCase();
    return (
      normalizedWorkspace.includes(queryText) ||
      lookupId.includes(queryText) ||
      title.includes(queryText)
    );
  });
}

export function shouldStaggerThreadGroupEnter(entries) {
  const groups = Array.isArray(entries) ? entries : [];
  const populatedGroupCount = groups.filter(([, items]) => Array.isArray(items) && items.length > 0).length;
  return populatedGroupCount > 1;
}

const THREAD_LIST_FALLBACK_VIEWPORT_HEIGHT_PX = 480;
const THREAD_LIST_DRAWER_CHROME_ESTIMATE_PX = 238;
const THREAD_LIST_GROUP_HEADER_ESTIMATE_PX = 40;
const THREAD_LIST_ROW_ESTIMATE_PX = 50;
const THREAD_LIST_STATE_ESTIMATE_PX = 96;
const THREAD_LIST_SCROLL_BUFFER_PX = 8;
const THREAD_LIST_INITIAL_CARD_SYNC_BUDGET = 96;
const THREAD_LIST_INTERACTION_CARD_SYNC_BUDGET = 120;
const THREAD_LIST_ASYNC_CARD_BATCH_SIZE = 96;

function estimateThreadListViewportHeight(windowRef) {
  const visualViewportHeight = Number(windowRef?.visualViewport?.height || 0);
  const windowHeight = Number(windowRef?.innerHeight || 0);
  const viewportHeight =
    visualViewportHeight > 0 ? visualViewportHeight : windowHeight > 0 ? windowHeight : 0;
  if (viewportHeight <= 0) return THREAD_LIST_FALLBACK_VIEWPORT_HEIGHT_PX;
  return Math.max(
    120,
    Math.round(viewportHeight - THREAD_LIST_DRAWER_CHROME_ESTIMATE_PX)
  );
}

function applyEstimatedThreadListScrollability(list, contentHeight, windowRef) {
  const viewportHeight = estimateThreadListViewportHeight(windowRef);
  const canScroll = contentHeight > viewportHeight + THREAD_LIST_SCROLL_BUFFER_PX;
  if (canScroll) {
    list.style.overflowY = "auto";
    list.style.touchAction = "pan-y";
    list.style.overscrollBehaviorY = "contain";
    list.style.webkitOverflowScrolling = "touch";
    return;
  }
  list.style.overflowY = "hidden";
  list.style.touchAction = "none";
  list.style.overscrollBehaviorY = "none";
  list.style.webkitOverflowScrolling = "auto";
  list.scrollTop = 0;
}

export function buildThreadResumeUrl(threadId, options = {}) {
  const params = new URLSearchParams();
  const workspace = String(options.workspace || "").trim();
  const rolloutPath = String(options.rolloutPath || "").trim();
  if (workspace === "windows" || workspace === "wsl2") params.set("workspace", workspace);
  if (rolloutPath) params.set("rolloutPath", rolloutPath);
  const query = params.toString();
  return `/codex/threads/${encodeURIComponent(threadId)}/resume${query ? `?${query}` : ""}`;
}

const OPEN_THREAD_LIVE_FIRST_STATUSES = new Set(["running", "queued", "pending", "active", "reconnecting"]);

function shouldSubscribeLiveBeforeHistory(threadStatusType = "") {
  return OPEN_THREAD_LIVE_FIRST_STATUSES.has(String(threadStatusType || "").trim().toLowerCase());
}

export async function resumeThreadLiveOnOpen({
  threadId,
  workspace,
  rolloutPath,
  threadStatusType = "",
  state,
  api,
  connectWs = () => {},
  syncEventSubscription = () => {},
  registerPendingThreadResume = () => {},
  onPendingTurnStateChange = () => {},
  refreshWorkspaceRuntimeState = async () => null,
  skipSubscription = false,
}) {
  const id = String(threadId || "").trim();
  if (!id) return null;
  const openState = resolveThreadOpenState({
    threadId: id,
    threadStatusType,
    historyThreadId: state?.activeThreadHistoryThreadId,
    historyIncomplete: state?.activeThreadHistoryIncomplete === true,
    historyStatusType: state?.activeThreadHistoryStatusType,
    pendingTurnRunning: state?.activeThreadPendingTurnRunning === true,
    pendingThreadId: state?.activeThreadPendingTurnThreadId,
  });
  const needsResume = shouldResumeThreadAfterOpen(openState);
  if (!needsResume) {
    setThreadOpenState(state, openState);
    if (workspace === "windows" || workspace === "wsl2") {
      await refreshWorkspaceRuntimeState(workspace, { silent: true, updateHeader: true }).catch(() => null);
    }
    return null;
  }
  if (skipSubscription !== true) {
    connectWs();
    syncEventSubscription();
  }
  const resumePromise = api(
    buildThreadResumeUrl(id, {
      workspace,
      rolloutPath,
      fastModeEnabled: state?.fastModeEnabled,
      permissionPreset: state?.permissionPresetByWorkspace?.[workspace === "wsl2" ? "wsl2" : "windows"],
    }),
    { method: "POST" }
  );
  registerPendingThreadResume(state?.pendingThreadResumes, id, resumePromise);
  try {
    const resumed = await resumePromise;
    if (state) {
      const resumedTurnId = String(
        resumed?.turnId ||
        resumed?.turn_id ||
        resumed?.turn?.id ||
        resumed?.result?.turnId ||
        resumed?.result?.turn_id ||
        resumed?.result?.turn?.id ||
        ""
      ).trim();
      setThreadOpenState(state, openState, { loaded: true });
      if (resumedTurnId) {
        syncPendingTurnRuntime(state, id, {
          turnId: resumedTurnId,
          running: true,
        });
        onPendingTurnStateChange();
      }
    }
    if (workspace === "windows" || workspace === "wsl2") {
      await refreshWorkspaceRuntimeState(workspace, { silent: true, updateHeader: true }).catch(() => null);
    }
    return resumed;
  } catch {
    return null;
  }
}

export function activateExistingThreadView({
  threadId,
  state,
  setMainTab = () => {},
  setMobileTab = () => {},
}) {
  const id = String(threadId || "").trim();
  const activeThreadId = String(state?.activeThreadId || "").trim();
  if (!id || !activeThreadId || id !== activeThreadId) return false;
  setMainTab("chat");
  setMobileTab("chat");
  return true;
}

export function primeOpeningThreadState({
  thread,
  state,
  setActiveThread = () => {},
  detectThreadWorkspaceTarget = () => "unknown",
}) {
  const threadId = String(thread?.id || thread?.threadId || "").trim();
  if (!threadId) return { threadId: "", workspace: "unknown", rolloutPath: "" };
  const workspace = detectThreadWorkspaceTarget(thread);
  const rolloutPath = String(thread?.path || "").trim();
  const threadStatusType = String(thread?.status?.type || "").trim();
  setActiveThread(threadId);
  setThreadOpenState(state, resolveThreadOpenState({
    threadId,
    threadStatusType,
    historyThreadId: state?.activeThreadHistoryThreadId,
    historyIncomplete: state?.activeThreadHistoryIncomplete === true,
    historyStatusType: state?.activeThreadHistoryStatusType,
    pendingTurnRunning: state?.activeThreadPendingTurnRunning === true,
    pendingThreadId: state?.activeThreadPendingTurnThreadId,
  }));
  if (workspace === "windows" || workspace === "wsl2") {
    state.activeThreadWorkspace = workspace;
  }
  state.activeThreadRolloutPath = rolloutPath;
  return { threadId, workspace, rolloutPath, threadStatusType };
}

function resolvedOpenThreadWorkspace(state, workspaceHint = "") {
  const activeWorkspace = String(state?.activeThreadWorkspace || "").trim().toLowerCase();
  if (activeWorkspace === "windows" || activeWorkspace === "wsl2") return activeWorkspace;
  const hint = String(workspaceHint || "").trim().toLowerCase();
  if (hint === "windows" || hint === "wsl2") return hint;
  return "";
}

function explicitOpenThreadWorkspace(workspaceHint = "") {
  const hint = String(workspaceHint || "").trim().toLowerCase();
  return hint === "windows" || hint === "wsl2" ? hint : "";
}

function waitForOpeningOverlayPaint(requestAnimationFrameRef) {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrameRef !== "function") {
      resolve();
      return;
    }
    requestAnimationFrameRef(() => {
      requestAnimationFrameRef(() => resolve());
    });
  });
}

export function createThreadListViewModule(deps) {
  const {
    state,
    byId,
    escapeHtml,
    normalizeWorkspaceTarget,
    getWorkspaceTarget,
    hasDualWorkspaceTargets,
    pushThreadAnimDebug,
    recordLocalTask = () => {},
    isThreadListActuallyVisible,
    workspaceKeyOfThread,
    truncateLabel,
    relativeTimeLabel,
    pickThreadTimestamp,
    setMainTab,
    setMobileTab,
    setActiveThread,
    onActiveThreadOpened = () => {},
    setChatOpening,
    detectThreadWorkspaceTarget,
    loadThreadMessages,
    api,
    connectWs = () => {},
    syncEventSubscription = () => {},
    registerPendingThreadResume = () => {},
    onPendingTurnStateChange = () => {},
    refreshWorkspaceRuntimeState = async () => null,
    updateHeaderUi = () => {},
    clearLiveThreadConnectionStatus = () => {},
    setStatus,
    scheduleThreadRefresh,
    scrollToBottomReliable,
    windowRef = window,
    documentRef = document,
    requestAnimationFrameRef = requestAnimationFrame,
    performanceRef = performance,
    localStorageRef = localStorage,
    FAVORITE_THREADS_KEY,
  } = deps;
  let threadCardRenderToken = 0;
  let threadListRenderToken = 0;

  function renderThreads(items) {
    const renderToken = ++threadListRenderToken;
    const startedAt = performanceRef.now();
    let sourceItems = Array.isArray(items) ? items : [];
    let currentWorkspaceKey = "";
    let groupCount = 0;
    let renderedThreads = 0;
    let synchronousCardBudget = THREAD_LIST_INITIAL_CARD_SYNC_BUDGET;
    try {
      const list = byId("threadList");
      if (!list) return;
      let estimateCurrentListContentHeight = () => THREAD_LIST_STATE_ESTIMATE_PX;
      const applyListScrollability = () => {
        if (renderToken !== threadListRenderToken) return;
        applyEstimatedThreadListScrollability(
          list,
          estimateCurrentListContentHeight(),
          windowRef
        );
      };
      let scrollabilityRefreshScheduled = false;
      const scheduleListScrollabilityRefresh = () => {
        if (scrollabilityRefreshScheduled) return;
        scrollabilityRefreshScheduled = true;
        requestAnimationFrameRef(() => {
          scrollabilityRefreshScheduled = false;
          applyListScrollability();
        });
      };
      currentWorkspaceKey = normalizeWorkspaceTarget(getWorkspaceTarget());
      const pendingVisibleAnimation =
        !!state.threadListPendingVisibleAnimationByWorkspace?.[currentWorkspaceKey];
      const listActuallyVisible = isThreadListActuallyVisible();
      const openWindowActive =
        documentRef.body.classList.contains("drawer-left-open") &&
        sourceItems.length > 0 &&
        Date.now() < Math.max(0, Number(state.threadListVisibleOpenAnimationUntil || 0));
      const animateEnter =
        !!state.threadListAnimateNextRender ||
        openWindowActive ||
        (pendingVisibleAnimation && listActuallyVisible && sourceItems.length > 0);
      if (openWindowActive && animateEnter) {
        state.threadListVisibleOpenAnimationUntil = 0;
      }
      if (animateEnter && sourceItems.length > 0 && documentRef.body.classList.contains("drawer-left-open")) {
        state.threadListAnimationHoldUntilByWorkspace[currentWorkspaceKey] = Date.now() + 420;
      }
      pushThreadAnimDebug("renderThreads", {
        sourceCount: sourceItems.length,
        pendingVisibleAnimation,
        listActuallyVisible,
        animateEnter,
        animateNextRender: !!state.threadListAnimateNextRender,
        holdUntilMs:
          Math.max(0, Number(state.threadListAnimationHoldUntilByWorkspace[currentWorkspaceKey] || 0)) -
          Date.now(),
        visibleOpenUntilMs:
          Math.max(0, Number(state.threadListVisibleOpenAnimationUntil || 0)) - Date.now(),
      });

      const animateThreadIds =
        state.threadListAnimateThreadIds instanceof Set ? state.threadListAnimateThreadIds : new Set();
      const expandAnimateGroupKeys =
        state.threadListExpandAnimateGroupKeys instanceof Set ? state.threadListExpandAnimateGroupKeys : new Set();
    const collapseAnimateGroupKeys =
      state.threadListCollapseAnimateGroupKeys instanceof Set ? state.threadListCollapseAnimateGroupKeys : new Set();
    const chevronOpenAnimateKeys =
      state.threadListChevronOpenAnimateKeys instanceof Set ? state.threadListChevronOpenAnimateKeys : new Set();
    const chevronCloseAnimateKeys =
      state.threadListChevronCloseAnimateKeys instanceof Set ? state.threadListChevronCloseAnimateKeys : new Set();

    const setExpandedClass = (node, className, enabled) => {
      if (!node?.classList) return;
      if (enabled) node.classList.add(className);
      else node.classList.remove(className);
    };

    const setGroupHeaderExpanded = (header, expanded) => {
      setExpandedClass(header, "is-collapsed", !expanded);
      const chevron = header?.querySelector?.(".groupChevron");
      setExpandedClass(chevron, "is-collapsed", !expanded);
    };

    const finishGroupBodyAnimation = (body, expanded) => {
      if (!body) return;
      if (typeof body.__threadGroupAnimationCancel === "function") {
        const cancel = body.__threadGroupAnimationCancel;
        body.__threadGroupAnimationCancel = null;
        cancel();
      }
      body.classList.remove("is-animating");
      setExpandedClass(body, "collapsed", !expanded);
      body.style.height = expanded ? "" : "0px";
      body.style.opacity = "";
      body.style.transform = "";
      body.style.transitionDelay = "";
      if (!expanded) {
        body.__threadCardsRenderToken = 0;
        body.innerHTML = "";
        body.__threadGroupRenderedKey = "";
      }
    };

    const animateGroupBody = (body, expanded, { immediate = false, fromHeight = null, delayMs = 0 } = {}) => {
      if (!body) return;
      if (!expanded) body.__threadCardsRenderToken = 0;
      if (immediate) {
        finishGroupBodyAnimation(body, expanded);
        return;
      }
      const currentHeight = Number.isFinite(fromHeight)
        ? Math.max(0, Number(fromHeight))
        : Math.max(0, body.getBoundingClientRect().height);
      const targetHeight = expanded ? Math.max(0, body.scrollHeight) : 0;
      if (currentHeight === targetHeight) {
        finishGroupBodyAnimation(body, expanded);
        return;
      }
      if (typeof body.__threadGroupAnimationCancel === "function") {
        const cancel = body.__threadGroupAnimationCancel;
        body.__threadGroupAnimationCancel = null;
        cancel();
      }
      body.classList.add("is-animating");
      body.classList.remove("collapsed");
      body.style.height = `${currentHeight}px`;
      body.style.opacity = currentHeight > 0 ? "1" : expanded ? "0" : "1";
      body.style.transform = currentHeight > 0 ? "translateY(0)" : "translateY(-4px)";
      body.style.transitionDelay = `${Math.max(0, Number(delayMs) || 0)}ms`;

      const handleTransitionEnd = (event) => {
        if (event?.target !== body || event?.propertyName !== "height") return;
        finishGroupBodyAnimation(body, expanded);
      };
      const cancel = () => {
        body.removeEventListener?.("transitionend", handleTransitionEnd);
      };
      body.__threadGroupAnimationCancel = cancel;
      body.addEventListener("transitionend", handleTransitionEnd);
      requestAnimationFrameRef(() => {
        setExpandedClass(body, "collapsed", !expanded);
        body.style.height = `${targetHeight}px`;
        body.style.opacity = expanded ? "1" : "0";
        body.style.transform = expanded ? "translateY(0)" : "translateY(-4px)";
      });
    };

    const findRenderedGroupByKey = (groupKey) =>
      Array.from(list?.children || []).find(
        (node) => String(node?.getAttribute?.("data-group-key") || "") === String(groupKey)
      ) || null;

    const GROUP_EXPANDED_REVEAL_OFFSET_MS = 220;
    const resolveGroupEnterDelayMs = () => (animateEnter ? nextGroupEnterDelayMs() : 0);
    const resolveExpandedGroupRevealDelayMs = (groupEnterDelayMs) =>
      animateEnter ? groupEnterDelayMs + GROUP_EXPANDED_REVEAL_OFFSET_MS : groupEnterDelayMs;

    const getRenderedGroupItems = (groupKey) => {
      const key = String(groupKey || "");
      if (key === "__section_favorites__") return favoriteItems;
      const entry = entries.find(([, , workspaceKey]) => String(workspaceKey) === key);
      if (!entry) return [];
      const [workspace, threads] = entry;
      return filterWorkspaceSectionThreads(threads, favoriteSet, query, workspace);
    };

    const takeSynchronousCardBudget = (requested) => {
      const count = Math.min(
        Math.max(0, Number(requested) || 0),
        Math.max(0, synchronousCardBudget)
      );
      synchronousCardBudget -= count;
      return count;
    };

    const renderExpandedGroupThreads = (body, items, groupEnterDelayMs, groupKey, options = {}) => {
      if (!body) return;
      body.innerHTML = "";
      const renderedGroupKey = String(groupKey || "");
      const groupItems = Array.isArray(items) ? items : [];
      const token = ++threadCardRenderToken;
      body.__threadGroupRenderedKey = renderedGroupKey;
      body.__threadCardsRenderToken = token;
      const expandedGroupRevealDelayMs = resolveExpandedGroupRevealDelayMs(groupEnterDelayMs);
      const animateExpandedGroupCards =
        options.animateExpandedCards !== false &&
        !state.collapsedWorkspaceKeys.has(groupKey) &&
        (animateEnter || expandAnimateGroupKeys.has(String(groupKey)));
      const appendThreadCards = (startIndex, endIndex) => {
        for (let i = startIndex; i < endIndex; i += 1) {
          body.appendChild(
            renderThreadCard(groupItems[i], {
              expandEnter: animateExpandedGroupCards,
              expandEnterBaseDelayMs: animateEnter ? expandedGroupRevealDelayMs : 0,
            })
          );
        }
      };
      const requestedInitialCount =
        Number.isFinite(options.initialCardCount) && options.initialCardCount >= 0
          ? Number(options.initialCardCount)
          : groupItems.length;
      const initialCount = Math.min(
        groupItems.length,
        options.consumeInitialCardBudget === false
          ? Math.max(0, requestedInitialCount)
          : takeSynchronousCardBudget(requestedInitialCount)
      );
      appendThreadCards(0, initialCount);
      if (initialCount >= groupItems.length) {
        body.__threadCardsRenderToken = 0;
        return;
      }
      let nextIndex = initialCount;
      const appendNextBatch = () => {
        if (
          body.__threadCardsRenderToken !== token ||
          body.__threadGroupRenderedKey !== renderedGroupKey
        ) {
          return;
        }
        const endIndex = Math.min(nextIndex + THREAD_LIST_ASYNC_CARD_BATCH_SIZE, groupItems.length);
        appendThreadCards(nextIndex, endIndex);
        nextIndex = endIndex;
        if (nextIndex < groupItems.length) {
          requestAnimationFrameRef(appendNextBatch);
          return;
        }
        if (body.__threadCardsRenderToken === token) body.__threadCardsRenderToken = 0;
        scheduleListScrollabilityRefresh();
      };
      requestAnimationFrameRef(appendNextBatch);
    };

    const applyInitialGroupBodyState = (body, collapsed, groupEnterDelayMs) => {
      const expandedGroupRevealDelayMs = resolveExpandedGroupRevealDelayMs(groupEnterDelayMs);
      animateGroupBody(body, !collapsed, {
        immediate: !animateEnter || collapsed,
        fromHeight: animateEnter && !collapsed ? 0 : null,
        delayMs: animateEnter && !collapsed ? expandedGroupRevealDelayMs : 0,
      });
    };

    const setRenderedGroupExpanded = (groupKey, expanded, options) => {
      const group = findRenderedGroupByKey(groupKey);
      const header = group?.children?.[0] || null;
      const body = group?.querySelector?.(".groupBody") || group?.children?.[1] || null;
      setGroupHeaderExpanded(header, expanded);
      if (expanded) {
        renderExpandedGroupThreads(body, getRenderedGroupItems(groupKey), 0, groupKey, {
          consumeInitialCardBudget: false,
          initialCardCount: THREAD_LIST_INTERACTION_CARD_SYNC_BUDGET,
          animateExpandedCards: false,
        });
      }
      animateGroupBody(body, expanded, options);
    };

    const startExclusiveGroupSwitch = (nextGroupKey, allGroupKeys) => {
      const nextKey = String(nextGroupKey || "");
      for (const key of allGroupKeys) {
        const expanded = String(key) === nextKey;
        if (expanded) state.collapsedWorkspaceKeys.delete(key);
        else state.collapsedWorkspaceKeys.add(key);
        setRenderedGroupExpanded(key, expanded);
      }
      scheduleListScrollabilityRefresh();
      state.threadListAnimateNextRender = false;
      state.threadListAnimateThreadIds = new Set();
      state.threadListExpandAnimateGroupKeys = new Set();
      state.threadListCollapseAnimateGroupKeys = new Set();
      state.threadListChevronOpenAnimateKeys = new Set();
      state.threadListChevronCloseAnimateKeys = new Set();
    };

    const animateStateTextSwap = (node, nextLabel) => {
      if (!node) return;
      const text = String(nextLabel || "");
      if (node.textContent === text) return;
      node.textContent = text;
      node.classList.remove("is-text-swap");
      void node.offsetWidth;
      node.classList.add("is-text-swap");
    };

    const renderThreadListState = (label, mode = "plain") => {
      const text = String(label || "");
      if (mode === "spinner") {
        const current = list.firstElementChild;
        if (
          current &&
          current.classList?.contains("threadListState") &&
          current.getAttribute("data-state-mode") === "spinner"
        ) {
          const textNode = current.querySelector(".threadListStateText");
          animateStateTextSwap(textNode, text);
          return;
        }
        const wrap = documentRef.createElement("div");
        wrap.className = "threadListState";
        wrap.setAttribute("data-state-mode", "spinner");
        wrap.innerHTML =
          `<span class="threadListStateSpinner" aria-hidden="true"></span>` +
          `<span class="threadListStateText is-text-swap">${escapeHtml(text)}</span>`;
        list.innerHTML = "";
        list.appendChild(wrap);
        return;
      }
      const current = list.firstElementChild;
      if (
        current &&
        current.classList?.contains("threadListPlainState") &&
        current.getAttribute("data-state-mode") === "plain"
      ) {
        animateStateTextSwap(current, text);
        return;
      }
      const plain = documentRef.createElement("div");
      plain.className = "muted threadListPlainState is-text-swap";
      plain.setAttribute("data-state-mode", "plain");
      plain.textContent = text;
      list.innerHTML = "";
      list.appendChild(plain);
    };

    const drawerScrollResetActive = !!state.threadListSkipScrollRestoreOnce;
    const skipScrollRestore = drawerScrollResetActive;
    state.threadListSkipScrollRestoreOnce = false;
    const prevListScrollTop = list?.scrollTop ?? 0;
    if (drawerScrollResetActive) {
      list.scrollTop = 0;
    }
    const shouldRestoreListScroll = !skipScrollRestore && prevListScrollTop > 0;
    const prevGroupScroll = new Map();
    const pendingScrollRestores = [];
    if (!skipScrollRestore) {
      try {
        const groups = Array.from(list?.querySelectorAll?.(".groupCard[data-group-key]") || []);
        for (const group of groups) {
          const key = String(group.getAttribute("data-group-key") || "").trim();
          if (!key) continue;
          const body = group.querySelector(".groupBody");
          if (!body) continue;
          if (body.scrollTop > 0) prevGroupScroll.set(key, body.scrollTop);
        }
      } catch {}
    }

    const query = state.threadSearchQuery.trim().toLowerCase();
    const entries = buildWorkspaceEntries(sourceItems, workspaceKeyOfThread);
    groupCount = entries.length;
    const staggerGroupEnter = shouldStaggerThreadGroupEnter(entries);
    let threadEnterIndex = 0;
    let threadExpandEnterIndex = 0;
    let groupEnterIndex = 0;
    const nextThreadEnterDelayMs = () => Math.min(420, threadEnterIndex++ * 28);
    const nextThreadExpandEnterDelayMs = () => Math.min(260, threadExpandEnterIndex++ * 20);
    const nextGroupEnterDelayMs = () =>
      (staggerGroupEnter ? Math.min(640, groupEnterIndex++ * 120) : 0);
    if (!entries.length) {
      if (state.threadListLoading && (!state.threadListLoadingTarget || state.threadListLoadingTarget === getWorkspaceTarget())) {
        renderThreadListState("Loading chats...", "spinner");
        applyListScrollability();
        state.threadListAnimateNextRender = false;
        state.threadListAnimateThreadIds = new Set();
        state.threadListExpandAnimateGroupKeys = new Set();
        return;
      }
      const waitingWorkspaceDetection =
        !state.workspaceAvailability.windowsInstalled && !state.workspaceAvailability.wsl2Installed;
      if (waitingWorkspaceDetection) {
        renderThreadListState("Waiting for WIN/WSL2...", "spinner");
        applyListScrollability();
        state.threadListAnimateNextRender = false;
        state.threadListAnimateThreadIds = new Set();
        state.threadListExpandAnimateGroupKeys = new Set();
        return;
      }
      if (state.threadItemsAll.length && hasDualWorkspaceTargets()) {
        renderThreadListState(`No ${getWorkspaceTarget().toUpperCase()} chats yet.`);
      } else {
        renderThreadListState("No threads yet.");
      }
      applyListScrollability();
      state.threadListAnimateNextRender = false;
      state.threadListAnimateThreadIds = new Set();
      state.threadListExpandAnimateGroupKeys = new Set();
      state.threadListChevronOpenAnimateKeys = new Set();
      state.threadListChevronCloseAnimateKeys = new Set();
      state.threadListCollapseAnimateGroupKeys = new Set();
      return;
    }

    list.innerHTML = "";
    const validKeys = new Set(entries.map(([, , key]) => key));
    if (state.collapsedWorkspaceKeys.size) {
      state.collapsedWorkspaceKeys = new Set(
        Array.from(state.collapsedWorkspaceKeys).filter(
          (key) => validKeys.has(key) || String(key).startsWith("__section_")
        )
      );
    }
    const collapseInitKey = normalizeWorkspaceTarget(getWorkspaceTarget());
    const collapseInitialized = !!state.threadGroupCollapseInitializedByWorkspace?.[collapseInitKey];
    if (!collapseInitialized) {
      for (let i = 0; i < entries.length; i += 1) state.collapsedWorkspaceKeys.add(entries[i][2]);
      state.threadGroupCollapseInitializedByWorkspace[collapseInitKey] = true;
    }

    renderedThreads = 0;
    const favoriteSet = state.favoriteThreadIds;
    const favoriteItems = sourceItems.filter((thread) => {
      const id = thread.id || thread.threadId || "";
      return id && favoriteSet.has(id);
    });
    const estimateSectionContentHeight = (sectionItems, sectionKey) => {
      if (!Array.isArray(sectionItems) || sectionItems.length === 0) return 0;
      const collapsed = state.collapsedWorkspaceKeys.has(sectionKey);
      return (
        THREAD_LIST_GROUP_HEADER_ESTIMATE_PX +
        (collapsed ? 0 : sectionItems.length * THREAD_LIST_ROW_ESTIMATE_PX)
      );
    };
    estimateCurrentListContentHeight = () => {
      let height = estimateSectionContentHeight(favoriteItems, "__section_favorites__");
      for (const [workspace, threads, workspaceKey] of entries) {
        const filtered = filterWorkspaceSectionThreads(threads, favoriteSet, query, workspace);
        height += estimateSectionContentHeight(filtered, workspaceKey);
      }
      return height > 0 ? height : THREAD_LIST_STATE_ESTIMATE_PX;
    };

    const renderThreadCard = (thread, options = {}) => {
      const id = thread.id || thread.threadId || "";
      const preview = String(thread.preview || "").replace(/\s+/g, " ").trim();
      const title =
        thread.title ||
        thread.name ||
        (preview ? truncateLabel(preview, 40) : "") ||
        id ||
        "(unnamed)";
      const age = relativeTimeLabel(pickThreadTimestamp(thread)) || "";
      const isFavorite = !!(id && favoriteSet.has(id));
      const card = documentRef.createElement("div");
      card.className = `itemCard${id && id === state.activeThreadId ? " active" : ""}`;
      if (!!options.expandEnter) {
        card.classList.add("threadExpandEnter");
        const baseDelayMs = Math.max(0, Number(options.expandEnterBaseDelayMs) || 0);
        card.style.setProperty(
          "--thread-expand-enter-delay",
          `${baseDelayMs + nextThreadExpandEnterDelayMs()}ms`
        );
      } else if (animateEnter || !!options.animateEnter || (id && animateThreadIds.has(id))) {
        card.classList.add("threadEnter");
        card.style.setProperty("--thread-enter-delay", `${nextThreadEnterDelayMs()}ms`);
      }
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.innerHTML =
        `<div class="row"><button class="threadFavBtn${isFavorite ? " active" : ""}" data-thread-fav="${escapeHtml(id)}" aria-label="${isFavorite ? "Unfavorite" : "Favorite"}"><span class="starGlyph" aria-hidden="true">${isFavorite ? "★" : "☆"}</span></button>` +
        `<div class="itemTitle">${escapeHtml(title)}</div>` +
        `<div class="itemSub mono">${escapeHtml(age)}</div></div>`;
      const favBtn = card.querySelector(".threadFavBtn");
      if (favBtn) {
        favBtn.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!id) return;
          if (favoriteSet.has(id)) favoriteSet.delete(id);
          else favoriteSet.add(id);
          localStorageRef.setItem(FAVORITE_THREADS_KEY, JSON.stringify(Array.from(favoriteSet)));
          renderThreads(state.threadItems);
        };
      }
      const openThread = async () => {
        if (!id) return;
        if (activateExistingThreadView({ threadId: id, state, setMainTab, setMobileTab })) return;
        const reqId = state.openingThreadReqId + 1;
        state.openingThreadReqId = reqId;
        if (state.openingThreadAbort) {
          try {
            state.openingThreadAbort.abort();
          } catch {}
        }
        const controller = new AbortController();
        state.openingThreadAbort = controller;
        setMainTab("chat");
        setMobileTab("chat");
        state.threadSearchOpen = false;
        state.threadSearchQuery = "";
        const selection = primeOpeningThreadState({
          thread,
          state,
          setActiveThread,
          detectThreadWorkspaceTarget,
        });
        resetTransientConnectionStatusForThreadOpen(
          state,
          state.activeThreadOpenState,
          clearLiveThreadConnectionStatus
        );
        onActiveThreadOpened(selection);
        const workspaceHint = selection.workspace;
        const rolloutPath = selection.rolloutPath;
        setChatOpening(true);
        await waitForOpeningOverlayPaint(requestAnimationFrameRef);
        if (state.openingThreadReqId !== reqId || controller.signal.aborted) return;
        const explicitWorkspace = explicitOpenThreadWorkspace(workspaceHint);
        const liveFirst = shouldSubscribeLiveBeforeHistory(selection.threadStatusType);
        if (liveFirst) {
          connectWs();
          if (explicitWorkspace === "windows" || explicitWorkspace === "wsl2") {
            syncEventSubscription();
          }
          setChatOpening(false);
        }
        try {
          const label =
            workspaceHint === "wsl2" ? "WSL2" : workspaceHint === "windows" ? "WIN" : "AUTO";
          const historyStartMs = performanceRef.now();
          await loadThreadMessages(id, {
            animateBadge: true,
            signal: controller.signal,
            workspace: workspaceHint === "unknown" ? "" : workspaceHint,
            rolloutPath,
            stickToBottom: true,
          });
          const historyLatencyMs = Math.round(performanceRef.now() - historyStartMs);
          if (state.openingThreadReqId === reqId) {
            setStatus(`Opened ${label} ${truncateLabel(id, 12)} history ${historyLatencyMs}ms`);
          }
          const runtimeWorkspace = resolvedOpenThreadWorkspace(state, workspaceHint);
          if (!liveFirst) connectWs();
          if (runtimeWorkspace === "windows" || runtimeWorkspace === "wsl2") {
            if (!liveFirst) syncEventSubscription();
            refreshWorkspaceRuntimeState(runtimeWorkspace, {
              silent: true,
              updateHeader: true,
            }).catch(() => null);
          }
            resumeThreadLiveOnOpen({
              threadId: id,
              workspace: runtimeWorkspace,
              rolloutPath,
              threadStatusType: selection.threadStatusType,
              state,
              api,
              connectWs,
              syncEventSubscription,
              registerPendingThreadResume,
              onPendingTurnStateChange,
              refreshWorkspaceRuntimeState,
              skipSubscription: true,
            })
              .then(() => updateHeaderUi())
              .catch(() => null);
          if (state.openingThreadReqId === reqId) scheduleThreadRefresh();
          if (state.openingThreadReqId === reqId) {
            if (!liveFirst) setChatOpening(false);
            state.chatShouldStickToBottom = true;
            scrollToBottomReliable();
          }
        } catch (error) {
          if (error && (error.name === "AbortError" || String(error.message || "").includes("aborted"))) {
            return;
          }
          if (state.openingThreadReqId === reqId) setChatOpening(false);
          throw error;
        } finally {
          if (state.openingThreadAbort === controller) state.openingThreadAbort = null;
        }
      };
      card.onclick = () => {
        openThread().catch((error) => setStatus(error.message, true));
      };
      card.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openThread().catch((error) => setStatus(error.message, true));
        }
      };
      return card;
    };

    const renderSection = (sectionTitle, sectionItems, sectionKey) => {
      if (!sectionItems.length) return;
      const group = documentRef.createElement("section");
      group.className = "groupCard";
      const groupEnterDelayMs = resolveGroupEnterDelayMs();
      if (animateEnter) {
        group.classList.add("groupEnter");
        group.style.setProperty("--thread-group-enter-delay", `${groupEnterDelayMs}ms`);
      }
      group.setAttribute("data-group-key", String(sectionKey));
      const header = documentRef.createElement("button");
      const collapsed = state.collapsedWorkspaceKeys.has(sectionKey);
      header.className = `groupHeader${collapsed ? " is-collapsed" : ""}${animateEnter ? " threadHeaderEnter" : ""}`;
      header.innerHTML =
        `<span class="itemTitle">${escapeHtml(sectionTitle)}</span>` +
        `<span class="groupChevron${collapsed ? " is-collapsed" : ""}" aria-hidden="true">` +
        `<svg class="groupChevronIcon" viewBox="0 0 16 16" focusable="false"><path d="M6 4l4 4-4 4"></path></svg>` +
        `</span>`;
      header.onclick = () => {
        const currentlyCollapsed = state.collapsedWorkspaceKeys.has(sectionKey);
        if (currentlyCollapsed) {
          state.collapsedWorkspaceKeys.delete(sectionKey);
          setGroupHeaderExpanded(header, true);
          setRenderedGroupExpanded(sectionKey, true);
          scheduleListScrollabilityRefresh();
          return;
        }
        const bodyNode = group.querySelector(".groupBody");
        state.collapsedWorkspaceKeys.add(sectionKey);
        setGroupHeaderExpanded(header, false);
        animateGroupBody(bodyNode, false);
        scheduleListScrollabilityRefresh();
      };
      group.appendChild(header);
      const body = documentRef.createElement("div");
      body.className = "groupBody";
      if (collapsed) body.classList.add("collapsed");
      if (!collapsed) renderExpandedGroupThreads(body, sectionItems, groupEnterDelayMs, sectionKey);
      group.appendChild(body);
      applyInitialGroupBodyState(body, collapsed, groupEnterDelayMs);
      const prevTop = prevGroupScroll.get(String(sectionKey));
      if (!collapsed && typeof prevTop === "number" && Number.isFinite(prevTop) && prevTop > 0) {
        pendingScrollRestores.push({ node: body, top: prevTop });
      }
      list.appendChild(group);
      renderedThreads += sectionItems.length;
    };

    renderSection("Favorites", favoriteItems, "__section_favorites__");

    for (const [workspace, threads, workspaceKey] of entries) {
      const filtered = filterWorkspaceSectionThreads(threads, favoriteSet, query, workspace);
      if (!filtered.length) continue;
      renderedThreads += filtered.length;
      const group = documentRef.createElement("section");
      group.className = "groupCard";
      const groupEnterDelayMs = resolveGroupEnterDelayMs();
      if (animateEnter) {
        group.classList.add("groupEnter");
        group.style.setProperty("--thread-group-enter-delay", `${groupEnterDelayMs}ms`);
      }
      group.setAttribute("data-group-key", String(workspaceKey));
      const header = documentRef.createElement("button");
      const collapsed = state.collapsedWorkspaceKeys.has(workspaceKey);
      header.className = `groupHeader${collapsed ? " is-collapsed" : ""}${animateEnter ? " threadHeaderEnter" : ""}`;
      header.innerHTML =
        `<span class="itemTitle">${escapeHtml(workspace)}</span>` +
        `<span class="groupChevron${collapsed ? " is-collapsed" : ""}" aria-hidden="true">` +
        `<svg class="groupChevronIcon" viewBox="0 0 16 16" focusable="false"><path d="M6 4l4 4-4 4"></path></svg>` +
        `</span>`;
      header.onclick = () => {
        const currentlyCollapsed = state.collapsedWorkspaceKeys.has(workspaceKey);
        if (currentlyCollapsed) {
          startExclusiveGroupSwitch(workspaceKey, entries.map(([, , key]) => key));
          return;
        }
        const bodyNode = group.querySelector(".groupBody");
        state.collapsedWorkspaceKeys.add(workspaceKey);
        setGroupHeaderExpanded(header, false);
        animateGroupBody(bodyNode, false);
        scheduleListScrollabilityRefresh();
      };
      group.appendChild(header);
      const body = documentRef.createElement("div");
      body.className = "groupBody";
      if (collapsed) body.classList.add("collapsed");
      if (!collapsed) renderExpandedGroupThreads(body, filtered, groupEnterDelayMs, workspaceKey);
      group.appendChild(body);
      applyInitialGroupBodyState(body, collapsed, groupEnterDelayMs);
      const prevTop = prevGroupScroll.get(String(workspaceKey));
      if (!collapsed && typeof prevTop === "number" && Number.isFinite(prevTop) && prevTop > 0) {
        pendingScrollRestores.push({ node: body, top: prevTop });
      }
      list.appendChild(group);
    }

    if (!renderedThreads) renderThreadListState("No threads match search.");
    if (!list.childElementCount && !String(list.textContent || "").trim()) {
      if (state.threadListLoading) renderThreadListState("Loading chats...", "spinner");
      else renderThreadListState("Waiting for chats...", "spinner");
    }
    applyListScrollability();
    if (pendingVisibleAnimation && listActuallyVisible && sourceItems.length > 0) {
      state.threadListPendingVisibleAnimationByWorkspace[currentWorkspaceKey] = false;
    }
    state.threadListAnimateNextRender = false;
    state.threadListAnimateThreadIds = new Set();
    state.threadListExpandAnimateGroupKeys = new Set();
    state.threadListChevronOpenAnimateKeys = new Set();
    state.threadListChevronCloseAnimateKeys = new Set();
    if (animateEnter && sourceItems.length > 0 && documentRef.body.classList.contains("drawer-left-open")) {
      state.threadListPendingVisibleAnimationByWorkspace[currentWorkspaceKey] = false;
    }
    if (shouldRestoreListScroll || pendingScrollRestores.length) {
      requestAnimationFrameRef(() => {
        for (const item of pendingScrollRestores) {
          const node = item?.node;
          const prevTop = Number(item?.top || 0);
          if (!node || !Number.isFinite(prevTop) || prevTop <= 0) continue;
          const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
          node.scrollTop = Math.min(prevTop, maxTop);
        }
        if (shouldRestoreListScroll) {
          const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
          list.scrollTop = Math.min(prevListScrollTop, maxTop);
        }
      });
    }
    } finally {
      recordLocalTask({
        command: "thread list render",
        elapsedMs: performanceRef.now() - startedAt,
        fields: {
          workspace: currentWorkspaceKey,
          sourceCount: sourceItems.length,
          groupCount,
          renderedThreads,
        },
      });
    }
  }

  return {
    renderThreads,
  };
}
