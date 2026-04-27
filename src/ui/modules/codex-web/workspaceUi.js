import { resolveThreadOpenState, setThreadOpenState } from "./threadOpenState.js";
import { resolveCurrentThreadId } from "./runtimeState.js";

export function normalizeStartCwd(value, target = "windows") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (target === "wsl2") {
    if (!text.startsWith("/")) return "";
    return text.replace(/[\\/]+$/, "") || "/";
  }
  const cleaned = text.replace(/^\\\\\?\\/, "").trim();
  if (!cleaned) return "";
  if (!/^[a-z]:[\\/]/i.test(cleaned) && !cleaned.startsWith("\\\\")) return "";
  return cleaned.replace(/[\\/]+$/, "");
}

export function folderDisplayName(path, target = "windows") {
  const text = String(path || "").trim();
  if (!text) return "";
  if (target === "wsl2") {
    const normalized = text.replace(/[\\/]+$/, "") || "/";
    if (normalized === "/") return "/";
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }
  const normalized = text.replace(/[\\/]+$/, "");
  if (/^[a-z]:$/i.test(normalized)) return `${normalized}\\`;
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

export function normalizeRuntimeWorkspaceTarget(value, fallback = "windows") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "wsl2") return "wsl2";
  if (text === "windows") return "windows";
  return String(fallback || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
}

export function buildRuntimeStateUrl(target = "windows") {
  const workspace = normalizeRuntimeWorkspaceTarget(target, "windows");
  return `/codex/runtime/state?workspace=${encodeURIComponent(workspace)}`;
}

export function normalizeRuntimeStatePayload(payload, fallbackWorkspace = "windows") {
  const workspace = normalizeRuntimeWorkspaceTarget(payload?.workspace, fallbackWorkspace);
  const readFinite = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  };
  return {
    workspace,
    homeOverride: String(payload?.homeOverride || payload?.home_override || "").trim(),
    connected: payload?.connected === true,
    connectedAtUnixSecs: readFinite(payload?.connectedAtUnixSecs, payload?.connected_at_unix_secs),
    lastReplayCursor: readFinite(payload?.lastReplayCursor, payload?.last_replay_cursor) || 0,
    lastReplayLastEventId: readFinite(
      payload?.lastReplayLastEventId,
      payload?.last_replay_last_event_id
    ),
    lastReplayAtUnixSecs: readFinite(payload?.lastReplayAtUnixSecs, payload?.last_replay_at_unix_secs),
    loaded: true,
    loading: false,
  };
}

function createFallbackRuntimeState(target = "windows") {
  const workspace = normalizeRuntimeWorkspaceTarget(target, "windows");
  return {
    workspace,
    homeOverride: "",
    connected: false,
    connectedAtUnixSecs: null,
    lastReplayCursor: 0,
    lastReplayLastEventId: null,
    lastReplayAtUnixSecs: null,
    loaded: false,
    loading: false,
  };
}

function isAbortLikeError(error) {
  if (!error) return false;
  const name = String(error?.name || "").trim();
  const message = String(error?.message || error || "").trim().toLowerCase();
  return name === "AbortError" || message.includes("aborted");
}

export function createWorkspaceUiModule(deps) {
  const {
    state,
    byId,
    api,
    normalizeWorkspaceTarget,
    localStorageRef = localStorage,
    WORKSPACE_TARGET_KEY,
    START_CWD_BY_WORKSPACE_KEY,
    detectThreadWorkspaceTarget,
    updateHeaderUi,
    renderFolderPicker,
    setStatus,
    pushThreadAnimDebug,
    recordLocalTask = () => {},
    isThreadListActuallyVisible,
    buildThreadRenderSig,
    applyThreadFilter,
    refreshThreads,
    syncEventSubscription = () => false,
    performanceRef = performance,
  } = deps;

  function ensureWorkspaceRuntimeState(target = "windows") {
    const workspace = normalizeRuntimeWorkspaceTarget(target, "windows");
    if (!state.workspaceRuntimeByTarget || typeof state.workspaceRuntimeByTarget !== "object") {
      state.workspaceRuntimeByTarget = {
        windows: createFallbackRuntimeState("windows"),
        wsl2: createFallbackRuntimeState("wsl2"),
      };
    }
    if (!state.workspaceRuntimeByTarget[workspace]) {
      state.workspaceRuntimeByTarget[workspace] = createFallbackRuntimeState(workspace);
    }
    return state.workspaceRuntimeByTarget[workspace];
  }

  function getWorkspaceTarget() {
    return normalizeWorkspaceTarget(state.workspaceTarget || "windows");
  }

  function getWorkspaceRuntimeState(target = getWorkspaceTarget()) {
    return ensureWorkspaceRuntimeState(target);
  }

  function getStartCwdForWorkspace(target = getWorkspaceTarget()) {
    const workspace = normalizeWorkspaceTarget(target);
    return normalizeStartCwd(state.startCwdByWorkspace?.[workspace] || "", workspace);
  }

  function persistStartCwdByWorkspace() {
    try {
      const payload = {
        windows: normalizeStartCwd(state.startCwdByWorkspace?.windows || "", "windows"),
        wsl2: normalizeStartCwd(state.startCwdByWorkspace?.wsl2 || "", "wsl2"),
      };
      localStorageRef.setItem(START_CWD_BY_WORKSPACE_KEY, JSON.stringify(payload));
    } catch {}
  }

  function setStartCwdForWorkspace(target, value) {
    const workspace = normalizeWorkspaceTarget(target);
    const nextValue = normalizeStartCwd(value, workspace);
    if (state.startCwdByWorkspace[workspace] === nextValue) {
      applyWorkspaceUi();
      if (getWorkspaceTarget() === workspace) applyThreadFilter();
      return;
    }
    state.startCwdByWorkspace[workspace] = nextValue;
    persistStartCwdByWorkspace();
    applyWorkspaceUi();
    if (getWorkspaceTarget() === workspace) {
      applyThreadFilter();
      refreshThreads(workspace, { force: false, silent: true }).catch(() => {});
    }
  }

  function getWorkspaceLabel() {
    const target = getWorkspaceTarget();
    const cwd = getStartCwdForWorkspace(target);
    if (!cwd) return "Select folder";
    return folderDisplayName(cwd, target) || cwd;
  }

  function getActiveWorkspaceBadgeLabel() {
    return state.activeThreadWorkspace === "wsl2" ? "WSL2" : "WIN";
  }

  function syncActiveThreadMetaFromList(threadId = resolveCurrentThreadId(state)) {
    const currentThreadId = String(threadId || resolveCurrentThreadId(state) || "").trim();
    if (!currentThreadId) return;
    const thread = state.threadItemsAll.find(
      (item) => (item?.id || item?.threadId || "") === currentThreadId
    );
    if (!thread) return;
    const target = detectThreadWorkspaceTarget(thread);
    if (target !== "unknown") state.activeThreadWorkspace = target;
    const rolloutPath = String(thread?.path || "").trim();
    if (rolloutPath) state.activeThreadRolloutPath = rolloutPath;
    state.activeThreadIsWorktree = thread?.isWorktree === true;
    const attachTransport = String(state.threadAttachTransportById?.get?.(String(currentThreadId || "")) || "").trim();
    state.activeThreadAttachTransport = attachTransport;
    setThreadOpenState(state, resolveThreadOpenState({
      threadId: currentThreadId,
      threadStatusType: thread?.status?.type || "",
      historyThreadId: state?.activeThreadHistoryThreadId,
      historyIncomplete: state?.activeThreadHistoryIncomplete === true,
      historyStatusType: state?.activeThreadHistoryStatusType,
      pendingTurnRunning: state?.activeThreadPendingTurnRunning === true,
      pendingThreadId: state?.activeThreadPendingTurnThreadId,
    }), {
      loaded: state.activeThreadOpenState?.loaded === true,
    });
  }

  async function refreshWorkspaceRuntimeState(target = getWorkspaceTarget(), options = {}) {
    if (typeof api !== "function") return null;
    const workspace = normalizeRuntimeWorkspaceTarget(target, getWorkspaceTarget());
    const current = ensureWorkspaceRuntimeState(workspace);
    if (!state.workspaceRuntimeRefreshReqSeqByWorkspace || typeof state.workspaceRuntimeRefreshReqSeqByWorkspace !== "object") {
      state.workspaceRuntimeRefreshReqSeqByWorkspace = { windows: 0, wsl2: 0 };
    }
    const reqSeq = (Number(state.workspaceRuntimeRefreshReqSeqByWorkspace[workspace] || 0) || 0) + 1;
    state.workspaceRuntimeRefreshReqSeqByWorkspace[workspace] = reqSeq;
    current.loading = true;
    try {
      const payload = await api(buildRuntimeStateUrl(workspace));
      if (state.workspaceRuntimeRefreshReqSeqByWorkspace[workspace] !== reqSeq) return null;
      const normalized = normalizeRuntimeStatePayload(payload, workspace);
      state.workspaceRuntimeByTarget[workspace] = normalized;
      if (options.updateHeader !== false && state.activeThreadWorkspace === workspace) {
        updateHeaderUi();
      }
      return normalized;
    } catch (error) {
      if (state.workspaceRuntimeRefreshReqSeqByWorkspace[workspace] !== reqSeq) return null;
      state.workspaceRuntimeByTarget[workspace] = {
        ...current,
        workspace,
        loaded: true,
        loading: false,
      };
      if (options.silent !== true && error?.message && !isAbortLikeError(error)) {
        setStatus(error.message, true);
      }
      if (options.updateHeader !== false && state.activeThreadWorkspace === workspace) {
        updateHeaderUi();
      }
      return null;
    } finally {
      if (state.workspaceRuntimeRefreshReqSeqByWorkspace[workspace] === reqSeq) {
        ensureWorkspaceRuntimeState(workspace).loading = false;
      }
    }
  }

  function hasDualWorkspaceTargets() {
    return !!(
      state.workspaceAvailability.windowsInstalled && state.workspaceAvailability.wsl2Installed
    );
  }

  function isWorkspaceAvailable(target) {
    return target === "wsl2"
      ? !!state.workspaceAvailability.wsl2Installed
      : !!state.workspaceAvailability.windowsInstalled;
  }

  function applyWorkspaceUi() {
    const target = getWorkspaceTarget();
    const winBtn = byId("workspaceWindowsBtn");
    const wslBtn = byId("workspaceWslBtn");
    const drawerWinBtn = byId("drawerWorkspaceWindowsBtn");
    const drawerWslBtn = byId("drawerWorkspaceWslBtn");
    const drawerSwitch = byId("drawerWorkspaceSwitch");
    const canUseWindows = isWorkspaceAvailable("windows");
    const canUseWsl2 = isWorkspaceAvailable("wsl2");
    if (drawerSwitch) drawerSwitch.style.display = "";

    if (winBtn) winBtn.disabled = !canUseWindows;
    if (wslBtn) wslBtn.disabled = !canUseWsl2;
    if (drawerWinBtn) drawerWinBtn.disabled = !canUseWindows;
    if (drawerWslBtn) drawerWslBtn.disabled = !canUseWsl2;

    if (winBtn) winBtn.classList.toggle("active", target === "windows");
    if (wslBtn) wslBtn.classList.toggle("active", target === "wsl2");
    if (drawerWinBtn) drawerWinBtn.classList.toggle("active", target === "windows");
    if (drawerWslBtn) drawerWslBtn.classList.toggle("active", target === "wsl2");
    const label = getWorkspaceLabel();
    const drawer = byId("drawerWorkspaceText");
    const welcome = byId("welcomeWorkspaceText");
    if (drawer) drawer.textContent = label;
    if (welcome) welcome.textContent = label;
    if (state.folderPickerOpen) renderFolderPicker();
    updateHeaderUi();
  }

  async function setWorkspaceTarget(nextTarget) {
    const startedAt = performanceRef.now();
    const target = normalizeWorkspaceTarget(nextTarget);
    if (!isWorkspaceAvailable(target)) return;
    if (state.workspaceTarget === target) return;
    const previousTarget = normalizeWorkspaceTarget(state.workspaceTarget);
    state.collapsedWorkspaceKeysByWorkspace[previousTarget] = state.collapsedWorkspaceKeys;
    state.workspaceTarget = target;
    state.collapsedWorkspaceKeys =
      state.collapsedWorkspaceKeysByWorkspace[target] instanceof Set
        ? state.collapsedWorkspaceKeysByWorkspace[target]
        : new Set();
    localStorageRef.setItem(WORKSPACE_TARGET_KEY, target);
    applyWorkspaceUi();
    setStatus(`Workspace target: ${target.toUpperCase()}`);
    syncEventSubscription();
    refreshWorkspaceRuntimeState(target, { silent: true, updateHeader: true }).catch(() => null);
    const cached = Array.isArray(state.threadItemsByWorkspace[target])
      ? state.threadItemsByWorkspace[target]
      : [];
    const hasHydrated = !!state.threadWorkspaceHydratedByWorkspace[target];
    const listActuallyVisible = isThreadListActuallyVisible();
    pushThreadAnimDebug("setWorkspaceTarget", {
      target,
      previousTarget,
      hasHydrated,
      cachedCount: cached.length,
      listActuallyVisible,
    });
    if (hasHydrated) {
      state.threadItemsAll = cached;
      state.threadListRenderSigByWorkspace[target] = buildThreadRenderSig(cached);
      syncActiveThreadMetaFromList();
      state.threadListLoading = false;
      state.threadListLoadingTarget = "";
      state.threadListPreferLoadingPlaceholder = false;
      state.threadListPendingVisibleAnimationByWorkspace[target] = cached.length > 0;
      state.threadListAnimateNextRender =
        cached.length > 0 && isThreadListActuallyVisible();
      state.threadListAnimateThreadIds = new Set();
      applyThreadFilter();
      updateHeaderUi();
      setStatus(`Refreshing ${target.toUpperCase()} chats...`);
    } else {
      state.threadItemsAll = [];
      state.threadItems = [];
      state.threadListLoading = true;
      state.threadListLoadingTarget = target;
      state.threadListPreferLoadingPlaceholder = true;
      state.threadListAnimateNextRender = false;
      state.threadListAnimateThreadIds = new Set();
      deps.renderThreads([]);
      updateHeaderUi();
      setStatus(`Loading ${target.toUpperCase()} chats...`);
    }
    recordLocalTask({
      command: "workspace switch sync",
      elapsedMs: performanceRef.now() - startedAt,
      fields: {
        target,
        previousTarget,
        hasHydrated,
        cachedCount: cached.length,
        listActuallyVisible,
      },
    });
    refreshThreads(target, { force: false, silent: hasHydrated }).catch((e) =>
      setStatus(e.message, true)
    );
  }

  return {
    applyWorkspaceUi,
    getActiveWorkspaceBadgeLabel,
    getStartCwdForWorkspace,
    getWorkspaceLabel,
    getWorkspaceTarget,
    hasDualWorkspaceTargets,
    isWorkspaceAvailable,
    persistStartCwdByWorkspace,
    refreshWorkspaceRuntimeState,
    setStartCwdForWorkspace,
    setWorkspaceTarget,
    getWorkspaceRuntimeState,
    syncActiveThreadMetaFromList,
  };
}
