export function shouldOpenDrawerWithAnimation(tab, wasThreadsOpen) {
  return tab === "threads" && !wasThreadsOpen;
}

export function createMobileShellModule(deps) {
  const {
    state,
    byId,
    documentRef = document,
    normalizeWorkspaceTarget,
    getWorkspaceTarget,
    pushThreadAnimDebug,
    renderThreads,
    hideSlashCommandMenu = () => {},
  } = deps;

  function setMobileTab(tab) {
    hideSlashCommandMenu();
    const wasThreadsOpen = documentRef.body.classList.contains("drawer-left-open");
    pushThreadAnimDebug("setMobileTab:start", { tab, wasThreadsOpen });
    documentRef.body.classList.remove("drawer-left-open", "drawer-right-open");
    documentRef.body.classList.remove("drawer-left-opening", "drawer-right-opening");
    if (state.drawerOpenPhaseTimer) {
      clearTimeout(state.drawerOpenPhaseTimer);
      state.drawerOpenPhaseTimer = 0;
    }
    if (tab === "threads") documentRef.body.classList.add("drawer-left-open");
    if (tab === "tools") documentRef.body.classList.add("drawer-right-open");
    if (shouldOpenDrawerWithAnimation(tab, wasThreadsOpen)) {
      state.threadListVisibleOpenAnimationUntil = Date.now() + 520;
      documentRef.body.classList.add("drawer-left-opening");
      state.drawerOpenPhaseTimer = setTimeout(() => {
        documentRef.body.classList.remove("drawer-left-opening");
        state.drawerOpenPhaseTimer = 0;
      }, 220);
    }
    if (tab === "tools") {
      documentRef.body.classList.add("drawer-right-opening");
      state.drawerOpenPhaseTimer = setTimeout(() => {
        documentRef.body.classList.remove("drawer-right-opening");
        state.drawerOpenPhaseTimer = 0;
      }, 220);
    }
    byId("mobileDrawerBackdrop").classList.toggle("show", tab === "threads" || tab === "tools");
    if (tab !== "threads") {
      state.threadListPendingSidebarOpenAnimation = false;
      state.threadListVisibleOpenAnimationUntil = 0;
      if (state.threadListVisibleAnimationTimer) {
        clearTimeout(state.threadListVisibleAnimationTimer);
        state.threadListVisibleAnimationTimer = 0;
      }
    }
    if (shouldOpenDrawerWithAnimation(tab, wasThreadsOpen)) {
      const currentWorkspaceKey = normalizeWorkspaceTarget(getWorkspaceTarget());
      const hasThreadItems = Array.isArray(state.threadItems) && state.threadItems.length > 0;
      const animateVisibleThreadListNow = () => {
        pushThreadAnimDebug("setMobileTab:animateVisibleNow", { currentWorkspaceKey, hasThreadItems });
        state.threadListPendingVisibleAnimationByWorkspace[currentWorkspaceKey] = true;
        state.threadListAnimateNextRender = true;
        state.threadListAnimateThreadIds = new Set();
        state.threadListExpandAnimateGroupKeys = new Set();
        state.threadListSkipScrollRestoreOnce = true;
        renderThreads(state.threadItems);
      };
      if (state.threadListLoading) {
        if (hasThreadItems) {
          state.threadListPendingSidebarOpenAnimation = false;
          animateVisibleThreadListNow();
        } else {
          pushThreadAnimDebug("setMobileTab:pendingSidebarAnimation", { currentWorkspaceKey });
          state.threadListPendingSidebarOpenAnimation = true;
        }
        return;
      }
      if (hasThreadItems) animateVisibleThreadListNow();
    }
  }

  return { setMobileTab };
}
