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

export function createWorkspaceUiModule(deps) {
  const {
    state,
    byId,
    normalizeWorkspaceTarget,
    localStorageRef = localStorage,
    WORKSPACE_TARGET_KEY,
    START_CWD_BY_WORKSPACE_KEY,
    detectThreadWorkspaceTarget,
    updateHeaderUi,
    renderFolderPicker,
    setStatus,
    pushThreadAnimDebug,
    isThreadListActuallyVisible,
    buildThreadRenderSig,
    applyThreadFilter,
    refreshThreads,
  } = deps;

  function getWorkspaceTarget() {
    return normalizeWorkspaceTarget(state.workspaceTarget || "windows");
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
    state.startCwdByWorkspace[workspace] = normalizeStartCwd(value, workspace);
    persistStartCwdByWorkspace();
    applyWorkspaceUi();
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

  function syncActiveThreadMetaFromList(threadId = state.activeThreadId) {
    if (!threadId) return;
    const thread = state.threadItemsAll.find(
      (item) => (item?.id || item?.threadId || "") === threadId
    );
    if (!thread) return;
    const target = detectThreadWorkspaceTarget(thread);
    if (target !== "unknown") state.activeThreadWorkspace = target;
    const rolloutPath = String(thread?.path || "").trim();
    if (rolloutPath) state.activeThreadRolloutPath = rolloutPath;
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
    const cached = Array.isArray(state.threadItemsByWorkspace[target])
      ? state.threadItemsByWorkspace[target]
      : [];
    const hasHydrated = !!state.threadWorkspaceHydratedByWorkspace[target];
    pushThreadAnimDebug("setWorkspaceTarget", {
      target,
      previousTarget,
      hasHydrated,
      cachedCount: cached.length,
      listActuallyVisible: isThreadListActuallyVisible(),
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
    setStartCwdForWorkspace,
    setWorkspaceTarget,
    syncActiveThreadMetaFromList,
  };
}
