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

export function shouldStaggerThreadGroupEnter(entries, collapsedKeys) {
  const groups = Array.isArray(entries) ? entries : [];
  const collapsed = collapsedKeys instanceof Set ? collapsedKeys : new Set();
  return !groups.some(([, items, key]) => Array.isArray(items) && items.length > 0 && !collapsed.has(key));
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

  function renderThreads(items) {
    const startedAt = performanceRef.now();
    let sourceItems = Array.isArray(items) ? items : [];
    let currentWorkspaceKey = "";
    let groupCount = 0;
    let renderedThreads = 0;
    try {
    const list = byId("threadList");
    if (!list) return;
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

    const animateExpandBody = (body) => {
      if (!body) return;
      const computed = windowRef.getComputedStyle(body);
      const targetPaddingTop = computed.paddingTop || "0px";
      const targetPaddingBottom = computed.paddingBottom || "0px";
      const expandedHeight = Math.max(0, body.getBoundingClientRect().height);
      if (expandedHeight <= 0) return;
      const revealCardCount = Array.from(body.children || []).filter((child) =>
        child?.classList?.contains?.("threadExpandEnter")
      ).length;
      const expandDurationMs = Math.min(520, Math.max(240, revealCardCount * 20 + 180));
      body.classList.add("is-expanding");
      body.classList.add("is-continuous-expanding");
      body.style.setProperty("--thread-expand-duration", `${expandDurationMs}ms`);
      body.style.height = "0px";
      body.style.opacity = "0";
      body.style.paddingTop = "0px";
      body.style.paddingBottom = "0px";
      body.style.overflow = "hidden";
      requestAnimationFrameRef(() => {
        body.style.opacity = "1";
        body.style.paddingTop = targetPaddingTop;
        body.style.paddingBottom = targetPaddingBottom;
        body.style.height = `${expandedHeight}px`;
      });
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        body.classList.remove("is-expanding");
        body.classList.remove("is-continuous-expanding");
        body.style.height = "";
        body.style.opacity = "";
        body.style.paddingTop = "";
        body.style.paddingBottom = "";
        body.style.overflow = "";
        body.style.removeProperty("--thread-expand-duration");
      };
      const cleanupDelayMs = expandDurationMs + 80;
      setTimeout(cleanup, cleanupDelayMs);
    };

    const animateCollapseBody = (body, onDone) => {
      if (!body) {
        onDone?.();
        return;
      }
      if (body.classList.contains("is-collapsing")) return;
      const startHeight = Math.max(0, body.getBoundingClientRect().height);
      if (startHeight <= 0) {
        onDone?.();
        return;
      }
      body.classList.add("is-collapsing");
      body.style.height = `${startHeight}px`;
      body.style.opacity = "1";
      body.style.overflow = "hidden";
      requestAnimationFrameRef(() => {
        body.style.height = "0px";
        body.style.opacity = "0";
        body.style.paddingTop = "0px";
        body.style.paddingBottom = "0px";
      });
      let done = false;
      const finalize = () => {
        if (done) return;
        done = true;
        onDone?.();
      };
      body.addEventListener(
        "transitionend",
        (event) => {
          if (event?.propertyName !== "height") return;
          finalize();
        },
        { once: true }
      );
      setTimeout(finalize, 260);
    };

    const startExclusiveGroupSwitch = (nextGroupKey, currentGroupKey, allGroupKeys) => {
      const nextKey = String(nextGroupKey || "");
      const currentKey = String(currentGroupKey || "");
      for (const key of allGroupKeys) state.collapsedWorkspaceKeys.add(key);
      if (nextKey) state.collapsedWorkspaceKeys.delete(nextKey);
      state.threadListAnimateNextRender = false;
      state.threadListAnimateThreadIds = new Set();
      state.threadListExpandAnimateGroupKeys = nextKey ? new Set([nextKey]) : new Set();
      state.threadListCollapseAnimateGroupKeys =
        currentKey && currentKey !== nextKey ? new Set([currentKey]) : new Set();
      state.threadListChevronOpenAnimateKeys = nextKey ? new Set([nextKey]) : new Set();
      state.threadListChevronCloseAnimateKeys =
        currentKey && currentKey !== nextKey ? new Set([currentKey]) : new Set();
      state.threadListSkipScrollRestoreOnce = true;
      renderThreads(state.threadItems);
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

    const skipScrollRestore = !!state.threadListSkipScrollRestoreOnce;
    state.threadListSkipScrollRestoreOnce = false;
    const prevListScrollTop = list?.scrollTop ?? 0;
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
    const staggerGroupEnter = shouldStaggerThreadGroupEnter(entries, state.collapsedWorkspaceKeys);
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
        state.threadListAnimateNextRender = false;
        state.threadListAnimateThreadIds = new Set();
        state.threadListExpandAnimateGroupKeys = new Set();
        return;
      }
      const waitingWorkspaceDetection =
        !state.workspaceAvailability.windowsInstalled && !state.workspaceAvailability.wsl2Installed;
      if (waitingWorkspaceDetection) {
        renderThreadListState("Waiting for WIN/WSL2...", "spinner");
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
        card.style.setProperty("--thread-expand-enter-delay", `${nextThreadExpandEnterDelayMs()}ms`);
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
      if (animateEnter) {
        group.classList.add("groupEnter");
        group.style.setProperty("--thread-group-enter-delay", `${nextGroupEnterDelayMs()}ms`);
      }
      group.setAttribute("data-group-key", String(sectionKey));
      const header = documentRef.createElement("button");
      const collapsed = state.collapsedWorkspaceKeys.has(sectionKey);
      header.className = `groupHeader${collapsed ? " is-collapsed" : ""}${animateEnter ? " threadHeaderEnter" : ""}`;
      const animClass = chevronCloseAnimateKeys.has(String(sectionKey))
        ? " anim-close"
        : chevronOpenAnimateKeys.has(String(sectionKey))
          ? " anim-open"
          : "";
      header.innerHTML =
        `<span class="itemTitle">${escapeHtml(sectionTitle)}</span>` +
        `<span class="groupChevron${collapsed ? " is-collapsed" : ""}${animClass}" aria-hidden="true">` +
        `<svg class="groupChevronIcon" viewBox="0 0 16 16" focusable="false"><path d="M6 4l4 4-4 4"></path></svg>` +
        `</span>`;
      header.onclick = () => {
        const currentlyCollapsed = state.collapsedWorkspaceKeys.has(sectionKey);
        if (currentlyCollapsed) {
          state.collapsedWorkspaceKeys.delete(sectionKey);
          state.threadListAnimateNextRender = false;
          state.threadListAnimateThreadIds = new Set();
          state.threadListExpandAnimateGroupKeys = new Set([String(sectionKey)]);
          state.threadListCollapseAnimateGroupKeys = new Set();
          state.threadListChevronOpenAnimateKeys = new Set([String(sectionKey)]);
          state.threadListChevronCloseAnimateKeys = new Set();
          state.threadListSkipScrollRestoreOnce = true;
          renderThreads(state.threadItems);
          return;
        }
        const bodyNode = group.querySelector(".groupBody");
        state.threadListChevronOpenAnimateKeys = new Set();
        state.threadListChevronCloseAnimateKeys = new Set([String(sectionKey)]);
        animateCollapseBody(bodyNode, () => {
          state.collapsedWorkspaceKeys.add(sectionKey);
          state.threadListAnimateNextRender = false;
          state.threadListAnimateThreadIds = new Set();
          state.threadListExpandAnimateGroupKeys = new Set();
          state.threadListCollapseAnimateGroupKeys = new Set();
          state.threadListSkipScrollRestoreOnce = true;
          renderThreads(state.threadItems);
        });
      };
      group.appendChild(header);
      let bodyForExpandAnim = null;
      if (!collapsed) {
        const body = documentRef.createElement("div");
        body.className = "groupBody";
        const animateExpandedGroupCards = expandAnimateGroupKeys.has(String(sectionKey));
        for (const thread of sectionItems) {
          body.appendChild(renderThreadCard(thread, { expandEnter: animateExpandedGroupCards }));
        }
        group.appendChild(body);
        if (expandAnimateGroupKeys.has(String(sectionKey))) bodyForExpandAnim = body;
        const prevTop = prevGroupScroll.get(String(sectionKey));
        if (typeof prevTop === "number" && Number.isFinite(prevTop) && prevTop > 0) {
          pendingScrollRestores.push({ node: body, top: prevTop });
        }
      }
      list.appendChild(group);
      if (bodyForExpandAnim) animateExpandBody(bodyForExpandAnim);
      renderedThreads += sectionItems.length;
    };

    renderSection("Favorites", favoriteItems, "__section_favorites__");

    for (const [workspace, threads, workspaceKey] of entries) {
      const filtered = filterWorkspaceSectionThreads(threads, favoriteSet, query, workspace);
      if (!filtered.length) continue;
      renderedThreads += filtered.length;
      const group = documentRef.createElement("section");
      group.className = "groupCard";
      if (animateEnter) {
        group.classList.add("groupEnter");
        group.style.setProperty("--thread-group-enter-delay", `${nextGroupEnterDelayMs()}ms`);
      }
      group.setAttribute("data-group-key", String(workspaceKey));
      const header = documentRef.createElement("button");
      const collapsed = state.collapsedWorkspaceKeys.has(workspaceKey);
      header.className = `groupHeader${collapsed ? " is-collapsed" : ""}${animateEnter ? " threadHeaderEnter" : ""}`;
      const animClass = chevronCloseAnimateKeys.has(String(workspaceKey))
        ? " anim-close"
        : chevronOpenAnimateKeys.has(String(workspaceKey))
          ? " anim-open"
          : "";
      header.innerHTML =
        `<span class="itemTitle">${escapeHtml(workspace)}</span>` +
        `<span class="groupChevron${collapsed ? " is-collapsed" : ""}${animClass}" aria-hidden="true">` +
        `<svg class="groupChevronIcon" viewBox="0 0 16 16" focusable="false"><path d="M6 4l4 4-4 4"></path></svg>` +
        `</span>`;
      header.onclick = () => {
        const currentlyCollapsed = state.collapsedWorkspaceKeys.has(workspaceKey);
        if (currentlyCollapsed) {
          const currentlyOpenKey =
            entries.find(([, , key]) => key !== workspaceKey && !state.collapsedWorkspaceKeys.has(key))?.[2] ||
            "";
          startExclusiveGroupSwitch(
            workspaceKey,
            currentlyOpenKey,
            entries.map(([, , key]) => key)
          );
          return;
        }
        const bodyNode = group.querySelector(".groupBody");
        state.threadListChevronOpenAnimateKeys = new Set();
        state.threadListChevronCloseAnimateKeys = new Set([String(workspaceKey)]);
        animateCollapseBody(bodyNode, () => {
          state.collapsedWorkspaceKeys.add(workspaceKey);
          state.threadListAnimateNextRender = false;
          state.threadListAnimateThreadIds = new Set();
          state.threadListExpandAnimateGroupKeys = new Set();
          state.threadListCollapseAnimateGroupKeys = new Set();
          state.threadListSkipScrollRestoreOnce = true;
          renderThreads(state.threadItems);
        });
      };
      group.appendChild(header);
      let bodyForExpandAnim = null;
      let bodyForCollapseAnim = null;
      const renderCollapsedBody = collapsed && collapseAnimateGroupKeys.has(String(workspaceKey));
      if (!collapsed || renderCollapsedBody) {
        const body = documentRef.createElement("div");
        body.className = "groupBody";
        const animateExpandedGroupCards =
          !renderCollapsedBody && expandAnimateGroupKeys.has(String(workspaceKey));
        for (const thread of filtered) {
          body.appendChild(renderThreadCard(thread, { expandEnter: animateExpandedGroupCards }));
        }
        group.appendChild(body);
        if (renderCollapsedBody) bodyForCollapseAnim = body;
        else if (expandAnimateGroupKeys.has(String(workspaceKey))) bodyForExpandAnim = body;
        const prevTop = prevGroupScroll.get(String(workspaceKey));
        if (!renderCollapsedBody && typeof prevTop === "number" && Number.isFinite(prevTop) && prevTop > 0) {
          pendingScrollRestores.push({ node: body, top: prevTop });
        }
      }
      list.appendChild(group);
      if (bodyForExpandAnim) animateExpandBody(bodyForExpandAnim);
      if (bodyForCollapseAnim) {
        animateCollapseBody(bodyForCollapseAnim, () => {
          const activeCollapseKeys =
            state.threadListCollapseAnimateGroupKeys instanceof Set
              ? state.threadListCollapseAnimateGroupKeys
              : new Set();
          state.threadListCollapseAnimateGroupKeys = new Set(
            Array.from(activeCollapseKeys).filter((key) => key !== String(workspaceKey))
          );
          state.threadListAnimateNextRender = false;
          state.threadListAnimateThreadIds = new Set();
          state.threadListSkipScrollRestoreOnce = true;
          bodyForCollapseAnim.remove?.();
        });
      }
    }

    if (!renderedThreads) renderThreadListState("No threads match search.");
    if (!list.childElementCount && !String(list.textContent || "").trim()) {
      if (state.threadListLoading) renderThreadListState("Loading chats...", "spinner");
      else renderThreadListState("Waiting for chats...", "spinner");
    }
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
