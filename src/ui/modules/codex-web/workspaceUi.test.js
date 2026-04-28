import { describe, expect, it } from "vitest";

import {
  buildRuntimeStateUrl,
  createWorkspaceUiModule,
  folderDisplayName,
  normalizeRuntimeStatePayload,
  normalizeStartCwd,
} from "./workspaceUi.js";
import { resolveThreadOpenState } from "./threadOpenState.js";

describe("workspaceUi", () => {
  it("normalizes windows and wsl cwd values", () => {
    expect(normalizeStartCwd("C:\\repo\\", "windows")).toBe("C:\\repo");
    expect(normalizeStartCwd("/home/user/project/", "wsl2")).toBe("/home/user/project");
    expect(normalizeStartCwd("relative/path", "windows")).toBe("");
  });

  it("builds display labels from folder paths", () => {
    expect(folderDisplayName("C:\\repo\\demo", "windows")).toBe("demo");
    expect(folderDisplayName("D:", "windows")).toBe("D:\\");
    expect(folderDisplayName("/home/user/demo", "wsl2")).toBe("demo");
  });

  it("builds runtime-state urls and normalizes payloads", () => {
    expect(buildRuntimeStateUrl("wsl2")).toBe("/codex/runtime/state?workspace=wsl2");
    expect(
      normalizeRuntimeStatePayload({
        workspace: "windows",
        connected: true,
        connectedAtUnixSecs: 11,
        lastReplayCursor: 22,
        lastReplayLastEventId: 33,
        lastReplayAtUnixSecs: 44,
      })
    ).toEqual({
      workspace: "windows",
      homeOverride: "",
      connected: true,
      connectedAtUnixSecs: 11,
      lastReplayCursor: 22,
      lastReplayLastEventId: 33,
      lastReplayAtUnixSecs: 44,
      loaded: true,
      loading: false,
    });
  });

  it("resubscribes live events when switching workspace target", async () => {
    const statuses = [];
    let subscriptionSyncCount = 0;
    const module = createWorkspaceUiModule({
      state: {
        workspaceTarget: "windows",
        workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
        collapsedWorkspaceKeys: new Set(),
        collapsedWorkspaceKeysByWorkspace: { windows: new Set(), wsl2: new Set() },
        threadItemsByWorkspace: { windows: [], wsl2: [] },
        threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: false },
        threadListRenderSigByWorkspace: { windows: "", wsl2: "" },
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        startCwdByWorkspace: { windows: "", wsl2: "" },
        threadItemsAll: [],
        threadItems: [],
        folderPickerOpen: false,
      },
      byId() {
        return null;
      },
      normalizeWorkspaceTarget(value) {
        return String(value || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
      },
      localStorageRef: { setItem() {} },
      WORKSPACE_TARGET_KEY: "workspace",
      START_CWD_BY_WORKSPACE_KEY: "cwd",
      detectThreadWorkspaceTarget() {
        return "unknown";
      },
      updateHeaderUi() {},
      renderFolderPicker() {},
      setStatus(message) {
        statuses.push(message);
      },
      pushThreadAnimDebug() {},
      isThreadListActuallyVisible() {
        return false;
      },
      buildThreadRenderSig() {
        return "";
      },
      applyThreadFilter() {},
      refreshThreads() {
        return Promise.resolve();
      },
      syncEventSubscription() {
        subscriptionSyncCount += 1;
        return true;
      },
      renderThreads() {},
    });

    await module.setWorkspaceTarget("wsl2");

    expect(subscriptionSyncCount).toBe(1);
    expect(statuses).toContain("Workspace target: WSL2");
  });

  it("renders fresh cached workspace threads before deferring switch refresh", async () => {
    const refreshCalls = [];
    const timers = [];
    const state = {
      workspaceTarget: "windows",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
      collapsedWorkspaceKeys: new Set(),
      collapsedWorkspaceKeysByWorkspace: { windows: new Set(), wsl2: new Set() },
      threadItemsByWorkspace: {
        windows: [],
        wsl2: [{ id: "thread-wsl", workspace: "wsl2" }],
      },
      threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: true },
      threadRefreshCompletedAtByWorkspace: { wsl2: 1000 },
      threadListRenderSigByWorkspace: { windows: "", wsl2: "" },
      threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
      startCwdByWorkspace: { windows: "", wsl2: "" },
      threadItemsAll: [],
      threadItems: [],
      folderPickerOpen: false,
    };
    const module = createWorkspaceUiModule({
      state,
      byId() {
        return null;
      },
      normalizeWorkspaceTarget(value) {
        return String(value || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
      },
      localStorageRef: { setItem() {} },
      WORKSPACE_TARGET_KEY: "workspace",
      START_CWD_BY_WORKSPACE_KEY: "cwd",
      detectThreadWorkspaceTarget() {
        return "unknown";
      },
      updateHeaderUi() {},
      renderFolderPicker() {},
      setStatus() {},
      pushThreadAnimDebug() {},
      isThreadListActuallyVisible() {
        return true;
      },
      buildThreadRenderSig(items) {
        return String(items.length);
      },
      applyThreadFilter() {},
      refreshThreads(target, options) {
        refreshCalls.push({ target, options });
        return Promise.resolve();
      },
      syncEventSubscription() {
        return true;
      },
      renderThreads() {},
      nowRef() {
        return 2000;
      },
      setTimeoutRef(callback, delayMs) {
        timers.push({ callback, delayMs });
        return timers.length;
      },
      clearTimeoutRef() {},
    });

    await module.setWorkspaceTarget("wsl2");

    expect(state.threadItemsAll).toEqual([{ id: "thread-wsl", workspace: "wsl2" }]);
    expect(refreshCalls).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0].delayMs).toBe(1200);

    timers[0].callback();

    expect(refreshCalls).toEqual([
      { target: "wsl2", options: { force: false, silent: true } },
    ]);
  });

  it("refreshes immediately when switching to stale cached workspace threads", async () => {
    const refreshCalls = [];
    const timers = [];
    const state = {
      workspaceTarget: "windows",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
      collapsedWorkspaceKeys: new Set(),
      collapsedWorkspaceKeysByWorkspace: { windows: new Set(), wsl2: new Set() },
      threadItemsByWorkspace: {
        windows: [],
        wsl2: [{ id: "thread-wsl", workspace: "wsl2" }],
      },
      threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: true },
      threadRefreshCompletedAtByWorkspace: { wsl2: 1000 },
      threadListRenderSigByWorkspace: { windows: "", wsl2: "" },
      threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
      startCwdByWorkspace: { windows: "", wsl2: "" },
      threadItemsAll: [],
      threadItems: [],
      folderPickerOpen: false,
    };
    const module = createWorkspaceUiModule({
      state,
      byId() {
        return null;
      },
      normalizeWorkspaceTarget(value) {
        return String(value || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
      },
      localStorageRef: { setItem() {} },
      WORKSPACE_TARGET_KEY: "workspace",
      START_CWD_BY_WORKSPACE_KEY: "cwd",
      detectThreadWorkspaceTarget() {
        return "unknown";
      },
      updateHeaderUi() {},
      renderFolderPicker() {},
      setStatus() {},
      pushThreadAnimDebug() {},
      isThreadListActuallyVisible() {
        return true;
      },
      buildThreadRenderSig(items) {
        return String(items.length);
      },
      applyThreadFilter() {},
      refreshThreads(target, options) {
        refreshCalls.push({ target, options });
        return Promise.resolve();
      },
      syncEventSubscription() {
        return true;
      },
      renderThreads() {},
      nowRef() {
        return 20000;
      },
      setTimeoutRef(callback, delayMs) {
        timers.push({ callback, delayMs });
        return timers.length;
      },
      clearTimeoutRef() {},
    });

    await module.setWorkspaceTarget("wsl2");

    expect(timers).toEqual([]);
    expect(refreshCalls).toEqual([
      { target: "wsl2", options: { force: false, silent: true } },
    ]);
  });

  it("refreshes canonical runtime state for the requested workspace", async () => {
    const updates = [];
    const state = {
      workspaceTarget: "windows",
      activeThreadWorkspace: "windows",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
      collapsedWorkspaceKeys: new Set(),
      collapsedWorkspaceKeysByWorkspace: { windows: new Set(), wsl2: new Set() },
      threadItemsByWorkspace: { windows: [], wsl2: [] },
      threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: false },
      threadListRenderSigByWorkspace: { windows: "", wsl2: "" },
      threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
      startCwdByWorkspace: { windows: "", wsl2: "" },
      threadItemsAll: [],
      threadItems: [],
      folderPickerOpen: false,
      workspaceRuntimeByTarget: {
        windows: {
          workspace: "windows",
          homeOverride: "",
          connected: false,
          connectedAtUnixSecs: null,
          lastReplayCursor: 0,
          lastReplayLastEventId: null,
          lastReplayAtUnixSecs: null,
          loaded: false,
          loading: false,
        },
      },
      workspaceRuntimeRefreshReqSeqByWorkspace: { windows: 0, wsl2: 0 },
    };
    const module = createWorkspaceUiModule({
      state,
      byId() {
        return null;
      },
      api(path) {
        updates.push(path);
        return Promise.resolve({
          workspace: "windows",
          connected: true,
          connectedAtUnixSecs: 7,
          lastReplayCursor: 8,
          lastReplayLastEventId: 9,
          lastReplayAtUnixSecs: 10,
        });
      },
      normalizeWorkspaceTarget(value) {
        return String(value || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
      },
      localStorageRef: { setItem() {} },
      WORKSPACE_TARGET_KEY: "workspace",
      START_CWD_BY_WORKSPACE_KEY: "cwd",
      detectThreadWorkspaceTarget() {
        return "unknown";
      },
      updateHeaderUi() {},
      renderFolderPicker() {},
      setStatus() {},
      pushThreadAnimDebug() {},
      isThreadListActuallyVisible() {
        return false;
      },
      buildThreadRenderSig() {
        return "";
      },
      applyThreadFilter() {},
      refreshThreads() {
        return Promise.resolve();
      },
      syncEventSubscription() {
        return true;
      },
      renderThreads() {},
    });

    const runtime = await module.refreshWorkspaceRuntimeState("windows", { silent: true });

    expect(updates).toEqual(["/codex/runtime/state?workspace=windows"]);
    expect(runtime).toMatchObject({
      workspace: "windows",
      connected: true,
      lastReplayCursor: 8,
    });
    expect(module.getWorkspaceRuntimeState("windows")).toMatchObject({
      connected: true,
      loaded: true,
    });
  });

  it("suppresses abort-like runtime refresh errors from the status line", async () => {
    const statuses = [];
    const state = {
      workspaceTarget: "windows",
      activeThreadWorkspace: "windows",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
      collapsedWorkspaceKeys: new Set(),
      collapsedWorkspaceKeysByWorkspace: { windows: new Set(), wsl2: new Set() },
      threadItemsByWorkspace: { windows: [], wsl2: [] },
      threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: false },
      threadListRenderSigByWorkspace: { windows: "", wsl2: "" },
      threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
      startCwdByWorkspace: { windows: "", wsl2: "" },
      threadItemsAll: [],
      threadItems: [],
      folderPickerOpen: false,
      workspaceRuntimeByTarget: {
        windows: {
          workspace: "windows",
          homeOverride: "",
          connected: false,
          connectedAtUnixSecs: null,
          lastReplayCursor: 0,
          lastReplayLastEventId: null,
          lastReplayAtUnixSecs: null,
          loaded: false,
          loading: false,
        },
      },
      workspaceRuntimeRefreshReqSeqByWorkspace: { windows: 0, wsl2: 0 },
    };
    const module = createWorkspaceUiModule({
      state,
      byId() {
        return null;
      },
      api() {
        return Promise.reject(new Error("signal is aborted without reason"));
      },
      normalizeWorkspaceTarget(value) {
        return String(value || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
      },
      localStorageRef: { setItem() {} },
      WORKSPACE_TARGET_KEY: "workspace",
      START_CWD_BY_WORKSPACE_KEY: "cwd",
      detectThreadWorkspaceTarget() {
        return "unknown";
      },
      updateHeaderUi() {},
      renderFolderPicker() {},
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      pushThreadAnimDebug() {},
      isThreadListActuallyVisible() {
        return false;
      },
      buildThreadRenderSig() {
        return "";
      },
      applyThreadFilter() {},
      refreshThreads() {
        return Promise.resolve();
      },
      syncEventSubscription() {
        return true;
      },
      renderThreads() {},
    });

    const runtime = await module.refreshWorkspaceRuntimeState("windows");

    expect(runtime).toBe(null);
    expect(statuses).toEqual([]);
  });

  it("recomputes active thread resume state from the current thread list", () => {
    const state = {
      workspaceTarget: "windows",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
      collapsedWorkspaceKeys: new Set(),
      collapsedWorkspaceKeysByWorkspace: { windows: new Set(), wsl2: new Set() },
      threadItemsByWorkspace: { windows: [], wsl2: [] },
      threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: false },
      threadListRenderSigByWorkspace: { windows: "", wsl2: "" },
      threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
      startCwdByWorkspace: { windows: "", wsl2: "" },
      threadItemsAll: [
        {
          id: "thread-1",
          workspace: "windows",
          path: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
          status: { type: "notLoaded" },
        },
      ],
      threadItems: [],
      folderPickerOpen: false,
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryIncomplete: false,
      activeThreadHistoryStatusType: "idle",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
      threadAttachTransportById: new Map(),
    };
    const module = createWorkspaceUiModule({
      state,
      byId() {
        return null;
      },
      api() {
        return Promise.resolve({});
      },
      normalizeWorkspaceTarget(value) {
        return String(value || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
      },
      localStorageRef: { setItem() {} },
      WORKSPACE_TARGET_KEY: "workspace",
      START_CWD_BY_WORKSPACE_KEY: "cwd",
      detectThreadWorkspaceTarget(thread) {
        return thread.workspace;
      },
      updateHeaderUi() {},
      renderFolderPicker() {},
      setStatus() {},
      pushThreadAnimDebug() {},
      isThreadListActuallyVisible() {
        return false;
      },
      buildThreadRenderSig() {
        return "";
      },
      applyThreadFilter() {},
      refreshThreads() {
        return Promise.resolve();
      },
      syncEventSubscription() {
        return true;
      },
      renderThreads() {},
    });

    module.syncActiveThreadMetaFromList();

    expect(state.activeThreadWorkspace).toBe("windows");
    expect(state.activeThreadRolloutPath).toBe("C:\\repo\\.codex\\sessions\\rollout.jsonl");
    expect(state.activeThreadOpenState.resumeRequired).toBe(false);
  });

  it("resolves thread open state canonically from a single decision function", () => {
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        threadStatusType: "notLoaded",
        historyThreadId: "thread-1",
        historyIncomplete: false,
        historyStatusType: "idle",
      })
    ).toMatchObject({
      threadId: "thread-1",
      resumeRequired: false,
      resumeReason: "history-complete",
    });
  });
});
