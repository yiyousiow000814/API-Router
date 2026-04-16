import { applyActiveThreadGitMetaState, activeComposerWorkspace } from "./threadGitMetaState.js";

export function shouldSubmitPromptKey(event) {
  return (
    String(event?.key || "") === "Enter" &&
    !event?.shiftKey &&
    !event?.ctrlKey &&
    !event?.altKey &&
    !event?.metaKey &&
    !event?.isComposing
  );
}

export function shouldSteerPromptKey(event) {
  return (
    String(event?.key || "") === "Tab" &&
    !event?.shiftKey &&
    !event?.ctrlKey &&
    !event?.altKey &&
    !event?.metaKey &&
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
    api,
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
    resolveProposedPlanConfirmation = async () => null,
    resolveUserInput,
    refreshPending,
    getPendingUserInputDraftAnswers = () => ({}),
    getPendingUserInputSubmissionState = () => ({}),
    setPendingUserInputDraftAnswer = () => false,
    setPendingUserInputQuestionCompleted = () => false,
    uploadAttachment,
    executeSlashCommand = async () => null,
    cancelQueuedTurnEditing = () => {},
    clearQueuedTurn = () => {},
    editQueuedTurn = async () => false,
    maybeRestoreDeferredQueuedTurnEdit = () => false,
    queueFollowUpTurn = async () => null,
    saveQueuedTurnEdit = () => false,
    sendNowTurn = async () => null,
    sendQueuedTurnNow = async () => null,
    sendTurn,
    scrollToBottomReliable = () => {},
    steerTurn = async () => null,
    setComposerActionMenuOpen = () => {},
    syncSlashCommandMenu = () => {},
    handleSlashCommandKeyDown = () => false,
    syncSettingsControlsFromMain = () => {},
    updateQueuedTurnEditingDraft = () => false,
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
  const scheduleTimeout =
    typeof win?.setTimeout === "function"
      ? win.setTimeout.bind(win)
      : typeof globalThis.setTimeout === "function"
        ? globalThis.setTimeout.bind(globalThis)
        : (callback) => callback();
    const PENDING_FREEFORM_EXIT_MS = 180;

  function advanceOrResolvePendingUserInput(id) {
    const submission = getPendingUserInputSubmissionState(id);
    if (!submission?.item) {
      const answers = getPendingUserInputDraftAnswers(id);
      return resolveUserInput({ id, answers });
    }
    if (submission.isComplete) {
      const answers = getPendingUserInputDraftAnswers(id);
      return resolveUserInput({ id, answers });
    }
    if (!submission.currentQuestionId) {
      throw new Error("question state unavailable");
    }
    if (!String(submission.currentAnswer || "").trim()) {
      throw new Error("answer required");
    }
    setPendingUserInputQuestionCompleted(id, submission.currentQuestionId, true);
    const nextState = getPendingUserInputSubmissionState(id);
    if (nextState.isComplete) {
      const answers = getPendingUserInputDraftAnswers(id);
      return resolveUserInput({ id, answers });
    }
    return Promise.resolve();
  }

  function applyPendingUserInputOptionSelection(optionBtn) {
    const nextMode =
      optionBtn.getAttribute("data-pending-answer-mode") === "freeform"
        ? "freeform"
        : "option";
    const applySelection = () =>
      setPendingUserInputDraftAnswer(
        optionBtn.getAttribute("data-pending-user-input-id"),
        optionBtn.getAttribute("data-pending-answer-key"),
        nextMode === "freeform"
          ? ""
          : optionBtn.getAttribute("data-pending-answer-value"),
        { mode: nextMode }
      );
    if (nextMode === "freeform") {
      applySelection();
      setPendingUserInputQuestionCompleted(
        optionBtn.getAttribute("data-pending-user-input-id"),
        optionBtn.getAttribute("data-pending-answer-key"),
        false
      );
      return;
    }
    const question = optionBtn.closest?.(".pendingInlineQuestion");
    const freeformWrap = question?.querySelector?.(".pendingInlineFreeformWrap.is-visible");
    if (!freeformWrap || freeformWrap.dataset.pendingExit === "1") {
      applySelection();
      return;
    }
    freeformWrap.dataset.pendingExit = "1";
    freeformWrap.classList.remove("is-visible");
    const freeformInput = freeformWrap.querySelector?.("[data-pending-freeform-input]");
    freeformInput?.blur?.();
    scheduleTimeout(() => {
      delete freeformWrap.dataset.pendingExit;
      applySelection();
      setPendingUserInputQuestionCompleted(
        optionBtn.getAttribute("data-pending-user-input-id"),
        optionBtn.getAttribute("data-pending-answer-key"),
        false
      );
    }, PENDING_FREEFORM_EXIT_MS);
  }

  function applyThreadGitMeta(payload) {
    return applyActiveThreadGitMetaState(state, payload);
  }

  function closeComposerPickerMenus() {
    state.composerBranchMenuOpen = false;
    state.composerPermissionMenuOpen = false;
    updateMobileComposerState();
  }

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
    {
      const approvalList = byId("approvalPendingList");
      if (approvalList && !approvalList.__wiredPendingApprovalActions) {
        approvalList.__wiredPendingApprovalActions = true;
        approvalList.addEventListener("click", (event) => {
          const actionBtn = event?.target?.closest?.("[data-pending-approval-decision]");
          if (!actionBtn) return;
          event.preventDefault();
          event.stopPropagation();
          resolveApproval({
            id: actionBtn.getAttribute("data-pending-approval-id"),
            decision: actionBtn.getAttribute("data-pending-approval-decision"),
          }).catch((e) => setStatus(resolveActionErrorMessage(e), true));
        });
      }
    }
    {
      const userInputList = byId("userInputPendingList");
      if (userInputList && !userInputList.__wiredPendingUserInputActions) {
        userInputList.__wiredPendingUserInputActions = true;
        userInputList.addEventListener("click", (event) => {
          const planDecisionBtn = event?.target?.closest?.("[data-proposed-plan-decision]");
          if (planDecisionBtn) {
            event.preventDefault();
            event.stopPropagation();
            resolveProposedPlanConfirmation({
              decision: planDecisionBtn.getAttribute("data-proposed-plan-decision"),
            }).catch((e) => setStatus(resolveActionErrorMessage(e), true));
            return;
          }
          const optionBtn = event?.target?.closest?.("[data-pending-answer-key]");
          if (optionBtn) {
            event.preventDefault();
            event.stopPropagation();
            applyPendingUserInputOptionSelection(optionBtn);
            return;
          }
          const submitBtn = event?.target?.closest?.("[data-pending-user-input-submit]");
          if (!submitBtn) return;
          event.preventDefault();
          event.stopPropagation();
          const id = String(submitBtn.getAttribute("data-pending-user-input-submit") || "").trim();
          Promise.resolve().then(() => advanceOrResolvePendingUserInput(id)).catch((e) => setStatus(resolveActionErrorMessage(e), true));
        });
      }
    }
    {
      const chatBox = byId("chatBox");
      if (chatBox && !chatBox.__wiredPendingInlineActions) {
        chatBox.__wiredPendingInlineActions = true;
        chatBox.addEventListener("click", (event) => {
          const planDecisionBtn = event?.target?.closest?.("[data-proposed-plan-decision]");
          if (planDecisionBtn) {
            event.preventDefault();
            event.stopPropagation();
            resolveProposedPlanConfirmation({
              decision: planDecisionBtn.getAttribute("data-proposed-plan-decision"),
            }).catch((e) => setStatus(resolveActionErrorMessage(e), true));
            return;
          }
          const approvalBtn = event?.target?.closest?.("[data-pending-approval-decision]");
          if (approvalBtn) {
            event.preventDefault();
            event.stopPropagation();
            resolveApproval({
              id: approvalBtn.getAttribute("data-pending-approval-id"),
              decision: approvalBtn.getAttribute("data-pending-approval-decision"),
            }).catch((e) => setStatus(resolveActionErrorMessage(e), true));
            return;
          }
          const optionBtn = event?.target?.closest?.("[data-pending-answer-key]");
          if (optionBtn) {
            event.preventDefault();
            event.stopPropagation();
            applyPendingUserInputOptionSelection(optionBtn);
            return;
          }
          const submitBtn = event?.target?.closest?.("[data-pending-user-input-submit]");
          if (!submitBtn) return;
          event.preventDefault();
          event.stopPropagation();
          const id = String(submitBtn.getAttribute("data-pending-user-input-submit") || "").trim();
          Promise.resolve().then(() => advanceOrResolvePendingUserInput(id)).catch((e) => setStatus(resolveActionErrorMessage(e), true));
        });
      }
    }
    {
      const chatBox = byId("chatBox");
      if (chatBox && !chatBox.__wiredPendingInlineInputs) {
        chatBox.__wiredPendingInlineInputs = true;
        chatBox.addEventListener("input", (event) => {
          const input = event?.target?.closest?.("[data-pending-freeform-input]");
          if (!input) return;
          setPendingUserInputDraftAnswer(
            input.getAttribute("data-pending-user-input-id"),
            input.getAttribute("data-pending-answer-key"),
            input.value || "",
            { mode: "freeform" }
          );
        });
      }
    }
    bindInput("attachInput", "change", (event) => {
      uploadAttachment(event.target?.files?.[0]).catch((e) =>
        setStatus(resolveActionErrorMessage(e), true)
      );
    });
    bindClick("mobileAttachBtn", () => byId("attachInput")?.click());
    bindResponsiveClick("mobileSendBtn", () => {
      const promptValue = String(byId("mobilePromptInput")?.value || "").trim();
      const running = state.activeThreadPendingTurnRunning === true;
      const hasQueuedTurn = Array.isArray(state.activeThreadQueuedTurns)
        ? state.activeThreadQueuedTurns.some((item) => !!String(item?.prompt || "").trim())
        : !!String(state.activeThreadQueuedTurn?.prompt || "").trim();
      const action = running && promptValue ? steerTurn : sendTurn;
      if (!running && !promptValue && hasQueuedTurn) {
        sendQueuedTurnNow().catch((e) => setStatus(resolveActionErrorMessage(e), true));
        return;
      }
      action().catch((e) => setStatus(resolveActionErrorMessage(e), true));
    });
    bindResponsiveClick("composerActionMenuBtn", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const menu = byId("composerActionMenu");
      const isOpen = !!menu?.classList?.contains("open");
      setComposerActionMenuOpen(!isOpen);
    });
    bindClick("composerMenuFollowUpBtn", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      queueFollowUpTurn()
        .then(() => setComposerActionMenuOpen(false))
        .catch((e) => setStatus(resolveActionErrorMessage(e), true));
    });
    bindClick("composerMenuSendNowBtn", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      sendNowTurn()
        .then(() => setComposerActionMenuOpen(false))
        .catch((e) => setStatus(resolveActionErrorMessage(e), true));
    });
    bindResponsiveClick("queuedTurnToggleBtn", (event) => {
      if (event && String(event.type || "") === "pointerdown") {
        armSyntheticClickSuppression(420);
      }
      state.queuedTurnsExpanded = state.queuedTurnsExpanded === false;
      updateMobileComposerState();
    });
    bindInput("mobilePromptInput", "input", () => {
      updateMobileComposerState();
      maybeRestoreDeferredQueuedTurnEdit();
      syncSlashCommandMenu();
    });
    bindInput("mobilePromptInput", "keyup", (event) => {
      if (String(event?.key || "") === "Escape") return;
      updateMobileComposerState();
      syncSlashCommandMenu();
    });
    bindInput("mobilePromptInput", "change", () => {
      updateMobileComposerState();
      maybeRestoreDeferredQueuedTurnEdit();
      syncSlashCommandMenu();
    });
    bindInput("mobilePromptInput", "focus", () => {
      updateMobileComposerState();
      scrollToBottomReliable();
    });
    bindInput("queuedTurnCard", "input", (event) => {
      const target = event?.target;
      const queuedId = String(target?.dataset?.queuedEditor || "").trim();
      if (!queuedId) return;
      updateQueuedTurnEditingDraft(target?.value || "");
    });
    {
      const queuedCard = byId("queuedTurnCard");
      if (queuedCard && !queuedCard.__wiredQueuedActions) {
        queuedCard.__wiredQueuedActions = true;
        queuedCard.addEventListener("click", (event) => {
          if (shouldSuppressSyntheticClick(event)) return;
          const button = event?.target?.closest?.("[data-queued-action]");
          if (!button) return;
          event?.preventDefault?.();
          event?.stopPropagation?.();
          const action = String(button.dataset?.queuedAction || "").trim();
          const queuedId = String(button.dataset?.queuedId || "").trim();
          if (!queuedId) return;
          const actions = {
            edit: () => editQueuedTurn(queuedId),
            cancel: () => Promise.resolve(cancelQueuedTurnEditing()),
            save: () => {
              const editor = byId("queuedTurnCard")?.querySelector?.(`[data-queued-editor="${queuedId}"]`);
              return Promise.resolve(saveQueuedTurnEdit(queuedId, editor?.value || ""));
            },
            remove: () => Promise.resolve(clearQueuedTurn(queuedId)),
            "send-now": () => sendQueuedTurnNow(queuedId),
          };
          const runner = actions[action];
          if (!runner) return;
          Promise.resolve(runner())
            .then(() => setComposerActionMenuOpen(false))
            .catch((e) => setStatus(resolveActionErrorMessage(e), true));
        });
      }
    }
    bindInput("mobilePromptInput", "keydown", (event) => {
      if (handleSlashCommandKeyDown(event)) return;
      const promptValue = String(byId("mobilePromptInput")?.value || "").trim();
      const canSteer =
        state.activeThreadPendingTurnRunning === true &&
        !!promptValue &&
        !/^\/\S+/.test(promptValue);
      if (canSteer && shouldSteerPromptKey(event)) {
        event.preventDefault();
        steerTurn().catch((e) => setStatus(resolveActionErrorMessage(e), true));
        return;
      }
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
        syncSettingsControlsFromMain();
        setStatus(result?.open === false ? "Updated Plan preview hidden." : "Updated Plan preview shown.");
      } catch (error) {
        setStatus(resolveActionErrorMessage(error, "Failed to preview Updated Plan."), true);
      }
    });
    bindClick("previewPendingBtn", () => {
      try {
        const result = win.__webCodexDebug?.previewPending?.();
        if (result?.ok === false && result?.error) {
          setStatus(String(result.error), true);
          return;
        }
        syncSettingsControlsFromMain();
        setStatus(result?.open === false ? "Pending preview hidden." : "Pending preview shown.");
      } catch (error) {
        setStatus(resolveActionErrorMessage(error, "Failed to preview pending actions."), true);
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
    bindClick("openToolsBtn", () => {
      setMainTab("settings");
      syncSettingsControlsFromMain();
      refreshPending().catch(() => {});
      setMobileTab("chat");
    });
    bindClick("openThreadsBtn", () => {
      setMainTab("chat");
      setMobileTab("threads");
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
    doc.addEventListener("click", (event) => {
      const target = event.target;
      const menu = byId("composerActionMenu");
      const menuBtn = byId("composerActionMenuBtn");
      if (!(target instanceof Node)) return;
      if (menu?.contains(target) || menuBtn?.contains(target)) return;
      setComposerActionMenuOpen(false);
    });
    {
      const pickerBar = byId("composerPickerBar");
      if (pickerBar && !pickerBar.__wiredComposerPickerActions) {
        pickerBar.__wiredComposerPickerActions = true;
        pickerBar.addEventListener("click", (event) => {
          if (shouldSuppressSyntheticClick(event)) return;
          const toggleBtn = event?.target?.closest?.("[data-composer-picker-toggle]");
          if (toggleBtn) {
            event.preventDefault();
            event.stopPropagation();
            const picker = String(toggleBtn.getAttribute("data-composer-picker-toggle") || "").trim();
            if (picker === "branch") {
              state.composerBranchMenuOpen = toggleBtn.disabled ? false : state.composerBranchMenuOpen !== true;
              state.composerPermissionMenuOpen = false;
            } else if (picker === "permission") {
              state.composerPermissionMenuOpen = state.composerPermissionMenuOpen !== true;
              state.composerBranchMenuOpen = false;
            }
            updateMobileComposerState();
            return;
          }
          const branchBtn = event?.target?.closest?.("[data-composer-branch-option]");
          if (branchBtn) {
            event.preventDefault();
            event.stopPropagation();
            const threadId = String(state.activeThreadId || "").trim();
            const branch = String(branchBtn.getAttribute("data-composer-branch-option") || "").trim();
            const workspace = activeComposerWorkspace();
            const cwd = String(state.activeThreadGitMetaCwd || state.startCwdByWorkspace?.[workspace] || "").trim();
            const useCwdSwitch = state.activeThreadGitMetaSource === "cwd" || !threadId;
            if (
              !branch ||
              typeof api !== "function" ||
              (useCwdSwitch && !cwd) ||
              (!useCwdSwitch && !threadId)
            ) {
              return;
            }
            state.activeThreadGitMetaLoading = true;
            updateMobileComposerState();
            const branchSwitch = useCwdSwitch
              ? api("/codex/git/branch", {
                  method: "POST",
                  body: { workspace, cwd, branch },
                })
              : api(`/codex/threads/${encodeURIComponent(threadId)}/branch`, {
                  method: "POST",
                  body: { workspace, branch },
                });
            branchSwitch
              .then((payload) => {
                applyThreadGitMeta(payload);
                state.composerBranchMenuOpen = false;
                updateMobileComposerState();
                setStatus(`Switched to ${branch}`);
              })
              .catch((e) => {
                state.activeThreadGitMetaLoading = false;
                updateMobileComposerState();
                setStatus(resolveActionErrorMessage(e, "Failed to switch branch."), true);
              });
            return;
          }
          const permissionBtn = event?.target?.closest?.("[data-composer-permission-option]");
          if (permissionBtn) {
            event.preventDefault();
            event.stopPropagation();
            const command = String(permissionBtn.getAttribute("data-composer-permission-option") || "").trim();
            if (!command) return;
            executeSlashCommand(command, {
              clearPrompt: false,
              hideMenu: false,
              switchToChat: false,
              refreshThreads: false,
            })
              .then(() => {
                state.composerPermissionMenuOpen = false;
                updateMobileComposerState();
                syncSettingsControlsFromMain();
              })
              .catch((e) => setStatus(resolveActionErrorMessage(e), true));
          }
        });
      }
    }
    doc.addEventListener("click", (event) => {
      const target = event.target;
      const pickerBar = byId("composerPickerBar");
      if (!(target instanceof Node)) return;
      if (pickerBar?.contains(target)) return;
      closeComposerPickerMenus();
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
