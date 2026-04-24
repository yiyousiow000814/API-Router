import { applyActiveThreadGitMetaState, activeComposerWorkspace } from "./threadGitMetaState.js";
import { resolveBranchPickerSelection } from "./branchPickerState.js";
import { resolveCurrentThreadId } from "./runtimeState.js";

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
    addChat,
    removeChatMessageByKey = () => false,
    clearThreadStatusCard = () => {},
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

  let pendingBlockedBranchSwitch = null;

  function normalizeSettingsSection(section) {
    const value = String(section || "").trim().toLowerCase();
    return ["provider", "chat", "system", "alerts", "debug"].includes(value) ? value : "provider";
  }

  function syncSettingsSectionVisibility() {
    const active = normalizeSettingsSection(state.settingsActiveSection);
    state.settingsActiveSection = active;
    doc?.querySelectorAll?.("[data-settings-section]").forEach((btn) => {
      const selected = String(btn.getAttribute("data-settings-section") || "") === active;
      btn.classList.toggle("is-active", selected);
      btn.setAttribute("aria-selected", selected ? "true" : "false");
    });
    doc?.querySelectorAll?.("[data-settings-pane]").forEach((pane) => {
      const selected = String(pane.getAttribute("data-settings-pane") || "") === active;
      pane.classList.toggle("is-active", selected);
      pane.setAttribute("aria-hidden", selected ? "false" : "true");
    });
  }

  function refreshSettingsProviderSwitchboardIfNeeded() {
    if (state.activeMainTab !== "settings") return;
    if (state.settingsActiveSection !== "provider") return;
    if (state.providerSwitchboardLoading || state.providerSwitchboardBusy) return;
    if (state.providerSwitchboardStatus && !state.providerSwitchboardError) return;
    refreshProviderSwitchboard();
  }

  function notificationPermission(fallback = "") {
    return String(NotificationApi?.permission || win?.Notification?.permission || fallback || "").trim();
  }

  function notificationsSupported() {
    return !!NotificationApi || "Notification" in win;
  }

  function showTestNotification() {
    if (notificationPermission() !== "granted" || typeof NotificationApi !== "function") return false;
    try {
      const notification = new NotificationApi("API Router notifications enabled", {
        body: "Web Codex notifications are working.",
        tag: "api-router-web-codex-test",
      });
      scheduleTimeout(() => notification?.close?.(), 4000);
      return true;
    } catch {
      return false;
    }
  }

  function setSettingsSection(section) {
    state.settingsActiveSection = normalizeSettingsSection(section);
    syncSettingsSectionVisibility();
    refreshSettingsProviderSwitchboardIfNeeded();
  }

  function normalizeProviderSwitchboardPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    const providerDetails = Array.isArray(payload.provider_details)
      ? payload.provider_details
          .map((item) => ({
            ...(item && typeof item === "object" ? item : {}),
            name: String(item?.name || "").trim(),
            display_name: String(item?.display_name || item?.name || "").trim(),
            base_url: String(item?.base_url || "").trim(),
            has_key: item?.has_key === true,
            disabled: item?.disabled === true,
            quota: item?.quota && typeof item.quota === "object" ? item.quota : null,
          }))
          .filter((item) => item.name)
      : [];
    const officialProfiles = Array.isArray(payload.official_profiles)
      ? payload.official_profiles
          .map((item, index) => ({
            ...(item && typeof item === "object" ? item : {}),
            id: String(item?.id || item?.email || item?.label || `official-${index + 1}`).trim(),
            label: String(item?.label || "").trim(),
            email: String(item?.email || "").trim(),
            plan_label: String(item?.plan_label || "").trim(),
            active: item?.active === true,
          }))
          .filter((item) => item.id)
      : [];
    const runtimeRefresh = Array.isArray(payload.runtime_refresh)
      ? payload.runtime_refresh
          .map((item) => ({
            ...(item && typeof item === "object" ? item : {}),
            home: String(item?.home || "").trim(),
            status: String(item?.status || "").trim(),
            deferred: item?.deferred === true,
            running_threads: Number.isFinite(Number(item?.running_threads))
              ? Number(item.running_threads)
              : 0,
            error: String(item?.error || "").trim(),
          }))
          .filter((item) => item.home)
      : [];
    return {
      ...payload,
      mode: String(payload.mode || "").trim(),
      model_provider: payload.model_provider == null ? "" : String(payload.model_provider || "").trim(),
      provider_options: Array.isArray(payload.provider_options)
        ? payload.provider_options.map((name) => String(name || "").trim()).filter(Boolean)
        : [],
      provider_details: providerDetails,
      dirs: Array.isArray(payload.dirs)
        ? payload.dirs.map((item) => (item && typeof item === "object" ? item : {}))
        : [],
      scope: normalizeProviderSwitchboardScope(payload.scope || state.providerSwitchboardScope || "windows"),
      official_profiles: officialProfiles,
      runtime_refresh: runtimeRefresh,
    };
  }

  function normalizeProviderSwitchboardScope(scope) {
    const value = String(scope || "").trim().toLowerCase();
    return value === "wsl2" ? "wsl2" : "windows";
  }

  function activeOfficialProfileId(status = state.providerSwitchboardStatus) {
    const profiles = Array.isArray(status?.official_profiles) ? status.official_profiles : [];
    const active = profiles.find((profile) => profile?.active === true) || profiles[0] || null;
    return String(active?.id || "").trim();
  }

  function officialProfileLabel(profileId, status = state.providerSwitchboardStatus) {
    const id = String(profileId || "").trim();
    const profiles = Array.isArray(status?.official_profiles) ? status.official_profiles : [];
    const profile = profiles.find((item) => String(item?.id || "").trim() === id) || profiles.find((item) => item?.active === true) || null;
    const email = String(profile?.email || "").trim();
    const label = String(profile?.label || "").trim();
    return email || label || "Official";
  }

  function currentProviderSwitchboardSelection(status = state.providerSwitchboardStatus) {
    const mode = String(status?.mode || "").trim().toLowerCase();
    const target = mode === "official" || mode === "provider" || mode === "gateway" ? mode : "gateway";
    return {
      target,
      provider: target === "provider" ? String(status?.model_provider || "").trim() : "",
      officialProfileId: target === "official" ? activeOfficialProfileId(status) : "",
    };
  }

  function providerSwitchboardSelectionsMatch(left, right) {
    const leftTarget = String(left?.target || "").trim().toLowerCase();
    const rightTarget = String(right?.target || "").trim().toLowerCase();
    if (leftTarget !== rightTarget) return false;
    if (leftTarget === "provider") {
      return String(left?.provider || "").trim() === String(right?.provider || "").trim();
    }
    if (leftTarget === "official") {
      return String(left?.officialProfileId || "").trim() === String(right?.officialProfileId || "").trim();
    }
    return true;
  }

  function ensureProviderSwitchboardDraft(status = state.providerSwitchboardStatus) {
    if (!status) return;
    if (state.providerSwitchboardDraftTarget) return;
    const mode = String(status.mode || "").trim().toLowerCase();
    state.providerSwitchboardDraftTarget =
      mode === "official" || mode === "provider" || mode === "gateway" ? mode : "gateway";
    state.providerSwitchboardDraftProvider =
      state.providerSwitchboardDraftTarget === "provider"
        ? String(status.model_provider || "").trim()
        : "";
    state.providerSwitchboardDraftOfficialProfileId =
      state.providerSwitchboardDraftTarget === "official" ? activeOfficialProfileId(status) : "";
  }

  async function refreshProviderSwitchboard() {
    if (typeof api !== "function") return null;
    state.providerSwitchboardLoading = true;
    state.providerSwitchboardError = "";
    syncSettingsControlsFromMain();
    try {
      const scope = normalizeProviderSwitchboardScope(state.providerSwitchboardScope);
      state.providerSwitchboardScope = scope;
      const payload = await api(`/codex/provider-switchboard?scope=${encodeURIComponent(scope)}`);
      state.providerSwitchboardStatus = normalizeProviderSwitchboardPayload(payload);
      ensureProviderSwitchboardDraft(state.providerSwitchboardStatus);
      return state.providerSwitchboardStatus;
    } catch (error) {
      state.providerSwitchboardError = resolveActionErrorMessage(
        error,
        "Failed to load provider switchboard."
      );
      return null;
    } finally {
      state.providerSwitchboardLoading = false;
      syncSettingsControlsFromMain();
    }
  }

  function setProviderSwitchboardDraft(target, provider = "", officialProfileId = "") {
    const normalizedTarget = String(target || "").trim().toLowerCase();
    const nextTarget =
      normalizedTarget === "official" || normalizedTarget === "provider" ? normalizedTarget : "gateway";
    const nextSelection = {
      target: nextTarget,
      provider: nextTarget === "provider" ? String(provider || "").trim() : "",
      officialProfileId:
        nextTarget === "official" ? String(officialProfileId || activeOfficialProfileId()).trim() : "",
    };
    const currentSelection = currentProviderSwitchboardSelection();
    state.providerSwitchboardError = "";
    state.providerSwitchboardConfirm = providerSwitchboardSelectionsMatch(currentSelection, nextSelection)
      ? null
      : {
          ...nextSelection,
          scope: normalizeProviderSwitchboardScope(state.providerSwitchboardScope),
        };
    syncSettingsControlsFromMain();
  }

  async function setProviderSwitchboardScope(scope) {
    state.providerSwitchboardScope = normalizeProviderSwitchboardScope(scope);
    state.providerSwitchboardDraftTarget = "";
    state.providerSwitchboardDraftProvider = "";
    state.providerSwitchboardDraftOfficialProfileId = "";
    syncSettingsControlsFromMain();
    await refreshProviderSwitchboard();
  }

  function closeProviderSwitchboardConfirm() {
    state.providerSwitchboardConfirm = null;
    syncSettingsControlsFromMain();
  }

  async function applyProviderSwitchboardDraft() {
    if (typeof api !== "function") return;
    const pending = state.providerSwitchboardConfirm || {};
    const target = String(pending.target || state.providerSwitchboardDraftTarget || "gateway").trim().toLowerCase();
    const provider = String(pending.provider || state.providerSwitchboardDraftProvider || "").trim();
    const officialProfileId = String(pending.officialProfileId || state.providerSwitchboardDraftOfficialProfileId || "").trim();
    if (target === "provider" && !provider) {
      const message = "Select a direct provider before Apply.";
      state.providerSwitchboardError = message;
      syncSettingsControlsFromMain();
      setStatus(message, true);
      return;
    }
    if (target === "official" && !officialProfileId) {
      const message = "Select an official account before Apply.";
      state.providerSwitchboardError = message;
      syncSettingsControlsFromMain();
      setStatus(message, true);
      return;
    }
    state.providerSwitchboardBusy = true;
    state.providerSwitchboardError = "";
    syncSettingsControlsFromMain();
    try {
      const body = {
        target,
        scope: normalizeProviderSwitchboardScope(pending.scope || state.providerSwitchboardScope),
      };
      if (provider) body.provider = provider;
      if (target === "official") body.officialProfileId = officialProfileId;
      const payload = await api("/codex/provider-switchboard", {
        method: "POST",
        body,
      });
      state.providerSwitchboardStatus = normalizeProviderSwitchboardPayload(payload);
      state.providerSwitchboardDraftTarget = target;
      state.providerSwitchboardDraftProvider = target === "provider" ? provider : "";
      state.providerSwitchboardDraftOfficialProfileId = target === "official" ? officialProfileId : "";
      state.providerSwitchboardConfirm = null;
      const label =
        target === "provider" && provider
          ? provider
          : target === "gateway"
            ? "Gateway"
            : officialProfileLabel(officialProfileId);
      const runtimeRefresh = Array.isArray(state.providerSwitchboardStatus?.runtime_refresh)
        ? state.providerSwitchboardStatus.runtime_refresh
        : [];
      const hasDeferredRefresh = runtimeRefresh.some((item) => item?.deferred === true);
      const hasRefreshError = runtimeRefresh.some((item) => String(item?.status || "") === "error");
      const workspaceLabel = body.scope === "wsl2" ? "WSL2" : "Windows";
      if (hasDeferredRefresh) {
        setStatus(`Web Codex ${workspaceLabel} provider will apply after the current turn finishes: ${label}.`);
      } else if (hasRefreshError) {
        setStatus(`Web Codex ${workspaceLabel} provider saved, but runtime refresh failed.`, true);
      } else {
        setStatus(`Web Codex ${workspaceLabel} provider applied: ${label}. Future messages will use it.`);
      }
    } catch (error) {
      const message = resolveActionErrorMessage(error, "Failed to switch provider.");
      state.providerSwitchboardError = message;
      setStatus(message, true);
    } finally {
      state.providerSwitchboardBusy = false;
      syncSettingsControlsFromMain();
    }
  }

  function setProviderSwitchboardProvidersModalOpen(open) {
    state.providerSwitchboardProvidersModalOpen = open === true;
    syncSettingsControlsFromMain();
  }

  async function setProviderEnabled(provider, enabled) {
    if (typeof api !== "function") return;
    state.providerSwitchboardBusy = true;
    state.providerSwitchboardError = "";
    syncSettingsControlsFromMain();
    try {
      const payload = await api("/codex/provider-switchboard/provider-enabled", {
        method: "POST",
        body: { provider, enabled },
      });
      state.providerSwitchboardStatus = normalizeProviderSwitchboardPayload(payload);
      setStatus(`${provider} ${enabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      const message = resolveActionErrorMessage(error, "Failed to update provider.");
      state.providerSwitchboardError = message;
      setStatus(message, true);
    } finally {
      state.providerSwitchboardBusy = false;
      syncSettingsControlsFromMain();
    }
  }

  function showBranchSwitchBlockedDialog(uncommittedFileCount, branch) {
    pendingBlockedBranchSwitch = branch;
    const backdrop = byId("branchSwitchBlockedBackdrop");
    const fileCountSpan = byId("branchSwitchBlockedFileCount");
    if (!backdrop) return;
    if (fileCountSpan) fileCountSpan.textContent = String(uncommittedFileCount || 0);
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function hideBranchSwitchBlockedDialog() {
    pendingBlockedBranchSwitch = null;
    const backdrop = byId("branchSwitchBlockedBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
  }

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
    if (state.composerBranchMenuOpen !== true && state.composerPermissionMenuOpen !== true) {
      return false;
    }
    state.composerBranchMenuOpen = false;
    state.composerPermissionMenuOpen = false;
    updateMobileComposerState();
    return true;
  }

  function isComposerPickerInteractiveTarget(target) {
    return !!(
      target?.closest?.("[data-composer-picker-toggle]") ||
      target?.closest?.("[data-composer-branch-option]") ||
      target?.closest?.("[data-composer-permission-option]")
    );
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
      const running = state.activeThreadPendingTurnRunning === true && !!resolveCurrentThreadId(state);
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
        !!resolveCurrentThreadId(state) &&
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
      if (!notificationsSupported()) {
        setStatus("Notifications are not supported.", true);
        return;
      }
      let permission = notificationPermission();
      try {
        if (permission !== "granted") {
          if (typeof NotificationApi?.requestPermission !== "function") {
            setStatus("Notifications cannot be requested in this browser.", true);
            updateNotificationState();
            return;
          }
          permission = notificationPermission(await NotificationApi.requestPermission());
        }
      } catch (error) {
        setStatus(resolveActionErrorMessage(error, "Failed to request notifications."), true);
        updateNotificationState();
        return;
      }
      updateNotificationState();
      if (permission === "granted") {
        setStatus(
          showTestNotification()
            ? "Sent a test notification."
            : "Notifications are enabled."
        );
        return;
      }
      if (permission === "denied") {
        setStatus("Notifications are blocked in this browser.", true);
        return;
      }
      setStatus("Notification permission was not changed.", true);
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
    let errorDemoRunId = 0;
    bindClick("testErrorBtn", () => {
      const btn = byId("testErrorBtn");
      const runId = errorDemoRunId + 1;
      errorDemoRunId = runId;
      const demoKey = "error-demo-sequence";
      const finishDemo = (statusMessage) => {
        if (runId !== errorDemoRunId) return;
        if (btn) {
          btn.textContent = "Replay error demo";
          btn.disabled = false;
          btn.classList?.remove?.("is-replaying");
        }
        setStatus(statusMessage || "Error demo completed.", false);
      };

      if (btn) {
        btn.textContent = "Replaying...";
        btn.disabled = true;
        btn.classList?.add?.("is-replaying");
      }

      setMainTab("chat");
      removeChatMessageByKey(demoKey);

      const scenarios = [
        "stream disconnected before completion: response closed early",
        "No routable providers available for this request.",
        "Live updates disconnected after 5 retries.",
        "Turn failed: unknown variant `invalid_request_error`",
      ];
      const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
      const maxRetries = 5;

      let attempt = 0;
      scheduleTimeout(function showReconnect() {
        if (runId !== errorDemoRunId) return;
        attempt += 1;
        if (attempt <= maxRetries) {
          addChat("system", `Reconnecting... ${attempt}/${maxRetries}`, {
            kind: "thinking",
            transient: false,
            animate: true,
            messageKey: demoKey,
          });
          if (attempt < maxRetries) {
            scheduleTimeout(showReconnect, 800);
          } else {
            scheduleTimeout(() => {
              if (runId !== errorDemoRunId) return;
              removeChatMessageByKey(demoKey);
              addChat("system", `[TEST] ${scenario}`, {
                kind: "error",
                animate: true,
                messageKey: demoKey,
              });
              finishDemo("Error demo completed.");
            }, 800);
          }
        }
      }, 100);
    });
    bindClick("statusTrayCloseBtn", () => {
      clearThreadStatusCard();
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
    bindClick("settingsProviderGatewayBtn", () => setProviderSwitchboardDraft("gateway"));
    bindClick("settingsProviderConfirmApplyBtn", () => applyProviderSwitchboardDraft());
    bindClick("settingsProviderConfirmCancelBtn", () => closeProviderSwitchboardConfirm());
    bindClick("settingsProviderManageBtn", () => setProviderSwitchboardProvidersModalOpen(true));
    bindClick("settingsProviderManagerCloseBtn", () => setProviderSwitchboardProvidersModalOpen(false));
    bindClick("settingsProviderScopeWindowsBtn", () => setProviderSwitchboardScope("windows"));
    bindClick("settingsProviderScopeWslBtn", () => setProviderSwitchboardScope("wsl2"));
    doc?.querySelectorAll?.("[data-settings-section]").forEach((btn) => {
      if (btn.__settingsSectionClickBound) return;
      btn.__settingsSectionClickBound = true;
      btn.addEventListener("click", () => {
        setSettingsSection(btn.getAttribute("data-settings-section"));
      });
    });
    const settingsProviderList = byId("settingsProviderList");
    if (settingsProviderList && !settingsProviderList.__providerSwitchboardClickBound) {
      settingsProviderList.__providerSwitchboardClickBound = true;
      settingsProviderList.addEventListener("click", (event) => {
        const btn = event.target?.closest?.("[data-provider-target='provider']");
        if (!btn) return;
        const provider = String(btn.getAttribute("data-provider-name") || "").trim();
        if (!provider) return;
        setProviderSwitchboardDraft("provider", provider);
      });
    }
    const settingsOfficialProfileList = byId("settingsOfficialProfileList");
    if (settingsOfficialProfileList && !settingsOfficialProfileList.__officialProfileClickBound) {
      settingsOfficialProfileList.__officialProfileClickBound = true;
      settingsOfficialProfileList.addEventListener("click", (event) => {
        const btn = event.target?.closest?.("[data-official-profile-id]");
        if (!btn) return;
        const profileId = String(btn.getAttribute("data-official-profile-id") || "").trim();
        if (!profileId) return;
        setProviderSwitchboardDraft("official", "", profileId);
      });
    }
    const settingsProviderManagerList = byId("settingsProviderManagerList");
    if (settingsProviderManagerList && !settingsProviderManagerList.__providerManagerClickBound) {
      settingsProviderManagerList.__providerManagerClickBound = true;
      settingsProviderManagerList.addEventListener("click", (event) => {
        const btn = event.target?.closest?.("[data-provider-enabled-toggle]");
        if (!btn) return;
        const provider = String(btn.getAttribute("data-provider-name") || "").trim();
        if (!provider) return;
        const enabled = btn.getAttribute("data-provider-enabled-toggle") === "true";
        setProviderEnabled(provider, enabled);
      });
    }
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
    bindClick("branchSwitchBlockedCancelBtn", () => hideBranchSwitchBlockedDialog());
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
      syncSettingsSectionVisibility();
      syncSettingsControlsFromMain();
      refreshSettingsProviderSwitchboardIfNeeded();
      refreshCodexVersions().catch(() => {});
      setMobileTab("chat");
    });
    bindClick("openToolsBtn", () => {
      setMainTab("settings");
      setSettingsSection("debug");
      syncSettingsControlsFromMain();
      refreshProviderSwitchboard();
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
          const target = event?.target;
          if (!isComposerPickerInteractiveTarget(target)) {
            closeComposerPickerMenus();
            return;
          }
          const toggleBtn = event?.target?.closest?.("[data-composer-picker-toggle]");
          if (toggleBtn) {
            event.preventDefault();
            event.stopPropagation();
            const picker = String(toggleBtn.getAttribute("data-composer-picker-toggle") || "").trim();
            if (picker === "branch") {
              const wantsOpen = toggleBtn.disabled ? false : state.composerBranchMenuOpen !== true;
              state.composerPermissionMenuOpen = false;
              state.composerBranchMenuOpen = wantsOpen;
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
            const threadId = resolveCurrentThreadId(state);
            const branch = String(branchBtn.getAttribute("data-composer-branch-option") || "").trim();
            const selection = resolveBranchPickerSelection(state, branch);
            if (selection.action === "ignore") return;
            if (selection.action !== "switch") {
              state.composerBranchMenuOpen = false;
              updateMobileComposerState();
              if (selection.action === "blocked") {
                showBranchSwitchBlockedDialog(selection.uncommittedFileCount, branch);
              }
              return;
            }
            const workspace = activeComposerWorkspace(state);
            const cwd = String(state.activeThreadGitMetaCwd || state.startCwdByWorkspace?.[workspace] || "").trim();
            const useCwdSwitch = state.activeThreadGitMetaSource === "cwd" || !threadId;
            if (
              typeof api !== "function" ||
              (useCwdSwitch && !cwd) ||
              (!useCwdSwitch && !threadId)
            ) {
              return;
            }
            const reqSeq = (Number(state.activeThreadGitMetaReqSeq || 0) || 0) + 1;
            state.activeThreadGitMetaReqSeq = reqSeq;
            state.composerBranchMenuOpen = false;
            state.activeThreadGitMetaLoading = true;
            updateMobileComposerState();
            const branchSwitch = useCwdSwitch
              ? api("/codex/git/branch", {
                  method: "POST",
                  body: { workspace, cwd, branch: selection.branch },
                })
              : api(`/codex/threads/${encodeURIComponent(threadId)}/branch`, {
                  method: "POST",
                  body: { workspace, branch: selection.branch },
                });
            branchSwitch
              .then((payload) => {
                if (state.activeThreadGitMetaReqSeq !== reqSeq) return;
                applyThreadGitMeta(payload);
                updateMobileComposerState();
                setStatus(`Switched to ${selection.branch}`);
              })
              .catch((e) => {
                if (state.activeThreadGitMetaReqSeq !== reqSeq) return;
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
      if (pickerBar?.contains(target) && isComposerPickerInteractiveTarget(target)) return;
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

  return { wireActions, refreshProviderSwitchboard };
}
