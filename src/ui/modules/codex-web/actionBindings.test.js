import { describe, expect, it } from "vitest";

import {
  createActionBindingsModule,
  resolveActionErrorMessage,
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
});
