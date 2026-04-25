export function shouldOpenDrawerWithAnimation(tab, wasThreadsOpen) {
  return tab === "threads" && !wasThreadsOpen;
}

const EDGE_SWIPE_COMMIT_DELTA_PX = 12;
const EDGE_SWIPE_VERTICAL_TOLERANCE_PX = 40;
const EDGE_SWIPE_HORIZONTAL_LOCK_PX = 16;

function readTouchPoint(event) {
  const touch =
    event?.touches?.[0] ||
    event?.changedTouches?.[0] ||
    null;
  if (!touch) return null;
  return {
    x: Number(touch.clientX || 0),
    y: Number(touch.clientY || 0),
  };
}

export function isCompactMobileViewport(windowRef) {
  if (windowRef?.matchMedia) return windowRef.matchMedia("(max-width: 1080px)").matches;
  if (typeof windowRef?.innerWidth === "number") return windowRef.innerWidth <= 1080;
  return false;
}

export function shouldStartDrawerEdgeSwipe({ startX, body, windowRef }) {
  if (!Number.isFinite(startX)) return false;
  if (!isCompactMobileViewport(windowRef)) return false;
  if (!body?.classList) return false;
  if (body.classList.contains("drawer-left-open")) return false;
  if (body.classList.contains("drawer-right-open")) return false;
  return true;
}

export function shouldCommitDrawerOpen({ deltaX, drawerWidth }) {
  if (!Number.isFinite(deltaX) || deltaX <= 0) return false;
  return deltaX >= EDGE_SWIPE_COMMIT_DELTA_PX;
}

export function shouldStartDrawerCloseSwipe({ startX, body, panelRect, windowRef }) {
  if (!isCompactMobileViewport(windowRef)) return false;
  if (!body?.classList?.contains?.("drawer-left-open")) return false;
  if (body.classList.contains("drawer-right-open")) return false;
  return Number.isFinite(startX);
}

export function shouldCommitDrawerClose({ deltaX, drawerWidth }) {
  if (!Number.isFinite(deltaX) || deltaX >= 0) return false;
  return shouldCommitDrawerOpen({ deltaX: Math.abs(deltaX), drawerWidth });
}

export function createMobileShellModule(deps) {
  const {
    state,
    byId,
    documentRef = document,
    windowRef = documentRef?.defaultView,
    normalizeWorkspaceTarget,
    getWorkspaceTarget,
    pushThreadAnimDebug,
    renderThreads,
    hideSlashCommandMenu = () => {},
  } = deps;

  function getLeftDrawerPanel() {
    return byId("leftPanel") || documentRef?.querySelector?.(".leftPanel") || null;
  }

  function updateDrawerDragVisual(deltaX, mode = "open") {
    const body = documentRef?.body;
    const backdrop = byId("mobileDrawerBackdrop");
    if (!body?.style || !body?.classList || !backdrop?.classList) return;
    const leftPanel = getLeftDrawerPanel();
    const drawerWidth = Math.max(Number(leftPanel?.getBoundingClientRect?.().width || 0), 1);
    if (mode === "close") {
      const clamped = Math.max(-drawerWidth, Math.min(deltaX, 0));
      const progress = Math.max(0, Math.min(1 + clamped / drawerWidth, 1));
      body.style.setProperty("--drawer-left-drag-translate", `${clamped}px`);
      body.style.setProperty("--drawer-left-backdrop-opacity", String(progress));
    } else {
      const hiddenOffset = drawerWidth * 1.08;
      const clamped = Math.max(0, Math.min(deltaX, hiddenOffset));
      const translate = -hiddenOffset + clamped;
      const progress = Math.max(0, Math.min(clamped / drawerWidth, 1));
      body.style.setProperty("--drawer-left-drag-translate", `${translate}px`);
      body.style.setProperty("--drawer-left-backdrop-opacity", String(progress));
    }
    body.classList.add("drawer-left-dragging");
    if (mode === "open") body.classList.add("drawer-left-previewing");
    else body.classList.remove("drawer-left-previewing");
    backdrop.classList.add("show");
  }

  function clearDrawerDragVisual() {
    const body = documentRef?.body;
    const backdrop = byId("mobileDrawerBackdrop");
    body?.classList?.remove?.("drawer-left-dragging");
    body?.classList?.remove?.("drawer-left-previewing");
    body?.style?.removeProperty?.("--drawer-left-drag-translate");
    body?.style?.removeProperty?.("--drawer-left-backdrop-opacity");
    if (!body?.classList?.contains?.("drawer-left-open") && !body?.classList?.contains?.("drawer-right-open")) {
      backdrop?.classList?.remove?.("show");
    }
  }

  function setMobileTab(tab) {
    hideSlashCommandMenu();
    const wasThreadsOpen = documentRef.body.classList.contains("drawer-left-open");
    pushThreadAnimDebug("setMobileTab:start", { tab, wasThreadsOpen });
    clearDrawerDragVisual();
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

  function bindDrawerEdgeSwipe() {
    if (!documentRef?.addEventListener) return;
    let swipeStart = null;
    let swipeLastPoint = null;
    let swipeDrawerWidth = 0;
    let swipeMode = "open";
    let swipeHorizontalLocked = false;

    documentRef.addEventListener(
      "touchstart",
      (event) => {
        const point = readTouchPoint(event);
        if (!point) {
          swipeStart = null;
          swipeLastPoint = null;
          return;
        }
        if (
          shouldStartDrawerEdgeSwipe({
            startX: point.x,
            body: documentRef.body,
            windowRef,
          })
        ) {
          swipeStart = point;
          swipeLastPoint = point;
          swipeDrawerWidth = Number(getLeftDrawerPanel()?.getBoundingClientRect?.().width || 0);
          swipeMode = "open";
          swipeHorizontalLocked = false;
          return;
        }
        const panelRect = getLeftDrawerPanel()?.getBoundingClientRect?.() || null;
        if (
          shouldStartDrawerCloseSwipe({
            startX: point.x,
            body: documentRef.body,
            panelRect,
            windowRef,
          })
        ) {
          swipeStart = point;
          swipeLastPoint = point;
          swipeDrawerWidth = Number(panelRect?.width || 0);
          swipeMode = "close";
          swipeHorizontalLocked = false;
          return;
        }
        swipeStart = null;
        swipeLastPoint = null;
        swipeDrawerWidth = 0;
        swipeMode = "open";
        swipeHorizontalLocked = false;
      },
      { passive: true }
    );

    documentRef.addEventListener(
      "touchmove",
      (event) => {
        if (!swipeStart) return;
        const point = readTouchPoint(event);
        if (!point) {
          swipeStart = null;
          swipeLastPoint = null;
          return;
        }
        const deltaX = point.x - swipeStart.x;
        const deltaY = Math.abs(point.y - swipeStart.y);
        if (!swipeHorizontalLocked && Math.abs(deltaX) >= EDGE_SWIPE_HORIZONTAL_LOCK_PX && Math.abs(deltaX) > deltaY) {
          swipeHorizontalLocked = true;
        }
        const invalidHorizontalDirection =
          swipeMode === "open" ? deltaX < -12 : deltaX > 12;
        const shouldCancelForVerticalDrift =
          !swipeHorizontalLocked && deltaY > EDGE_SWIPE_VERTICAL_TOLERANCE_PX;
        if (shouldCancelForVerticalDrift || invalidHorizontalDirection) {
          clearDrawerDragVisual();
          swipeStart = null;
          swipeLastPoint = null;
          swipeDrawerWidth = 0;
          swipeMode = "open";
          swipeHorizontalLocked = false;
          return;
        }
        swipeLastPoint = point;
        updateDrawerDragVisual(deltaX, swipeMode);
      },
      { passive: true }
    );

    documentRef.addEventListener(
      "touchend",
      (event) => {
        if (swipeStart) {
          const point = readTouchPoint(event) || swipeLastPoint || swipeStart;
          const deltaX = point.x - swipeStart.x;
          const shouldOpen =
            swipeMode === "open" &&
            shouldCommitDrawerOpen({
              deltaX,
              drawerWidth: swipeDrawerWidth,
            });
          const shouldClose =
            swipeMode === "close" &&
            shouldCommitDrawerClose({
              deltaX,
              drawerWidth: swipeDrawerWidth,
            });
          clearDrawerDragVisual();
          if (shouldOpen) setMobileTab("threads");
          else if (shouldClose) setMobileTab("chat");
        }
        swipeStart = null;
        swipeLastPoint = null;
        swipeDrawerWidth = 0;
        swipeMode = "open";
        swipeHorizontalLocked = false;
      },
      { passive: true }
    );

    documentRef.addEventListener(
      "touchcancel",
      () => {
        clearDrawerDragVisual();
        swipeStart = null;
        swipeLastPoint = null;
        swipeDrawerWidth = 0;
        swipeMode = "open";
        swipeHorizontalLocked = false;
      },
      { passive: true }
    );
  }

  bindDrawerEdgeSwipe();

  return { setMobileTab };
}
