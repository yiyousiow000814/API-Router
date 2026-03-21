import { describe, expect, it } from "vitest";

import {
  createActionBindingsModule,
  resolveActionErrorMessage,
  shouldSteerPromptKey,
  shouldSubmitPromptKey,
} from "./actionBindings.js";

describe("actionBindings", () => {
  it("submits only plain enter presses", () => {
    expect(shouldSubmitPromptKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(
      true
    );
    expect(shouldSubmitPromptKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(
      false
    );
    expect(shouldSubmitPromptKey({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });

  it("steers only on plain tab presses", () => {
    expect(shouldSteerPromptKey({ key: "Tab", shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSteerPromptKey({ key: "Tab", shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSteerPromptKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(false);
  });

  it("normalizes action error messages", () => {
    expect(resolveActionErrorMessage(new Error("boom"))).toBe("boom");
    expect(resolveActionErrorMessage(null, "fallback")).toBe("fallback");
  });

  it("toggles live inspector from settings and persists the preference", async () => {
    const handlers = new Map();
    const localStorageCalls = [];
    const windowRef = {
      addEventListener() {},
      __webCodexDebug: {
        toggleLiveInspector(force) {
          windowRef.__forced = force;
          return { ok: true, open: !!force };
        },
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId() { return null; },
      bindClick(id, handler) {
        handlers.set(id, handler);
      },
      bindResponsiveClick() {},
      bindInput() {},
      setStatus() {},
      updateMobileComposerState() {},
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      sendTurn: async () => {},
      syncSettingsControlsFromMain() {
        deps.__synced = true;
      },
      LIVE_INSPECTOR_ENABLED_KEY: "web_codex_live_inspector_enabled_v1",
      localStorageRef: {
        getItem() { return ""; },
        setItem(key, value) {
          localStorageCalls.push({ key, value });
        },
      },
      windowRef,
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNotification = globalThis.Notification;
    globalThis.document = { addEventListener() {} };
    globalThis.window = windowRef;
    globalThis.Notification = deps.NotificationRef;

    try {
      createActionBindingsModule(deps).wireActions();
      await handlers.get("toggleLiveInspectorBtn")();

      expect(windowRef.__forced).toBe(true);
      expect(localStorageCalls).toEqual([
        { key: "web_codex_live_inspector_enabled_v1", value: "1" },
      ]);
      expect(deps.__synced).toBe(true);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("toggles Updated Plan preview from settings", async () => {
    const handlers = new Map();
    const statusCalls = [];
    let open = false;
    const windowRef = {
      addEventListener() {},
      __webCodexDebug: {
        previewUpdatedPlan() {
          open = !open;
          windowRef.__previewed = open;
          return { ok: true, open };
        },
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId() { return null; },
      bindClick(id, handler) {
        handlers.set(id, handler);
      },
      bindResponsiveClick() {},
      bindInput() {},
      setStatus(message, isError = false) {
        statusCalls.push({ message, isError });
      },
      updateMobileComposerState() {},
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      sendTurn: async () => {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef,
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNotification = globalThis.Notification;
    globalThis.document = { addEventListener() {} };
    globalThis.window = windowRef;
    globalThis.Notification = deps.NotificationRef;

    try {
      createActionBindingsModule(deps).wireActions();
      await handlers.get("previewUpdatedPlanBtn")();
      await handlers.get("previewUpdatedPlanBtn")();

      expect(windowRef.__previewed).toBe(false);
      expect(statusCalls).toEqual([
        { message: "Updated Plan preview shown.", isError: false },
        { message: "Updated Plan preview hidden.", isError: false },
      ]);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("opens a managed terminal from the header workspace badge", async () => {
    const handlers = new Map();
    const statusCalls = [];
    let opened = 0;
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId() { return null; },
      bindClick(id, handler) {
        handlers.set(id, handler);
      },
      bindResponsiveClick() {},
      bindInput() {},
      setStatus(message, isError = false) {
        statusCalls.push({ message, isError });
      },
      updateMobileComposerState() {},
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      openManagedTerminalSurface: async () => {
        opened += 1;
      },
      sendTurn: async () => {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNotification = globalThis.Notification;
    globalThis.document = { addEventListener() {} };
    globalThis.window = deps.windowRef;
    globalThis.Notification = deps.NotificationRef;

    try {
      createActionBindingsModule(deps).wireActions();
      await handlers.get("headerWorkspaceBadge")?.();

      expect(opened).toBe(1);
      expect(statusCalls).toEqual([]);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("updates real default toggles from settings without changing the prompt", async () => {
    const handlers = new Map();
    const statusCalls = [];
    const slashCalls = [];
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId() { return null; },
      bindClick(id, handler) {
        handlers.set(id, handler);
      },
      bindResponsiveClick() {},
      bindInput() {},
      setStatus(message, isError = false) {
        statusCalls.push({ message, isError });
      },
      updateMobileComposerState() {},
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      executeSlashCommand: async (command, options) => {
        slashCalls.push({ command, options });
      },
      sendTurn: async () => {},
      syncSettingsControlsFromMain() {
        deps.__synced = (deps.__synced || 0) + 1;
      },
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNotification = globalThis.Notification;
    globalThis.document = { addEventListener() {} };
    globalThis.window = deps.windowRef;
    globalThis.Notification = deps.NotificationRef;

    try {
      createActionBindingsModule(deps).wireActions();
      await handlers.get("settingsFullAccessOnBtn")();
      await handlers.get("settingsFastOffBtn")();

      expect(slashCalls).toEqual([
        {
          command: "/permission full-access",
          options: {
            clearPrompt: false,
            hideMenu: false,
            switchToChat: false,
            refreshThreads: false,
            setStatus: false,
          },
        },
        {
          command: "/fast off",
          options: {
            clearPrompt: false,
            hideMenu: false,
            switchToChat: false,
            refreshThreads: false,
            setStatus: false,
          },
        },
      ]);
      expect(deps.__synced).toBe(2);
      expect(statusCalls).toEqual([
        { message: "Full access enabled for this Web chat.", isError: false },
        { message: "Fast mode disabled for this Web chat.", isError: false },
      ]);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("wires send and queued composer actions through responsive clicks", () => {
    const clickHandlers = new Map();
    const responsiveHandlers = new Map();
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId() { return null; },
      bindClick(id, handler) {
        clickHandlers.set(id, handler);
      },
      bindResponsiveClick(id, handler) {
        responsiveHandlers.set(id, handler);
      },
      bindInput() {},
      setStatus() {},
      updateMobileComposerState() {},
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      executeSlashCommand: async () => {},
      cancelQueuedTurnEditing() {},
      clearQueuedTurn() {},
      editQueuedTurn: async () => false,
      queueFollowUpTurn: async () => {},
      saveQueuedTurnEdit() {},
      sendNowTurn: async () => {},
      sendQueuedTurnNow: async () => {},
      sendTurn: async () => {},
      steerTurn: async () => {},
      setComposerActionMenuOpen() {},
      syncSlashCommandMenu() {},
      handleSlashCommandKeyDown() { return false; },
      syncSettingsControlsFromMain() {},
      updateQueuedTurnEditingDraft() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNotification = globalThis.Notification;
    globalThis.document = { addEventListener() {} };
    globalThis.window = deps.windowRef;
    globalThis.Notification = deps.NotificationRef;

    try {
      createActionBindingsModule(deps).wireActions();
      expect(responsiveHandlers.has("mobileSendBtn")).toBe(true);
      expect(clickHandlers.has("composerMenuFollowUpBtn")).toBe(true);
      expect(clickHandlers.has("composerMenuSendNowBtn")).toBe(true);
      expect(responsiveHandlers.has("queuedTurnToggleBtn")).toBe(true);
      expect(clickHandlers.has("mobileSendBtn")).toBe(false);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("arms suppression when queued toggle opens on pointerdown", () => {
    const responsiveHandlers = new Map();
    const suppressCalls = [];
    const deps = {
      state: { queuedTurnsExpanded: true, folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId() { return null; },
      bindClick() {},
      bindResponsiveClick(id, handler) {
        responsiveHandlers.set(id, handler);
      },
      bindInput() {},
      setStatus() {},
      updateMobileComposerState() {
        deps.__updated = true;
      },
      updateNotificationState() {},
      armSyntheticClickSuppression(ms) {
        suppressCalls.push(ms);
      },
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      executeSlashCommand: async () => {},
      cancelQueuedTurnEditing() {},
      clearQueuedTurn() {},
      editQueuedTurn: async () => false,
      queueFollowUpTurn: async () => {},
      saveQueuedTurnEdit() {},
      sendNowTurn: async () => {},
      sendQueuedTurnNow: async () => {},
      sendTurn: async () => {},
      steerTurn: async () => {},
      setComposerActionMenuOpen() {},
      syncSlashCommandMenu() {},
      handleSlashCommandKeyDown() { return false; },
      syncSettingsControlsFromMain() {},
      updateQueuedTurnEditingDraft() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNotification = globalThis.Notification;
    globalThis.document = { addEventListener() {} };
    globalThis.window = deps.windowRef;
    globalThis.Notification = deps.NotificationRef;

    try {
      createActionBindingsModule(deps).wireActions();
      responsiveHandlers.get("queuedTurnToggleBtn")({
        type: "pointerdown",
        preventDefault() {},
        stopPropagation() {},
      });
      expect(suppressCalls).toEqual([420]);
      expect(deps.state.queuedTurnsExpanded).toBe(false);
      expect(deps.__updated).toBe(true);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("routes delegated queued item actions by queued id", async () => {
    const responsiveHandlers = new Map();
    const inputHandlers = new Map();
    const calls = [];
    const queuedCard = {
      addEventListener(eventName, handler) {
        responsiveHandlers.set(`queuedTurnCard:${eventName}`, handler);
      },
      querySelector(selector) {
        if (selector === '[data-queued-editor="queued-1"]') {
          return { value: "edited queued prompt" };
        }
        return null;
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        return id === "queuedTurnCard" ? queuedCard : null;
      },
      bindClick() {},
      bindResponsiveClick(id, handler) { responsiveHandlers.set(id, handler); },
      bindInput(id, eventName, handler) {
        inputHandlers.set(`${id}:${eventName}`, handler);
      },
      setStatus() {},
      updateMobileComposerState() {},
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      executeSlashCommand: async () => {},
      cancelQueuedTurnEditing() { calls.push("cancel"); },
      clearQueuedTurn(id) { calls.push(`remove:${id}`); },
      editQueuedTurn: async (id) => { calls.push(`edit:${id}`); },
      maybeRestoreDeferredQueuedTurnEdit() {},
      queueFollowUpTurn: async () => {},
      saveQueuedTurnEdit(id, value) { calls.push(`save:${id}:${value}`); },
      sendNowTurn: async () => {},
      sendQueuedTurnNow: async (id) => { calls.push(`send-now:${id}`); },
      sendTurn: async () => {},
      steerTurn: async () => {},
      setComposerActionMenuOpen() {},
      syncSlashCommandMenu() {},
      handleSlashCommandKeyDown() { return false; },
      syncSettingsControlsFromMain() {},
      updateQueuedTurnEditingDraft(value) { calls.push(`draft:${value}`); },
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNotification = globalThis.Notification;
    globalThis.document = { addEventListener() {} };
    globalThis.window = deps.windowRef;
    globalThis.Notification = deps.NotificationRef;

    try {
      createActionBindingsModule(deps).wireActions();
      inputHandlers.get("queuedTurnCard:input")({
        target: { dataset: { queuedEditor: "queued-1" }, value: "draft value" },
      });
      await responsiveHandlers.get("queuedTurnCard:click")({
        preventDefault() {},
        stopPropagation() {},
        target: { closest() { return { dataset: { queuedAction: "edit", queuedId: "queued-1" } }; } },
      });
      await responsiveHandlers.get("queuedTurnCard:click")({
        preventDefault() {},
        stopPropagation() {},
        target: { closest() { return { dataset: { queuedAction: "save", queuedId: "queued-1" } }; } },
      });
      await responsiveHandlers.get("queuedTurnCard:click")({
        preventDefault() {},
        stopPropagation() {},
        target: { closest() { return { dataset: { queuedAction: "send-now", queuedId: "queued-2" } }; } },
      });
      await responsiveHandlers.get("queuedTurnCard:click")({
        preventDefault() {},
        stopPropagation() {},
        target: { closest() { return { dataset: { queuedAction: "remove", queuedId: "queued-3" } }; } },
      });

      expect(calls).toEqual([
        "draft:draft value",
        "edit:queued-1",
        "save:queued-1:edited queued prompt",
        "send-now:queued-2",
        "remove:queued-3",
      ]);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("drops queued action clicks when they are synthetic after expand", async () => {
    const responsiveHandlers = new Map();
    const queuedCard = {
      addEventListener(eventName, handler) {
        responsiveHandlers.set(`queuedTurnCard:${eventName}`, handler);
      },
      querySelector() {
        return null;
      },
    };
    const calls = [];
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        return id === "queuedTurnCard" ? queuedCard : null;
      },
      bindClick() {},
      bindResponsiveClick(id, handler) { responsiveHandlers.set(id, handler); },
      bindInput() {},
      setStatus() {},
      updateMobileComposerState() {},
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return true; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      executeSlashCommand: async () => {},
      cancelQueuedTurnEditing() { calls.push("cancel"); },
      clearQueuedTurn(id) { calls.push(`remove:${id}`); },
      editQueuedTurn: async (id) => { calls.push(`edit:${id}`); },
      maybeRestoreDeferredQueuedTurnEdit() {},
      queueFollowUpTurn: async () => {},
      saveQueuedTurnEdit(id, value) { calls.push(`save:${id}:${value}`); },
      sendNowTurn: async () => {},
      sendQueuedTurnNow: async (id) => { calls.push(`send-now:${id}`); },
      sendTurn: async () => {},
      steerTurn: async () => {},
      setComposerActionMenuOpen() {},
      syncSlashCommandMenu() {},
      handleSlashCommandKeyDown() { return false; },
      syncSettingsControlsFromMain() {},
      updateQueuedTurnEditingDraft() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNotification = globalThis.Notification;
    globalThis.document = { addEventListener() {} };
    globalThis.window = deps.windowRef;
    globalThis.Notification = deps.NotificationRef;

    try {
      createActionBindingsModule(deps).wireActions();
      await responsiveHandlers.get("queuedTurnCard:click")({
        type: "click",
        preventDefault() {},
        stopPropagation() {},
        target: { closest() { return { dataset: { queuedAction: "remove", queuedId: "queued-3" } }; } },
      });
      expect(calls).toEqual([]);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("syncs the slash menu when the prompt input changes", () => {
    const handlers = new Map();
    const promptNode = {
      addEventListener(eventName, handler) {
        handlers.set(`mobilePromptInput:${eventName}`, handler);
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        if (id === "mobilePromptInput") return promptNode;
        return null;
      },
      bindClick() {},
      bindResponsiveClick() {},
      bindInput(id, eventName, handler) {
        const node = id === "mobilePromptInput" ? promptNode : null;
        node?.addEventListener(eventName, handler);
      },
      setStatus() {},
      updateMobileComposerState() {
        deps.__updated = (deps.__updated || 0) + 1;
      },
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      sendTurn: async () => {},
      syncSlashCommandMenu() {
        deps.__synced = (deps.__synced || 0) + 1;
      },
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    handlers.get("mobilePromptInput:input")?.({});

    expect(deps.__updated).toBe(1);
    expect(deps.__synced).toBe(1);
  });

  it("does not immediately reopen the slash menu on keyup after escape closes it", () => {
    const handlers = new Map();
    const promptNode = {
      addEventListener(eventName, handler) {
        handlers.set(`mobilePromptInput:${eventName}`, handler);
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        if (id === "mobilePromptInput") return promptNode;
        return null;
      },
      bindClick() {},
      bindResponsiveClick() {},
      bindInput(id, eventName, handler) {
        const node = id === "mobilePromptInput" ? promptNode : null;
        node?.addEventListener(eventName, handler);
      },
      setStatus() {},
      updateMobileComposerState() {},
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      sendTurn: async () => {},
      handleSlashCommandKeyDown(event) {
        return String(event?.key || "") === "Escape";
      },
      syncSlashCommandMenu() {
        deps.__synced = (deps.__synced || 0) + 1;
      },
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    handlers.get("mobilePromptInput:keydown")?.({ key: "Escape" });
    handlers.get("mobilePromptInput:keyup")?.({ key: "Escape" });

    expect(deps.__synced || 0).toBe(0);
  });

  it("uses tab to steer while a turn is already running", async () => {
    const handlers = new Map();
    let sendCalls = 0;
    let steerCalls = 0;
    const promptNode = {
      value: "take over",
      addEventListener(eventName, handler) {
        handlers.set(`mobilePromptInput:${eventName}`, handler);
      },
    };
    const deps = {
      state: {
        folderPickerOpen: false,
        modelOptionsLoading: false,
        threadItems: [],
        activeThreadPendingTurnRunning: true,
      },
      byId(id) {
        if (id === "mobilePromptInput") return promptNode;
        return null;
      },
      bindClick() {},
      bindResponsiveClick() {},
      bindInput(id, eventName, handler) {
        const node = id === "mobilePromptInput" ? promptNode : null;
        node?.addEventListener(eventName, handler);
      },
      setStatus() {},
      updateMobileComposerState() {},
      updateNotificationState() {},
      armSyntheticClickSuppression() {},
      wireBlurBackdropShield() {},
      closeFolderPicker() {},
      refreshFolderPicker: async () => {},
      renderFolderPicker() {},
      confirmFolderPickerCurrentPath() {},
      resetFolderPickerPath() {},
      switchFolderPickerWorkspace: async () => {},
      openFolderPicker: async () => {},
      newThread: async () => {},
      setMainTab() {},
      setMobileTab() {},
      refreshCodexVersions: async () => {},
      setWorkspaceTarget: async () => {},
      setHeaderModelMenuOpen() {},
      closeInlineEffortOverlay() {},
      shouldSuppressSyntheticClick() { return false; },
      renderThreads() {},
      wireThreadPullToRefresh() {},
      addHost: async () => {},
      resolveApproval: async () => {},
      resolveUserInput: async () => {},
      refreshPending: async () => {},
      uploadAttachment: async () => {},
      sendTurn: async () => {
        sendCalls += 1;
      },
      steerTurn: async () => {
        steerCalls += 1;
      },
      syncSlashCommandMenu() {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    const event = {
      key: "Tab",
      preventDefault() {
        event.prevented = true;
      },
    };
    await handlers.get("mobilePromptInput:keydown")?.(event);

    expect(event.prevented).toBe(true);
    expect(steerCalls).toBe(1);
    expect(sendCalls).toBe(0);
  });
});
