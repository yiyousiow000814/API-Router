import { describe, expect, it, vi } from "vitest";

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

  it("replays a compact provider-free error demo with button motion", async () => {
    const handlers = new Map();
    const timeouts = [];
    const chatCalls = [];
    const removedKeys = [];
    const classOps = [];
    const previousRandom = Math.random;
    Math.random = () => 0;

    const testButton = {
      textContent: "Replay error demo",
      disabled: false,
      classList: {
        add(...names) {
          classOps.push(["add", ...names]);
        },
        remove(...names) {
          classOps.push(["remove", ...names]);
        },
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        return id === "testErrorBtn" ? testButton : null;
      },
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
      setMainTab(tab) {
        deps.__mainTab = tab;
      },
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
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      uploadAttachment: async () => {},
      sendTurn: async () => {},
      syncSettingsControlsFromMain() {},
      addChat(role, text, options = {}) {
        chatCalls.push({ role, text, options });
      },
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: {
        addEventListener() {},
        setTimeout(callback, delay) {
          timeouts.push({ callback, delay });
          return timeouts.length;
        },
      },
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
      await handlers.get("testErrorBtn")();

      expect(deps.__mainTab).toBe("chat");
      expect(testButton.textContent).toBe("Replaying...");
      expect(testButton.disabled).toBe(true);
      expect(classOps).toContainEqual(["add", "is-replaying"]);
      expect(removedKeys).toEqual(["error-demo-sequence"]);
      expect(timeouts).toHaveLength(1);

      while (timeouts.length) {
        const next = timeouts.shift();
        next.callback();
      }

      expect(chatCalls).toHaveLength(6);
      expect(chatCalls.every((call) => call.options.messageKey === "error-demo-sequence")).toBe(true);
      expect(chatCalls.slice(0, 5).every((call, index) => call.text === `Reconnecting... ${index + 1}/5`)).toBe(true);
      expect(chatCalls[0].options.kind).toBe("thinking");
      expect(chatCalls[5].options.kind).toBe("error");
      expect(chatCalls[5].options.animate).toBe(true);
      expect(chatCalls.slice(0, 5).every((call) => !call.text.includes("anthropic"))).toBe(true);
      expect(chatCalls[5].text).toBe("[TEST] stream disconnected before completion: response closed early");
      expect(removedKeys).toEqual(["error-demo-sequence", "error-demo-sequence"]);
      expect(testButton.textContent).toBe("Replay error demo");
      expect(testButton.disabled).toBe(false);
      expect(classOps).toContainEqual(["remove", "is-replaying"]);
    } finally {
      Math.random = previousRandom;
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("wires the status tray close button", async () => {
    const handlers = new Map();
    const clearCalls = [];
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
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
      clearThreadStatusCard() {
        clearCalls.push(true);
      },
    };
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNotification = globalThis.Notification;
    globalThis.document = { addEventListener() {} };
    globalThis.window = deps.windowRef;
    globalThis.Notification = deps.NotificationRef;

    try {
      createActionBindingsModule(deps).wireActions();
      expect(handlers.has("statusTrayCloseBtn")).toBe(true);
      await handlers.get("statusTrayCloseBtn")();
      expect(clearCalls).toEqual([true]);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
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

  it("toggles pending preview from settings", async () => {
    const handlers = new Map();
    const statusCalls = [];
    let open = false;
    const windowRef = {
      addEventListener() {},
      __webCodexDebug: {
        previewPending() {
          open = !open;
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
      await handlers.get("previewPendingBtn")();
      await handlers.get("previewPendingBtn")();

      expect(statusCalls).toEqual([
        { message: "Pending preview shown.", isError: false },
        { message: "Pending preview hidden.", isError: false },
      ]);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("keeps the header workspace badge as status-only", async () => {
    const handlers = new Map();
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
      expect(handlers.has("headerWorkspaceBadge")).toBe(false);
    } finally {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.Notification = previousNotification;
    }
  });

  it("wires pending approval and user-input actions from the tools panel", async () => {
    const approvalHandlers = {};
    const userInputHandlers = {};
    const approvalCalls = [];
    const userInputCalls = [];
    const statusCalls = [];
    const approvalList = {
      addEventListener(type, handler) {
        approvalHandlers[type] = handler;
      },
    };
    const userInputList = {
      addEventListener(type, handler) {
        userInputHandlers[type] = handler;
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        if (id === "approvalPendingList") return approvalList;
        if (id === "userInputPendingList") return userInputList;
        return null;
      },
      bindClick() {},
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
      resolveApproval: async (payload) => { approvalCalls.push(payload); },
      resolveUserInput: async (payload) => { userInputCalls.push(payload); },
      refreshPending: async () => {},
      getPendingUserInputDraftAnswers: (id) => (id === "input-1" ? { route: "Debug" } : {}),
      setPendingUserInputDraftAnswer(...args) {
        deps.__draftCall = args;
      },
      uploadAttachment: async () => {},
      sendTurn: async () => {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();

    approvalHandlers.click({
      target: {
        closest(selector) {
          if (selector === "[data-pending-approval-decision]") {
            return {
              getAttribute(name) {
                return name === "data-pending-approval-id" ? "approval-1" : "approve";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });
    userInputHandlers.click({
      target: {
        closest(selector) {
          if (selector === "[data-pending-answer-key]") {
            return {
              getAttribute(name) {
                if (name === "data-pending-user-input-id") return "input-1";
                if (name === "data-pending-answer-key") return "route";
                if (name === "data-pending-answer-value") return "Debug";
                return "";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });
    await userInputHandlers.click({
      target: {
        closest(selector) {
          if (selector === "[data-pending-answer-key]") return null;
          if (selector === "[data-pending-user-input-submit]") {
            return {
              getAttribute() {
                return "input-1";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });

    expect(approvalCalls).toEqual([{ id: "approval-1", decision: "approve" }]);
    expect(deps.__draftCall).toEqual(["input-1", "route", "Debug", { mode: "option" }]);
    expect(userInputCalls).toEqual([{ id: "input-1", answers: { route: "Debug" } }]);
    expect(statusCalls).toEqual([]);
  });

  it("wires pending approval and user-input actions from inline chat cards", async () => {
    const chatHandlers = {};
    const approvalCalls = [];
    const userInputCalls = [];
    const chatBox = {
      addEventListener(type, handler) {
        chatHandlers[type] = handler;
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        if (id === "chatBox") return chatBox;
        return null;
      },
      bindClick() {},
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
      resolveApproval: async (payload) => { approvalCalls.push(payload); },
      resolveUserInput: async (payload) => { userInputCalls.push(payload); },
      refreshPending: async () => {},
      getPendingUserInputDraftAnswers: () => ({ route: "Debug" }),
      setPendingUserInputDraftAnswer(...args) {
        deps.__draft = args;
      },
      uploadAttachment: async () => {},
      sendTurn: async () => {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();

    await chatHandlers.click({
      target: {
        closest(selector) {
          if (selector === "[data-pending-approval-decision]") {
            return {
              getAttribute(name) {
                return name === "data-pending-approval-id" ? "approval-inline" : "approve";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });
    await chatHandlers.click({
      target: {
        closest(selector) {
          if (selector === "[data-pending-approval-decision]") return null;
          if (selector === "[data-pending-answer-key]") {
            return {
              getAttribute(name) {
                if (name === "data-pending-user-input-id") return "input-inline";
                if (name === "data-pending-answer-key") return "route";
                if (name === "data-pending-answer-value") return "Debug";
                return "";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });
    await chatHandlers.click({
      target: {
        closest(selector) {
          if (selector === "[data-pending-approval-decision]") return null;
          if (selector === "[data-pending-answer-key]") return null;
          if (selector === "[data-pending-user-input-submit]") {
            return { getAttribute() { return "input-inline"; } };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });

    expect(approvalCalls).toEqual([{ id: "approval-inline", decision: "approve" }]);
    expect(deps.__draft).toEqual(["input-inline", "route", "Debug", { mode: "option" }]);
    expect(userInputCalls).toEqual([{ id: "input-inline", answers: { route: "Debug" } }]);
  });

  it("animates inline freeform exit before switching back to an option", async () => {
    const chatHandlers = {};
    const timeoutCalls = [];
    const blurCalls = [];
    const removedClasses = [];
    const chatBox = {
      addEventListener(type, handler) {
        chatHandlers[type] = handler;
      },
    };
    const freeformInput = {
      blur() {
        blurCalls.push("blur");
      },
    };
    const freeformWrap = {
      dataset: {},
      classList: {
        remove(name) {
          removedClasses.push(name);
        },
      },
      querySelector(selector) {
        if (selector === "[data-pending-freeform-input]") return freeformInput;
        return null;
      },
    };
    const question = {
      querySelector(selector) {
        if (selector === ".pendingInlineFreeformWrap.is-visible") return freeformWrap;
        return null;
      },
    };
    const optionBtn = {
      getAttribute(name) {
        if (name === "data-pending-user-input-id") return "input-inline";
        if (name === "data-pending-answer-key") return "route";
        if (name === "data-pending-answer-value") return "Debug";
        return "";
      },
      closest(selector) {
        if (selector === ".pendingInlineQuestion") return question;
        return null;
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        if (id === "chatBox") return chatBox;
        return null;
      },
      bindClick() {},
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
      getPendingUserInputDraftAnswers: () => ({}),
      setPendingUserInputDraftAnswer(...args) {
        deps.__draft = args;
      },
      uploadAttachment: async () => {},
      sendTurn: async () => {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: {
        addEventListener() {},
        setTimeout(callback, delay) {
          timeoutCalls.push(delay);
          return callback();
        },
      },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();

    await chatHandlers.click({
      target: {
        closest(selector) {
          if (selector === "[data-pending-approval-decision]") return null;
          if (selector === "[data-pending-answer-key]") return optionBtn;
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });

    expect(removedClasses).toEqual(["is-visible"]);
    expect(blurCalls).toEqual(["blur"]);
    expect(timeoutCalls).toEqual([180]);
    expect(deps.__draft).toEqual(["input-inline", "route", "Debug", { mode: "option" }]);
  });

  it("stores freeform input from inline pending cards", async () => {
    const chatHandlers = {};
    const chatBox = {
      addEventListener(type, handler) {
        chatHandlers[type] = handler;
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        if (id === "chatBox") return chatBox;
        return null;
      },
      bindClick() {},
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
      getPendingUserInputDraftAnswers: () => ({}),
      setPendingUserInputDraftAnswer(...args) {
        deps.__draft = args;
      },
      uploadAttachment: async () => {},
      sendTurn: async () => {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();

    chatHandlers.input({
      target: {
        closest(selector) {
          if (selector === "[data-pending-freeform-input]") {
            return {
              value: "My custom answer",
              getAttribute(name) {
                if (name === "data-pending-user-input-id") return "input-inline";
                if (name === "data-pending-answer-key") return "route";
                return "";
              },
            };
          }
          return null;
        },
      },
    });

    expect(deps.__draft).toEqual(["input-inline", "route", "My custom answer", { mode: "freeform" }]);
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

  it("reconciles chat scroll when the prompt input regains focus", () => {
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
      scrollToBottomReliable() {
        deps.__reconciled = (deps.__reconciled || 0) + 1;
      },
      syncSlashCommandMenu() {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    handlers.get("mobilePromptInput:focus")?.({});

    expect(deps.__updated).toBe(1);
    expect(deps.__reconciled).toBe(1);
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
        activeThreadId: "",
        activeThreadOpenState: {
          threadId: "thread-1",
          loaded: true,
          resumeRequired: false,
        },
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

  it("switches branches against the active WSL2 workspace", async () => {
    const handlers = new Map();
    const statusCalls = [];
    let apiResolve;
    const pickerBar = {
      addEventListener(eventName, handler) {
        handlers.set(`composerPickerBar:${eventName}`, handler);
      },
      contains() {
        return false;
      },
    };
    const deps = {
      state: {
        folderPickerOpen: false,
        modelOptionsLoading: false,
        threadItems: [],
        activeThreadWorkspace: "wsl2",
        workspaceTarget: "windows",
        activeThreadId: "thread-1",
        activeThreadGitMetaSource: "thread",
        activeThreadGitMetaCwd: "/repo/demo",
        activeThreadGitMetaLoading: false,
        activeThreadGitMetaLoaded: true,
        activeThreadCurrentBranch: "feature/ui",
        activeThreadBranchOptions: [{ name: "main" }, { name: "feature/ui" }],
        composerBranchMenuOpen: true,
        composerPermissionMenuOpen: false,
      },
      byId(id) {
        if (id === "composerPickerBar") return pickerBar;
        return null;
      },
      bindClick() {},
      bindResponsiveClick() {},
      bindInput() {},
      setStatus(message, isError = false) {
        statusCalls.push({ message, isError });
      },
      updateMobileComposerState() {
        deps.__updates = (deps.__updates || 0) + 1;
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
      executeSlashCommand: async () => {},
      sendTurn: async () => {},
      api: (url, options) => {
        deps.__apiCall = { url, options };
        return new Promise((resolve) => {
          apiResolve = resolve;
        });
      },
      syncSlashCommandMenu() {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    await handlers.get("composerPickerBar:click")?.({
      target: {
        closest(selector) {
          if (selector === "[data-composer-branch-option]") {
            return {
              getAttribute(name) {
                if (name === "data-composer-branch-option") return "main";
                return "";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });

    expect(deps.state.composerBranchMenuOpen).toBe(false);
    expect(deps.state.activeThreadGitMetaLoading).toBe(true);
    expect(deps.__apiCall?.url).toBe("/codex/threads/thread-1/branch");
    expect(deps.__apiCall?.options?.body?.workspace).toBe("wsl2");
    expect(statusCalls).toEqual([]);

    apiResolve?.({ currentBranch: "main", branches: [{ name: "main" }] });
    await Promise.resolve();
  });

  it("ignores stale branch-switch responses after a newer git-meta request supersedes them", async () => {
    const handlers = new Map();
    const pickerBar = {
      addEventListener(eventName, handler) {
        handlers.set(`composerPickerBar:${eventName}`, handler);
      },
      contains() {
        return false;
      },
    };
    let resolveSwitch;
    const deps = {
      state: {
        folderPickerOpen: false,
        modelOptionsLoading: false,
        threadItems: [],
        activeThreadWorkspace: "windows",
        workspaceTarget: "windows",
        activeThreadId: "thread-1",
        activeThreadGitMetaSource: "thread",
        activeThreadGitMetaCwd: "C:\\repo\\demo",
        activeThreadGitMetaLoading: false,
        activeThreadGitMetaLoaded: true,
        activeThreadGitMetaReqSeq: 4,
        activeThreadCurrentBranch: "main",
        activeThreadBranchOptions: [{ name: "main" }, { name: "feature/ui" }],
        composerBranchMenuOpen: true,
        composerPermissionMenuOpen: false,
      },
      byId(id) {
        if (id === "composerPickerBar") return pickerBar;
        return null;
      },
      bindClick() {},
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
      executeSlashCommand: async () => {},
      sendTurn: async () => {},
      api: () => new Promise((resolve) => {
        resolveSwitch = resolve;
      }),
      syncSlashCommandMenu() {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    handlers.get("composerPickerBar:click")?.({
      target: {
        closest(selector) {
          if (selector === "[data-composer-branch-option]") {
            return {
              getAttribute(name) {
                if (name === "data-composer-branch-option") return "feature/ui";
                return "";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });

    expect(deps.state.activeThreadGitMetaReqSeq).toBe(5);

    deps.state.activeThreadGitMetaReqSeq = 6;
    resolveSwitch?.({
      currentBranch: "feature/ui",
      branches: [{ name: "main" }, { name: "feature/ui" }],
    });
    await Promise.resolve();

    expect(deps.state.activeThreadCurrentBranch).toBe("main");
    expect(deps.state.composerBranchMenuOpen).toBe(false);
    expect(deps.state.activeThreadGitMetaLoading).toBe(true);
  });

  it("blocks dirty branch switches before calling the backend", async () => {
    const handlers = new Map();
    const pickerBar = {
      addEventListener(eventName, handler) {
        handlers.set(`composerPickerBar:${eventName}`, handler);
      },
      contains() {
        return false;
      },
    };
    const deps = {
      state: {
        folderPickerOpen: false,
        modelOptionsLoading: false,
        threadItems: [],
        activeThreadWorkspace: "windows",
        workspaceTarget: "windows",
        activeThreadId: "thread-1",
        activeThreadGitMetaSource: "thread",
        activeThreadGitMetaCwd: "C:\\repo\\demo",
        activeThreadGitMetaLoading: false,
        activeThreadGitMetaLoaded: true,
        activeThreadCurrentBranch: "main",
        activeThreadBranchOptions: [{ name: "main" }, { name: "feature/ui" }],
        activeThreadUncommittedFileCount: 3,
        composerBranchMenuOpen: true,
        composerPermissionMenuOpen: false,
      },
      byId(id) {
        if (id === "composerPickerBar") return pickerBar;
        if (id === "branchSwitchBlockedBackdrop") return {
          classList: { add() {}, remove() {} },
          setAttribute() {},
        };
        return null;
      },
      bindClick() {},
      bindResponsiveClick() {},
      bindInput() {},
      setStatus() {},
      updateMobileComposerState() {
        deps.__updates = (deps.__updates || 0) + 1;
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
      executeSlashCommand: async () => {},
      sendTurn: async () => {},
      api: vi.fn(),
      syncSlashCommandMenu() {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    await handlers.get("composerPickerBar:click")?.({
      target: {
        closest(selector) {
          if (selector === "[data-composer-branch-option]") {
            return {
              getAttribute(name) {
                if (name === "data-composer-branch-option") return "feature/ui";
                return "";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });
    await Promise.resolve();

    expect(deps.state.composerBranchMenuOpen).toBe(false);
    expect(deps.state.activeThreadGitMetaLoading).toBe(false);
    expect(deps.api).not.toHaveBeenCalled();
  });

  it("keeps only the branch-switch blocked dismiss action wired", () => {
    const handlers = new Map();
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
      refreshActiveThreadGitMeta: async () => null,
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
      sendTurn: async () => {},
      syncSlashCommandMenu() {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();

    expect(handlers.has("branchSwitchBlockedCancelBtn")).toBe(true);
    expect(handlers.has("branchSwitchBlockedCommitBtn")).toBe(false);
  });

  it("closes the branch menu without switching when clicking the active branch", async () => {
    const handlers = new Map();
    const pickerBar = {
      addEventListener(eventName, handler) {
        handlers.set(`composerPickerBar:${eventName}`, handler);
      },
      contains() {
        return false;
      },
    };
    const api = vi.fn();
    const deps = {
      state: {
        folderPickerOpen: false,
        modelOptionsLoading: false,
        threadItems: [],
        activeThreadWorkspace: "windows",
        workspaceTarget: "windows",
        activeThreadId: "thread-1",
        activeThreadGitMetaSource: "thread",
        activeThreadGitMetaCwd: "C:\\repo\\demo",
        activeThreadGitMetaLoading: false,
        activeThreadGitMetaLoaded: true,
        activeThreadCurrentBranch: "feat/codex-web-branch-picker",
        activeThreadUncommittedFileCount: 3,
        activeThreadBranchOptions: [
          { name: "main" },
          { name: "feat/codex-web-branch-picker", prNumber: 196 },
          { name: "chore/web-codex-terminal-communication", prNumber: 150 },
        ],
        composerBranchMenuOpen: true,
        composerPermissionMenuOpen: false,
      },
      byId(id) {
        if (id === "composerPickerBar") return pickerBar;
        return null;
      },
      bindClick() {},
      bindResponsiveClick() {},
      bindInput() {},
      setStatus() {},
      updateMobileComposerState() {
        deps.__updates = (deps.__updates || 0) + 1;
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
      executeSlashCommand: async () => {},
      sendTurn: async () => {},
      api,
      syncSlashCommandMenu() {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    await handlers.get("composerPickerBar:click")?.({
      target: {
        closest(selector) {
          if (selector === "[data-composer-branch-option]") {
            return {
              getAttribute(name) {
                if (name === "data-composer-branch-option") return "feat/codex-web-branch-picker";
                return "";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });

    expect(api).not.toHaveBeenCalled();
    expect(deps.state.composerBranchMenuOpen).toBe(false);
    expect(deps.state.activeThreadGitMetaLoading).toBe(false);
    expect(deps.state.activeThreadUncommittedFileCount).toBe(3);
    expect(deps.state.activeThreadBranchOptions).toEqual([
      { name: "main" },
      { name: "feat/codex-web-branch-picker", prNumber: 196 },
      { name: "chore/web-codex-terminal-communication", prNumber: 150 },
    ]);
    expect(deps.__updates).toBe(1);
  });

  it("opens the branch picker immediately without refetching git metadata", async () => {
    const handlers = new Map();
    const pickerBar = {
      addEventListener(eventName, handler) {
        handlers.set(`composerPickerBar:${eventName}`, handler);
      },
    };
    const deps = {
      state: {
        folderPickerOpen: false,
        modelOptionsLoading: false,
        threadItems: [],
        activeThreadWorkspace: "windows",
        workspaceTarget: "windows",
        activeThreadId: "thread-1",
        activeThreadGitMetaSource: "thread",
        activeThreadGitMetaCwd: "C:\\repo\\demo",
        activeThreadGitMetaLoading: false,
        activeThreadGitMetaLoaded: true,
        activeThreadCurrentBranch: "feat/codex-web-branch-picker",
        activeThreadUncommittedFileCount: 0,
        activeThreadBranchOptions: [
          { name: "main" },
          { name: "feat/codex-web-branch-picker", prNumber: 196 },
        ],
        composerBranchMenuOpen: false,
        composerPermissionMenuOpen: false,
      },
      byId(id) {
        if (id === "composerPickerBar") return pickerBar;
        return null;
      },
      bindClick() {},
      bindResponsiveClick() {},
      bindInput() {},
      setStatus() {},
      updateMobileComposerState() {
        deps.__updates = (deps.__updates || 0) + 1;
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
      executeSlashCommand: async () => {},
      sendTurn: async () => {},
      api: vi.fn(),
      syncSlashCommandMenu() {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    handlers.get("composerPickerBar:click")?.({
      target: {
        closest(selector) {
          if (selector === "[data-composer-picker-toggle]") {
            return {
              disabled: false,
              getAttribute(name) {
                if (name === "data-composer-picker-toggle") return "branch";
                return "";
              },
            };
          }
          return null;
        },
      },
      preventDefault() {},
      stopPropagation() {},
    });

    expect(deps.state.composerBranchMenuOpen).toBe(true);
    expect(deps.state.activeThreadGitMetaLoading).toBe(false);
    expect(deps.api).not.toHaveBeenCalled();
  });

  it("closes picker menus when clicking the picker bar background", () => {
    const handlers = new Map();
    const OriginalNode = globalThis.Node;
    class FakeNode {}
    globalThis.Node = FakeNode;
    try {
      const pickerBar = {
        addEventListener(eventName, handler) {
          handlers.set(`composerPickerBar:${eventName}`, handler);
        },
        contains(target) {
          return target === pickerBarTarget;
        },
      };
      const pickerBarTarget = new FakeNode();
      pickerBarTarget.closest = () => null;
      const deps = {
        state: {
          folderPickerOpen: false,
          modelOptionsLoading: false,
          threadItems: [],
          composerBranchMenuOpen: true,
          composerPermissionMenuOpen: true,
        },
        byId(id) {
          if (id === "composerPickerBar") return pickerBar;
          return null;
        },
        bindClick() {},
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
        syncSlashCommandMenu() {},
        syncSettingsControlsFromMain() {},
        localStorageRef: { getItem() { return ""; }, setItem() {} },
        windowRef: { addEventListener() {} },
        documentRef: {
          addEventListener(eventName, handler) {
            handlers.set(`document:${eventName}`, handler);
          },
        },
        NotificationRef: { requestPermission: async () => "default" },
      };

      createActionBindingsModule(deps).wireActions();
      handlers.get("document:click")?.({ target: pickerBarTarget });

      expect(deps.state.composerBranchMenuOpen).toBe(false);
      expect(deps.state.composerPermissionMenuOpen).toBe(false);
    } finally {
      globalThis.Node = OriginalNode;
    }
  });

  it("does not prefetch git metadata on branch-picker hover", () => {
    const handlers = new Map();
    const pickerBar = {
      addEventListener(eventName, handler) {
        handlers.set(`composerPickerBar:${eventName}`, handler);
      },
      contains() {
        return false;
      },
      querySelector() {
        return { __branchHoverPrefetched: false };
      },
    };
    const deps = {
      state: { folderPickerOpen: false, modelOptionsLoading: false, threadItems: [] },
      byId(id) {
        return id === "composerPickerBar" ? pickerBar : null;
      },
      bindClick() {},
      bindResponsiveClick() {},
      bindInput() {},
      setStatus() {},
      updateMobileComposerState() {},
      refreshActiveThreadGitMeta: vi.fn(async () => null),
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
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();

    expect(handlers.has("composerPickerBar:mouseover")).toBe(false);
    expect(deps.refreshActiveThreadGitMeta).not.toHaveBeenCalled();
  });

  it("closes picker menus from the picker bar when clicking a non-interactive gap", () => {
    const handlers = new Map();
    const pickerBar = {
      addEventListener(eventName, handler) {
        handlers.set(`composerPickerBar:${eventName}`, handler);
      },
    };
    const deps = {
      state: {
        folderPickerOpen: false,
        modelOptionsLoading: false,
        threadItems: [],
        composerBranchMenuOpen: true,
        composerPermissionMenuOpen: true,
      },
      byId(id) {
        if (id === "composerPickerBar") return pickerBar;
        return null;
      },
      bindClick() {},
      bindResponsiveClick() {},
      bindInput() {},
      setStatus() {},
      updateMobileComposerState() {
        deps.__updates = (deps.__updates || 0) + 1;
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
      syncSlashCommandMenu() {},
      syncSettingsControlsFromMain() {},
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      windowRef: { addEventListener() {} },
      documentRef: { addEventListener() {} },
      NotificationRef: { requestPermission: async () => "default" },
    };

    createActionBindingsModule(deps).wireActions();
    handlers.get("composerPickerBar:click")?.({
      target: {
        closest() {
          return null;
        },
      },
    });

    expect(deps.state.composerBranchMenuOpen).toBe(false);
    expect(deps.state.composerPermissionMenuOpen).toBe(false);
    expect(deps.__updates).toBe(1);
  });

  it("does not re-render when document click closes already-closed picker menus", () => {
    const handlers = new Map();
    const OriginalNode = globalThis.Node;
    class FakeNode {}
    globalThis.Node = FakeNode;
    try {
      const pickerBar = {
        addEventListener() {},
        contains() {
          return false;
        },
      };
      const outsideTarget = new FakeNode();
      outsideTarget.closest = () => null;
      const deps = {
        state: {
          folderPickerOpen: false,
          modelOptionsLoading: false,
          threadItems: [],
          composerBranchMenuOpen: false,
          composerPermissionMenuOpen: false,
        },
        byId(id) {
          if (id === "composerPickerBar") return pickerBar;
          return null;
        },
        bindClick() {},
        bindResponsiveClick() {},
        bindInput() {},
        setStatus() {},
        updateMobileComposerState() {
          deps.__updates = (deps.__updates || 0) + 1;
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
        syncSlashCommandMenu() {},
        syncSettingsControlsFromMain() {},
        localStorageRef: { getItem() { return ""; }, setItem() {} },
        windowRef: { addEventListener() {} },
        documentRef: {
          addEventListener(eventName, handler) {
            handlers.set(`document:${eventName}`, handler);
          },
        },
        NotificationRef: { requestPermission: async () => "default" },
      };

      createActionBindingsModule(deps).wireActions();
      handlers.get("document:click")?.({ target: outsideTarget });

      expect(deps.state.composerBranchMenuOpen).toBe(false);
      expect(deps.state.composerPermissionMenuOpen).toBe(false);
      expect(deps.__updates || 0).toBe(0);
    } finally {
      globalThis.Node = OriginalNode;
    }
  });
});
