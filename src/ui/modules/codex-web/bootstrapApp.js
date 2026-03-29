export function restoreStartCwdState(savedStartCwdRaw, normalizeStartCwd) {
  try {
    if (!savedStartCwdRaw) {
      return { windows: "", wsl2: "" };
    }
    const parsed = JSON.parse(String(savedStartCwdRaw || ""));
    return {
      windows: normalizeStartCwd(parsed?.windows || "", "windows"),
      wsl2: normalizeStartCwd(parsed?.wsl2 || "", "wsl2"),
    };
  } catch {
    return { windows: "", wsl2: "" };
  }
}

export function restoreFavoriteThreadIds(savedFavoritesRaw) {
  try {
    const savedFavorites = JSON.parse(String(savedFavoritesRaw || "[]"));
    if (Array.isArray(savedFavorites)) {
      return new Set(savedFavorites.map((value) => String(value)));
    }
  } catch {}
  return new Set();
}

function restoreMainTab(savedMainTabRaw) {
  return String(savedMainTabRaw || "").trim().toLowerCase() === "settings" ? "settings" : "chat";
}

function restoreFastModeEnabled(savedFastModeRaw) {
  const normalized = String(savedFastModeRaw || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

function restorePermissionPresetByWorkspace(savedPermissionRaw) {
  try {
    const parsed = JSON.parse(String(savedPermissionRaw || ""));
    const normalize = (value) => {
      const preset = String(value || "").trim().toLowerCase();
      if (preset === "/permission read-only") return "/permission read-only";
      if (preset === "/permission full-access") return "/permission full-access";
      return "/permission auto";
    };
    return {
      windows: normalize(parsed?.windows),
      wsl2: normalize(parsed?.wsl2),
    };
  } catch {
    return { windows: "/permission auto", wsl2: "/permission auto" };
  }
}

export function createBootstrapModule(deps) {
  const {
    state,
    byId,
    localStorageRef = localStorage,
    documentRef = document,
    requestAnimationFrameRef = requestAnimationFrame,
    MutationObserverRef = MutationObserver,
    installDebugAndE2E,
    installMobileViewportSync = () => {},
    getEmbeddedToken,
    normalizeWorkspaceTarget,
    normalizeStartCwd,
    restoreModelsCache,
    restoreThreadsCache,
    updateWorkspaceAvailability,
    applyWorkspaceUi,
    syncHeaderModelPicker,
    setStatus,
    updateNotificationState,
    applyManagedTokenUi,
    renderPendingLists,
    renderFolderPicker,
    renderAttachmentPills,
    renderComposerContextLeft,
    renderRuntimePanels = () => {},
    updateMobileComposerState,
    refreshSlashCommandsState = async () => [],
    syncSettingsControlsFromMain,
    updateWelcomeSelections,
    setMainTab,
    wireActions,
    ensureScrollToBottomBtn,
    stopChatLiveFollow,
    updateScrollToBottomBtn,
    chatDistanceFromBottom,
    dbgSet,
    canStartChatLiveFollow,
    scheduleChatLiveFollow,
    startThreadAutoRefreshLoop,
    startActiveThreadLivePollLoop,
    setMobileTab,
    connect,
    transportMode = "live",
    GUIDE_DISMISSED_KEY,
    TOKEN_STORAGE_KEY,
    WORKSPACE_TARGET_KEY,
    START_CWD_BY_WORKSPACE_KEY,
    FAVORITE_THREADS_KEY,
    SELECTED_MODEL_KEY,
    ACTIVE_MAIN_TAB_KEY,
    FAST_MODE_DEVICE_DEFAULT_KEY,
    PERMISSION_PRESET_STORAGE_KEY,
    SANDBOX_MODE,
    CHAT_STICKY_BOTTOM_PX,
  } = deps;

  function bootstrap() {
    installDebugAndE2E();
    installMobileViewportSync();
    const embeddedToken = getEmbeddedToken();
    const savedToken = localStorageRef.getItem(TOKEN_STORAGE_KEY) || "";
    const savedWorkspaceTarget = localStorageRef.getItem(WORKSPACE_TARGET_KEY) || "windows";
    const savedStartCwdRaw = localStorageRef.getItem(START_CWD_BY_WORKSPACE_KEY) || "";
    const savedFavoritesRaw = localStorageRef.getItem(FAVORITE_THREADS_KEY) || "[]";
    const savedModel = String(localStorageRef.getItem(SELECTED_MODEL_KEY) || "").trim();
    const savedMainTab = localStorageRef.getItem(ACTIVE_MAIN_TAB_KEY) || "";
    const savedFastMode = localStorageRef.getItem(FAST_MODE_DEVICE_DEFAULT_KEY) || "";
    const savedPermissionPreset = localStorageRef.getItem(PERMISSION_PRESET_STORAGE_KEY) || "";

    state.startCwdByWorkspace = restoreStartCwdState(savedStartCwdRaw, normalizeStartCwd);
    state.favoriteThreadIds = restoreFavoriteThreadIds(savedFavoritesRaw);

    const initialToken = embeddedToken || savedToken;
    if (initialToken) {
      state.token = initialToken;
      if (!embeddedToken) {
        const tokenInput = byId("tokenInput");
        if (tokenInput) tokenInput.value = initialToken;
      }
    }

    state.workspaceTarget = normalizeWorkspaceTarget(savedWorkspaceTarget);
    state.collapsedWorkspaceKeys =
      state.collapsedWorkspaceKeysByWorkspace[state.workspaceTarget] instanceof Set
        ? state.collapsedWorkspaceKeysByWorkspace[state.workspaceTarget]
        : new Set();
    state.activeThreadWorkspace = state.workspaceTarget;
    if (savedModel) state.selectedModel = savedModel;
    state.fastModeEnabled = restoreFastModeEnabled(savedFastMode);
    state.permissionPresetByWorkspace = restorePermissionPresetByWorkspace(savedPermissionPreset);

    restoreModelsCache();
    restoreThreadsCache(state.workspaceTarget);
    updateWorkspaceAvailability(false, false);
    if (state.threadItemsByWorkspace.windows.length || state.threadItemsByWorkspace.wsl2.length) {
      updateWorkspaceAvailability(
        state.threadItemsByWorkspace.windows.length > 0,
        state.threadItemsByWorkspace.wsl2.length > 0,
        { applyFilter: false }
      );
    }

    applyWorkspaceUi();
    syncHeaderModelPicker();
    if (SANDBOX_MODE) {
      const sandboxBadge = byId("sandboxBadge");
      if (sandboxBadge) sandboxBadge.style.display = "inline-flex";
      setStatus("Sandbox mode enabled: read-only preview against live data.", true);
    } else {
      setStatus("Ready.");
    }

    if (localStorageRef.getItem(GUIDE_DISMISSED_KEY) === "1" && byId("guideList")) {
      byId("guideList").style.display = "none";
    }
    updateNotificationState();
    applyManagedTokenUi();
    renderPendingLists();
    renderFolderPicker();
    renderAttachmentPills([]);
    renderComposerContextLeft();
    renderRuntimePanels();
    updateMobileComposerState();
    syncSettingsControlsFromMain();
    updateWelcomeSelections();
    setMainTab(restoreMainTab(savedMainTab));
    wireActions();
    refreshSlashCommandsState({ force: true, silent: true })
      .then(() => {
        renderComposerContextLeft();
        syncSettingsControlsFromMain();
        updateMobileComposerState();
      })
      .catch(() => {});

    try {
      const chatBox = byId("chatBox");
      if (chatBox && !chatBox.__wiredScrollToBottom) {
        chatBox.__wiredScrollToBottom = true;
        ensureScrollToBottomBtn();
        if (!chatBox.__wiredUserGesture) {
          chatBox.__wiredUserGesture = true;
          const markGesture = () => {
            state.chatLastUserGestureAt = Date.now();
            stopChatLiveFollow();
          };
          chatBox.addEventListener("pointerdown", markGesture, { passive: true });
          chatBox.addEventListener("touchstart", markGesture, { passive: true });
          chatBox.addEventListener("wheel", markGesture, { passive: true });
        }
        chatBox.addEventListener(
          "scroll",
          () => {
            updateScrollToBottomBtn();
            const now = Date.now();
            const inProgrammatic = now <= Number(state.chatProgrammaticScrollUntil || 0);
            const recentGesture = now - Number(state.chatLastUserGestureAt || 0) <= 900;
            if (now <= Number(state.chatSmoothScrollUntil || 0) && !recentGesture) return;
            if (inProgrammatic && !recentGesture) return;
            if (!recentGesture) return;
            const dist = chatDistanceFromBottom(chatBox);
            const nextSticky = dist <= CHAT_STICKY_BOTTOM_PX;
            if (inProgrammatic && nextSticky) return;
            dbgSet({
              lastChatScrollDist: Math.round(dist),
              lastChatScrollSticky: !!nextSticky,
              lastChatScrollInProgrammatic: !!inProgrammatic,
              lastChatScrollRecentGesture: !!recentGesture,
            });
            state.chatShouldStickToBottom = nextSticky;
            if (!nextSticky) {
              state.chatUserScrolledAwayAt = now;
              stopChatLiveFollow();
            } else {
              state.chatUserScrolledAwayAt = 0;
            }
          },
          { passive: true }
        );
        updateScrollToBottomBtn();
      }
    } catch {}

    try {
      const chatBox = byId("chatBox");
      if (chatBox && !chatBox.__wiredLiveFollow) {
        chatBox.__wiredLiveFollow = true;
        let scheduled = false;
        const schedule = () => {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrameRef(() => {
            scheduled = false;
            scheduleChatLiveFollow(520);
          });
        };
        const obs = new MutationObserverRef(() => {
          if (Date.now() <= Number(state.chatSmoothScrollUntil || 0)) return;
          const now = Date.now();
          const alreadyFollowing = now <= Number(state.chatLiveFollowUntil || 0);
          if (!alreadyFollowing && !canStartChatLiveFollow()) return;
          schedule();
        });
        obs.observe(chatBox, { childList: true, subtree: true, characterData: true });
      }
    } catch {}

    try {
      const chatBox = byId("chatBox");
      if (chatBox && !chatBox.__wiredMediaSettleFollow) {
        chatBox.__wiredMediaSettleFollow = true;
        const onSettle = () => {
          if (Date.now() <= Number(state.chatSmoothScrollUntil || 0)) return;
          if (!canStartChatLiveFollow()) return;
          scheduleChatLiveFollow(1200);
        };
        chatBox.addEventListener("load", onSettle, true);
        chatBox.addEventListener("error", onSettle, true);
      }
    } catch {}

    startThreadAutoRefreshLoop();
    startActiveThreadLivePollLoop();
    setMobileTab("chat");
    documentRef.body.classList.add("thread-list-bootstrapped");
    if (transportMode === "mock") {
      setStatus("Mock preview mode: local-only simulation on this device.");
      connect({ switchToChat: false }).catch((error) => setStatus(error.message, true));
      return;
    }
    if (transportMode === "safe") {
      setStatus("Preview mode: live reads with sandboxed turns on this device.");
      connect({ switchToChat: false }).catch((error) => setStatus(error.message, true));
      return;
    }
    connect({ switchToChat: false }).catch((error) => setStatus(error.message, true));
  }

  return { bootstrap };
}
