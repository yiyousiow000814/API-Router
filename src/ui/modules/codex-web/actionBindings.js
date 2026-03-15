export function shouldSubmitPromptKey(event) {
  return (
    String(event?.key || "") === "Enter" &&
    !event?.shiftKey &&
    !event?.isComposing
  );
}

export function resolveActionErrorMessage(error, fallback) {
  return error?.message || String(error || fallback || "Action failed");
}

export function createActionBindingsModule(deps) {
  const {
    state,
    byId,
    bindClick,
    bindResponsiveClick,
    bindInput,
    setStatus,
    updateMobileComposerState,
    updateNotificationState,
    armSyntheticClickSuppression,
    wireBlurBackdropShield,
    closeFolderPicker,
    refreshFolderPicker,
    renderFolderPicker,
    confirmFolderPickerCurrentPath,
    resetFolderPickerPath,
    switchFolderPickerWorkspace,
    openFolderPicker,
    newThread,
    setMainTab,
    setMobileTab,
    refreshCodexVersions,
    setWorkspaceTarget,
    setHeaderModelMenuOpen,
    closeInlineEffortOverlay,
    shouldSuppressSyntheticClick,
    renderThreads,
    wireThreadPullToRefresh,
    addHost,
    resolveApproval,
    resolveUserInput,
    refreshPending,
    uploadAttachment,
    executeSlashCommand = async () => null,
    sendTurn,
    syncSlashCommandMenu = () => {},
    handleSlashCommandKeyDown = () => false,
    syncSettingsControlsFromMain = () => {},
    LIVE_INSPECTOR_ENABLED_KEY = "web_codex_live_inspector_enabled_v1",
    localStorageRef,
    windowRef,
    documentRef,
    NotificationRef,
  } = deps;
  const storage = localStorageRef ?? globalThis.localStorage ?? { getItem() { return ""; }, setItem() {} };
  const win = windowRef ?? globalThis.window ?? {};
  const doc = documentRef ?? globalThis.document;
  const NotificationApi = NotificationRef ?? globalThis.Notification;

  function wireActions() {
    bindClick("addHostBtn", () => addHost().catch((e) => setStatus(resolveActionErrorMessage(e), true)));
    bindClick("resolveApprovalBtn", () =>
      resolveApproval().catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    bindClick("resolveUserInputBtn", () =>
      resolveUserInput().catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    bindClick("refreshPendingBtn", () =>
      refreshPending().catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    bindInput("attachInput", "change", (event) => {
      uploadAttachment(event.target?.files?.[0]).catch((e) =>
        setStatus(resolveActionErrorMessage(e), true)
      );
    });
    bindClick("mobileAttachBtn", () => byId("attachInput")?.click());
    bindClick("mobileSendBtn", () =>
      sendTurn().catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    bindInput("mobilePromptInput", "input", () => {
      updateMobileComposerState();
      syncSlashCommandMenu();
    });
    bindInput("mobilePromptInput", "keyup", (event) => {
      if (String(event?.key || "") === "Escape") return;
      updateMobileComposerState();
      syncSlashCommandMenu();
    });
    bindInput("mobilePromptInput", "change", () => {
      updateMobileComposerState();
      syncSlashCommandMenu();
    });
    bindInput("mobilePromptInput", "keydown", (event) => {
      if (handleSlashCommandKeyDown(event)) return;
      if (!shouldSubmitPromptKey(event)) return;
      event.preventDefault();
      sendTurn().catch((e) => setStatus(resolveActionErrorMessage(e), true));
    });
    bindClick("enableNotifBtn", async () => {
      if (!("Notification" in win)) {
        setStatus("Notifications are not supported.", true);
        return;
      }
      try {
        await NotificationApi.requestPermission();
      } catch {}
      updateNotificationState();
    });
    bindClick("toggleLiveInspectorBtn", async () => {
      const current =
        String(storage.getItem(LIVE_INSPECTOR_ENABLED_KEY) || "").trim() === "1";
      const next = !current;
      try {
        storage.setItem(LIVE_INSPECTOR_ENABLED_KEY, next ? "1" : "0");
      } catch {}
      try {
        win.__webCodexDebug?.toggleLiveInspector?.(next);
      } catch {}
      syncSettingsControlsFromMain();
    });
    bindClick("previewUpdatedPlanBtn", () => {
      try {
        const result = win.__webCodexDebug?.previewUpdatedPlan?.();
        if (result?.ok === false && result?.error) {
          setStatus(String(result.error), true);
          return;
        }
        setStatus("Updated Plan preview shown.");
      } catch (error) {
        setStatus(resolveActionErrorMessage(error, "Failed to preview Updated Plan."), true);
      }
    });
    bindClick("settingsFullAccessOnBtn", () =>
      executeSlashCommand("/permission full-access", {
        clearPrompt: false,
        hideMenu: false,
        switchToChat: false,
        refreshThreads: false,
        setStatus: false,
      })
        .then(() => {
          syncSettingsControlsFromMain();
          setStatus("Full access enabled for this Web chat.");
        })
        .catch((e) => setStatus(resolveActionErrorMessage(e, "Failed to update full access."), true))
    );
    bindClick("settingsFullAccessOffBtn", () =>
      executeSlashCommand("/permission auto", {
        clearPrompt: false,
        hideMenu: false,
        switchToChat: false,
        refreshThreads: false,
        setStatus: false,
      })
        .then(() => {
          syncSettingsControlsFromMain();
          setStatus("Full access disabled for this Web chat.");
        })
        .catch((e) => setStatus(resolveActionErrorMessage(e, "Failed to update full access."), true))
    );
    bindClick("settingsFastOnBtn", () =>
      executeSlashCommand("/fast on", {
        clearPrompt: false,
        hideMenu: false,
        switchToChat: false,
        refreshThreads: false,
        setStatus: false,
      })
        .then(() => {
          syncSettingsControlsFromMain();
          setStatus("Fast mode enabled for this Web chat.");
        })
        .catch((e) => setStatus(resolveActionErrorMessage(e, "Failed to update fast mode."), true))
    );
    bindClick("settingsFastOffBtn", () =>
      executeSlashCommand("/fast off", {
        clearPrompt: false,
        hideMenu: false,
        switchToChat: false,
        refreshThreads: false,
        setStatus: false,
      })
        .then(() => {
          syncSettingsControlsFromMain();
          setStatus("Fast mode disabled for this Web chat.");
        })
        .catch((e) => setStatus(resolveActionErrorMessage(e, "Failed to update fast mode."), true))
    );
    bindClick("dismissGuideBtn", () => {
      localStorage.setItem("web_codex_guide_dismissed_v2", "1");
      if (byId("guideList")) byId("guideList").style.display = "none";
    });
    {
      const btn = byId("mobileMenuBtn");
      if (btn && !btn.__wiredPointerOpenDrawer) {
        btn.__wiredPointerOpenDrawer = true;
        const open = (event) => {
          try {
            event?.preventDefault?.();
            event?.stopPropagation?.();
          } catch {}
          if (event && String(event.type || "") === "pointerdown") {
            armSyntheticClickSuppression(450);
          }
          setMobileTab("threads");
        };
        btn.addEventListener("pointerdown", open, { passive: false });
        btn.addEventListener("click", open);
      }
    }
    {
      const backdrop = byId("mobileDrawerBackdrop");
      wireBlurBackdropShield(backdrop, {
        onClose: () => setMobileTab("chat"),
        suppressMs: 420,
      });
    }
    {
      const folderBackdrop = byId("folderPickerBackdrop");
      wireBlurBackdropShield(folderBackdrop, {
        onClose: closeFolderPicker,
        modalSelector: ".folderPickerModal",
        suppressMs: 420,
      });
    }
    bindClick("folderPickerCloseBtn", () => closeFolderPicker());
    bindClick("folderPickerUpBtn", () => {
      if (state.folderPickerLoading) return;
      const parentPath = String(state.folderPickerParentPath || "").trim();
      if (!parentPath) return;
      refreshFolderPicker(parentPath).catch((e) => {
        state.folderPickerError = e?.message || "Failed to browse folders.";
        renderFolderPicker();
      });
    });
    bindClick("folderPickerUseCurrentBtn", () => confirmFolderPickerCurrentPath());
    bindClick("folderPickerUseDefaultBtn", () => resetFolderPickerPath());
    bindClick("folderPickerWorkspaceWindowsBtn", () =>
      switchFolderPickerWorkspace("windows").catch((e) => {
        state.folderPickerError = String(e?.message || e || "Failed to switch workspace.");
        renderFolderPicker();
      })
    );
    bindClick("folderPickerWorkspaceWslBtn", () =>
      switchFolderPickerWorkspace("wsl2").catch((e) => {
        state.folderPickerError = String(e?.message || e || "Failed to switch workspace.");
        renderFolderPicker();
      })
    );
    doc.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.folderPickerOpen) closeFolderPicker();
    });
    bindClick("leftStartDirBtn", () =>
      openFolderPicker().catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    bindClick("leftNewChatBtn", () => {
      newThread().catch((e) => setStatus(resolveActionErrorMessage(e), true));
      setMainTab("chat");
      setMobileTab("chat");
    });
    bindClick("leftSettingsBtn", () => {
      setMainTab("settings");
      syncSettingsControlsFromMain();
      refreshCodexVersions().catch(() => {});
      setMobileTab("chat");
    });
    bindClick("welcomeWorkspaceBtn", () =>
      openFolderPicker().catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    bindResponsiveClick("workspaceWindowsBtn", () =>
      setWorkspaceTarget("windows")
        .then(() => syncSettingsControlsFromMain())
        .catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    bindResponsiveClick("workspaceWslBtn", () =>
      setWorkspaceTarget("wsl2")
        .then(() => syncSettingsControlsFromMain())
        .catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    bindResponsiveClick("drawerWorkspaceWindowsBtn", () =>
      setWorkspaceTarget("windows")
        .then(() => syncSettingsControlsFromMain())
        .catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    bindResponsiveClick("drawerWorkspaceWslBtn", () =>
      setWorkspaceTarget("wsl2")
        .then(() => syncSettingsControlsFromMain())
        .catch((e) => setStatus(resolveActionErrorMessage(e), true))
    );
    const headerModelPicker = byId("headerModelPicker");
    const headerModelTrigger = byId("headerModelTrigger");
    if (headerModelTrigger) {
      const toggle = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (state.modelOptionsLoading) return;
        if (event && String(event.type || "") === "pointerdown") {
          armSyntheticClickSuppression(380);
        }
        const isOpen = !!headerModelPicker?.classList.contains("open");
        setHeaderModelMenuOpen(!isOpen);
      };
      if (!headerModelTrigger.__wiredPointerToggle) {
        headerModelTrigger.__wiredPointerToggle = true;
        if (typeof window !== "undefined" && "PointerEvent" in window) {
          headerModelTrigger.addEventListener("pointerdown", toggle, { passive: false });
        } else {
          headerModelTrigger.addEventListener("click", toggle);
        }
      }
      headerModelTrigger.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (state.modelOptionsLoading) return;
          const isOpen = !!headerModelPicker?.classList.contains("open");
          setHeaderModelMenuOpen(!isOpen);
        } else if (event.key === "Escape") {
          setHeaderModelMenuOpen(false);
        }
      };
    }
    if (!doc.__wiredSyntheticClickCapture) {
      doc.__wiredSyntheticClickCapture = true;
      doc.addEventListener(
        "click",
        (event) => {
          shouldSuppressSyntheticClick(event);
        },
        true
      );
    }
    doc.addEventListener("click", (event) => {
      if (shouldSuppressSyntheticClick(event)) return;
      const target = event.target;
      if (!headerModelPicker || !(target instanceof Node)) return;
      if (!headerModelPicker.contains(target)) {
        setHeaderModelMenuOpen(false);
        closeInlineEffortOverlay();
      }
    });
    bindClick("quickPrompt1", () => {
      const text = "Explain the current codebase structure";
      if (byId("mobilePromptInput")) byId("mobilePromptInput").value = text;
      updateMobileComposerState();
      syncSlashCommandMenu();
    });
    bindClick("quickPrompt2", () => {
      const text = "Write tests for the main module";
      if (byId("mobilePromptInput")) byId("mobilePromptInput").value = text;
      updateMobileComposerState();
      syncSlashCommandMenu();
    });
    const threadSearchInput = byId("threadSearchInput");
    if (threadSearchInput) {
      threadSearchInput.oninput = (event) => {
        state.threadSearchQuery = String(event?.target?.value || "");
        renderThreads(state.threadItems);
      };
    }
    wireThreadPullToRefresh();
    win.addEventListener?.("resize", () => {
      updateMobileComposerState();
      setMobileTab("chat");
    });
  }

  return { wireActions };
}
