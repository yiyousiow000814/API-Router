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
});
