import { describe, expect, it } from "vitest";

import { createBootstrapModule, restoreFavoriteThreadIds, restoreStartCwdState } from "./bootstrapApp.js";

describe("bootstrapApp", () => {
  it("restores normalized start cwd state", () => {
    const state = restoreStartCwdState(
      JSON.stringify({ windows: "C:\\repo\\", wsl2: "/home/test/" }),
      (value, target) => `${target}:${String(value || "").replace(/[\\/]+$/, "")}`
    );
    expect(state).toEqual({ windows: "windows:C:\\repo", wsl2: "wsl2:/home/test" });
  });

  it("falls back on invalid favorite payloads", () => {
    expect(Array.from(restoreFavoriteThreadIds('["a",2]'))).toEqual(["a", "2"]);
    expect(Array.from(restoreFavoriteThreadIds("{bad json}"))).toEqual([]);
  });

  it("refreshes slash defaults during bootstrap so a fresh load reflects config", async () => {
    const state = {
      startCwdByWorkspace: { windows: "", wsl2: "" },
      favoriteThreadIds: new Set(),
      workspaceTarget: "windows",
      fastModeEnabled: false,
      collapsedWorkspaceKeysByWorkspace: { windows: new Set(), wsl2: new Set() },
      threadItemsByWorkspace: { windows: [], wsl2: [] },
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
    };
    const calls = [];
    const module = createBootstrapModule({
      state,
      byId() { return null; },
      localStorageRef: {
        getItem(key) {
          if (key === "web_codex_active_main_tab_v1") return "settings";
          if (key === "web_codex_fast_mode_device_default_v1") return "1";
          return "";
        },
        setItem() {},
      },
      documentRef: { querySelector() { return null; }, body: { classList: { add() {} } } },
      requestAnimationFrameRef(cb) { cb(); },
      MutationObserverRef: class { observe() {} },
      installDebugAndE2E() {},
      installMobileViewportSync() { calls.push("viewport"); },
      getEmbeddedToken() { return ""; },
      normalizeWorkspaceTarget(value) { return value === "wsl2" ? "wsl2" : "windows"; },
      normalizeStartCwd(value) { return value; },
      restoreModelsCache() { return false; },
      restoreThreadsCache() { return false; },
      updateWorkspaceAvailability() {},
      applyWorkspaceUi() {},
      syncHeaderModelPicker() {},
      setStatus() {},
      updateNotificationState() {},
      applyManagedTokenUi() {},
      renderPendingLists() {},
      renderFolderPicker() {},
      renderAttachmentPills() {},
      renderComposerContextLeft() { calls.push("context"); },
      renderRuntimePanels() {},
      updateMobileComposerState() {},
      refreshSlashCommandsState() {
        calls.push("refresh");
        return Promise.resolve([]);
      },
      syncSettingsControlsFromMain() { calls.push("settings"); },
      updateWelcomeSelections() {},
      setMainTab(value) { calls.push(`tab:${value}`); },
      wireActions() {},
      ensureScrollToBottomBtn() {},
      stopChatLiveFollow() {},
      updateScrollToBottomBtn() {},
      chatDistanceFromBottom() { return 0; },
      dbgSet() {},
      canStartChatLiveFollow() { return false; },
      scheduleChatLiveFollow() {},
      startThreadAutoRefreshLoop() {},
      startActiveThreadLivePollLoop() {},
      setMobileTab() {},
      connect(options) {
        calls.push(`connect:${JSON.stringify(options || {})}`);
        return Promise.resolve();
      },
      GUIDE_DISMISSED_KEY: "guide",
      TOKEN_STORAGE_KEY: "token",
      WORKSPACE_TARGET_KEY: "workspace",
      START_CWD_BY_WORKSPACE_KEY: "cwd",
      FAVORITE_THREADS_KEY: "favorites",
      SELECTED_MODEL_KEY: "model",
      ACTIVE_MAIN_TAB_KEY: "web_codex_active_main_tab_v1",
      FAST_MODE_DEVICE_DEFAULT_KEY: "web_codex_fast_mode_device_default_v1",
      PERMISSION_PRESET_STORAGE_KEY: "web_codex_permission_preset_by_workspace_v1",
      SANDBOX_MODE: false,
      CHAT_STICKY_BOTTOM_PX: 32,
    });

    module.bootstrap();
    await Promise.resolve();

    expect(calls).toContain("refresh");
    expect(calls).toContain("viewport");
    expect(calls.filter((entry) => entry === "settings").length).toBeGreaterThan(0);
    expect(calls).toContain("tab:settings");
    expect(calls).toContain('connect:{"switchToChat":false}');
    expect(state.fastModeEnabled).toBe(true);
  });

  it("does not disable workspace switches before version detection finishes", () => {
    const state = {
      startCwdByWorkspace: { windows: "", wsl2: "" },
      favoriteThreadIds: new Set(),
      workspaceTarget: "windows",
      fastModeEnabled: false,
      collapsedWorkspaceKeysByWorkspace: { windows: new Set(), wsl2: new Set() },
      threadItemsByWorkspace: { windows: [], wsl2: [] },
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
    };
    const availabilityUpdates = [];
    const module = createBootstrapModule({
      state,
      byId() { return null; },
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      documentRef: { querySelector() { return null; }, body: { classList: { add() {} } } },
      requestAnimationFrameRef(cb) { cb(); },
      MutationObserverRef: class { observe() {} },
      installDebugAndE2E() {},
      installMobileViewportSync() {},
      getEmbeddedToken() { return ""; },
      normalizeWorkspaceTarget(value) { return value === "wsl2" ? "wsl2" : "windows"; },
      normalizeStartCwd(value) { return value; },
      restoreModelsCache() { return false; },
      restoreThreadsCache() { return false; },
      updateWorkspaceAvailability(...args) { availabilityUpdates.push(args); },
      applyWorkspaceUi() {},
      syncHeaderModelPicker() {},
      setStatus() {},
      updateNotificationState() {},
      applyManagedTokenUi() {},
      renderPendingLists() {},
      renderFolderPicker() {},
      renderAttachmentPills() {},
      renderComposerContextLeft() {},
      renderRuntimePanels() {},
      updateMobileComposerState() {},
      refreshSlashCommandsState() { return Promise.resolve([]); },
      syncSettingsControlsFromMain() {},
      updateWelcomeSelections() {},
      setMainTab() {},
      wireActions() {},
      ensureScrollToBottomBtn() {},
      stopChatLiveFollow() {},
      updateScrollToBottomBtn() {},
      chatDistanceFromBottom() { return 0; },
      dbgSet() {},
      canStartChatLiveFollow() { return false; },
      scheduleChatLiveFollow() {},
      startThreadAutoRefreshLoop() {},
      startActiveThreadLivePollLoop() {},
      setMobileTab() {},
      connect() { return Promise.resolve(); },
      GUIDE_DISMISSED_KEY: "guide",
      TOKEN_STORAGE_KEY: "token",
      WORKSPACE_TARGET_KEY: "workspace",
      START_CWD_BY_WORKSPACE_KEY: "cwd",
      FAVORITE_THREADS_KEY: "favorites",
      SELECTED_MODEL_KEY: "model",
      ACTIVE_MAIN_TAB_KEY: "web_codex_active_main_tab_v1",
      FAST_MODE_DEVICE_DEFAULT_KEY: "web_codex_fast_mode_device_default_v1",
      PERMISSION_PRESET_STORAGE_KEY: "web_codex_permission_preset_by_workspace_v1",
      SANDBOX_MODE: false,
      CHAT_STICKY_BOTTOM_PX: 32,
    });

    module.bootstrap();

    expect(availabilityUpdates).toEqual([]);
    expect(state.workspaceAvailability).toEqual({ windowsInstalled: true, wsl2Installed: true });
  });
});
