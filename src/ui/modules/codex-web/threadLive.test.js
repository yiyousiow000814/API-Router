import { describe, expect, it } from "vitest";

import {
  createThreadLiveModule,
  resolveActiveThreadLivePollInterval,
  resolveThreadAutoRefreshInterval,
  resolveThreadAutoRefreshTargets,
  shouldPollActiveThreadLive,
} from "./threadLive.js";

describe("threadLive", () => {
  it("prefers connected interval only when ws is open and subscribed", () => {
    expect(resolveThreadAutoRefreshInterval(true, true, 20000, 3500)).toBe(20000);
    expect(resolveThreadAutoRefreshInterval(true, false, 20000, 3500)).toBe(3500);
    expect(resolveThreadAutoRefreshInterval(false, true, 20000, 3500)).toBe(3500);
  });

  it("refreshes both workspace buckets when available", () => {
    expect(
      resolveThreadAutoRefreshTargets("windows", {
        windowsInstalled: true,
        wsl2Installed: true,
      })
    ).toEqual(["windows", "wsl2"]);
    expect(
      resolveThreadAutoRefreshTargets("wsl2", {
        windowsInstalled: true,
        wsl2Installed: true,
      })
    ).toEqual(["wsl2", "windows"]);
    expect(
      resolveThreadAutoRefreshTargets("windows", {
        windowsInstalled: true,
        wsl2Installed: false,
      })
    ).toEqual(["windows"]);
  });

  it("keeps polling an opened active thread so external terminal turns can appear without refresh", () => {
    expect(
      shouldPollActiveThreadLive({
        threadId: "thread-1",
        activeMainTab: "chat",
        activeThreadStarted: true,
        activeThreadHistoryIncomplete: false,
        activeThreadPendingTurnRunning: false,
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadOpenState: { resumeRequired: false, loaded: false },
      })
    ).toBe(true);
  });

  it("polls active thread history only when chat is active and runtime is still unfinished", () => {
    expect(
      shouldPollActiveThreadLive({
        threadId: "thread-1",
        activeMainTab: "chat",
        activeThreadStarted: true,
        activeThreadHistoryIncomplete: true,
        activeThreadPendingTurnRunning: false,
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadOpenState: { resumeRequired: false, loaded: false },
      })
    ).toBe(true);
    expect(
      shouldPollActiveThreadLive({
        threadId: "",
        activeMainTab: "chat",
        activeThreadStarted: true,
        activeThreadHistoryIncomplete: true,
        activeThreadPendingTurnRunning: false,
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadOpenState: { resumeRequired: false, loaded: false },
      })
    ).toBe(false);
    expect(
      shouldPollActiveThreadLive({
        threadId: "thread-1",
        activeMainTab: "settings",
        activeThreadStarted: true,
        activeThreadHistoryIncomplete: true,
        activeThreadPendingTurnRunning: false,
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadOpenState: { resumeRequired: false, loaded: false },
      })
    ).toBe(false);
    expect(
      shouldPollActiveThreadLive({
        threadId: "thread-1",
        activeMainTab: "chat",
        activeThreadStarted: false,
        activeThreadHistoryIncomplete: true,
        activeThreadPendingTurnRunning: false,
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadOpenState: { resumeRequired: false, loaded: false },
      })
    ).toBe(true);
  });

  it("uses a slower fallback interval when ws is already subscribed", () => {
    expect(resolveActiveThreadLivePollInterval(1500, 3000, false, false)).toBe(1500);
    expect(resolveActiveThreadLivePollInterval(1500, 3000, true, false)).toBe(1500);
    expect(resolveActiveThreadLivePollInterval(1500, 3000, true, true)).toBe(3000);
    expect(resolveActiveThreadLivePollInterval(1500, 0, true, true)).toBe(0);
    expect(resolveActiveThreadLivePollInterval(0, 3000, true, true)).toBe(0);
  });

  it("polls an opened active thread even after completion so terminal-only follow-ups surface", async () => {
    const callbacks = [];
    const loadCalls = [];
    let now = 10_000;
    const realNow = Date.now;
    Date.now = () => now;
    const module = createThreadLiveModule({
      state: {
        activeThreadId: "thread-1",
        activeMainTab: "chat",
        activeThreadStarted: true,
        ws: { readyState: 1 },
        wsSubscribedEvents: true,
        activeThreadHistoryIncomplete: false,
        activeThreadPendingTurnRunning: false,
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadOpenState: { resumeRequired: false, loaded: false },
        activeThreadLiveLastPollMs: 0,
        activeThreadLivePolling: false,
        activeThreadWorkspace: "windows",
        activeThreadRolloutPath: "",
      },
      byId() { return null; },
      waitMs: async () => {},
      setStatus() {},
      refreshThreads: async () => {},
      getWorkspaceTarget() { return "windows"; },
      loadThreadMessages: async (...args) => { loadCalls.push(args); },
      THREAD_PULL_REFRESH_TRIGGER_PX: 44,
      THREAD_PULL_REFRESH_MAX_PX: 84,
      THREAD_PULL_REFRESH_MIN_MS: 520,
      THREAD_PULL_HINT_CLEAR_DELAY_MS: 160,
      THREAD_AUTO_REFRESH_CONNECTED_MS: 20000,
      THREAD_AUTO_REFRESH_DISCONNECTED_MS: 3500,
      ACTIVE_THREAD_LIVE_POLL_MS: 1500,
      ACTIVE_THREAD_LIVE_POLL_WS_FALLBACK_MS: 3000,
      WebSocketRef: { OPEN: 1 },
      setIntervalRef(callback) {
        callbacks.push(callback);
        return 1;
      },
    });

    try {
      module.startActiveThreadLivePollLoop();
      await callbacks[0]();
      expect(loadCalls).toHaveLength(1);

      now += 2_000;
      await callbacks[0]();
      expect(loadCalls).toHaveLength(1);

      now += 1_001;
      await callbacks[0]();
      expect(loadCalls).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("slows incomplete active-thread polling when ws is already subscribed", async () => {
    const callbacks = [];
    const loadCalls = [];
    let now = 10_000;
    const realNow = Date.now;
    Date.now = () => now;
    const module = createThreadLiveModule({
      state: {
        activeThreadId: "thread-1",
        activeMainTab: "chat",
        activeThreadStarted: true,
        ws: { readyState: 1 },
        wsSubscribedEvents: true,
        activeThreadHistoryIncomplete: true,
        activeThreadPendingTurnRunning: false,
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadOpenState: { resumeRequired: false, loaded: false },
        activeThreadLiveLastPollMs: 0,
        activeThreadLivePolling: false,
        activeThreadWorkspace: "windows",
        activeThreadRolloutPath: "",
      },
      byId() { return null; },
      waitMs: async () => {},
      setStatus() {},
      refreshThreads: async () => {},
      getWorkspaceTarget() { return "windows"; },
      loadThreadMessages: async (...args) => { loadCalls.push(args); },
      THREAD_PULL_REFRESH_TRIGGER_PX: 44,
      THREAD_PULL_REFRESH_MAX_PX: 84,
      THREAD_PULL_REFRESH_MIN_MS: 520,
      THREAD_PULL_HINT_CLEAR_DELAY_MS: 160,
      THREAD_AUTO_REFRESH_CONNECTED_MS: 20000,
      THREAD_AUTO_REFRESH_DISCONNECTED_MS: 3500,
      ACTIVE_THREAD_LIVE_POLL_MS: 1500,
      ACTIVE_THREAD_LIVE_POLL_WS_FALLBACK_MS: 3000,
      WebSocketRef: { OPEN: 1 },
      setIntervalRef(callback) {
        callbacks.push(callback);
        return 1;
      },
    });

    try {
      module.startActiveThreadLivePollLoop();
      await callbacks[0]();
      expect(loadCalls).toHaveLength(1);

      now += 2_000;
      await callbacks[0]();
      expect(loadCalls).toHaveLength(1);

      now += 1_001;
      await callbacks[0]();
      expect(loadCalls).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("does not poll live history for a brand new empty chat", async () => {
    const callbacks = [];
    const loadCalls = [];
    const module = createThreadLiveModule({
      state: {
        activeThreadId: "thread-1",
        activeMainTab: "chat",
        activeThreadStarted: false,
        ws: { readyState: 0 },
        wsSubscribedEvents: false,
        activeThreadHistoryIncomplete: false,
        activeThreadPendingTurnRunning: false,
        activeThreadPendingUserMessage: "",
        activeThreadPendingAssistantMessage: "",
        activeThreadOpenState: { resumeRequired: false, loaded: false },
        activeThreadLiveLastPollMs: 0,
        activeThreadLivePolling: false,
        activeThreadWorkspace: "windows",
        activeThreadRolloutPath: "",
      },
      byId() { return null; },
      waitMs: async () => {},
      setStatus() {},
      refreshThreads: async () => {},
      getWorkspaceTarget() { return "windows"; },
      loadThreadMessages: async (...args) => { loadCalls.push(args); },
      THREAD_PULL_REFRESH_TRIGGER_PX: 44,
      THREAD_PULL_REFRESH_MAX_PX: 84,
      THREAD_PULL_REFRESH_MIN_MS: 520,
      THREAD_PULL_HINT_CLEAR_DELAY_MS: 160,
      THREAD_AUTO_REFRESH_CONNECTED_MS: 20000,
      THREAD_AUTO_REFRESH_DISCONNECTED_MS: 3500,
      ACTIVE_THREAD_LIVE_POLL_MS: 1500,
      WebSocketRef: { OPEN: 1 },
      setIntervalRef(callback) {
        callbacks.push(callback);
        return 1;
      },
    });

    module.startActiveThreadLivePollLoop();
    await callbacks[0]();

    expect(loadCalls).toHaveLength(0);
  });

  it("retries codex version detection during auto refresh when a workspace is unavailable", async () => {
    const callbacks = [];
    const refreshVersionCalls = [];
    const refreshThreadCalls = [];
    let now = 10_000;
    const realNow = Date.now;
    Date.now = () => now;
    const module = createThreadLiveModule({
      state: {
        workspaceAvailability: { windowsInstalled: true, wsl2Installed: false },
        codexVersionRefreshLastMs: 0,
        codexVersionRefreshInFlight: false,
        threadAutoRefreshInFlight: false,
        threadRefreshAbortByWorkspace: { windows: null, wsl2: null },
        threadAutoRefreshLastMsByWorkspace: { windows: 0, wsl2: 0 },
        ws: { readyState: 1 },
        wsSubscribedEvents: true,
      },
      byId() {
        return null;
      },
      waitMs: async () => {},
      setStatus() {},
      refreshThreads: async (...args) => {
        refreshThreadCalls.push(args);
      },
      refreshCodexVersions: async () => {
        refreshVersionCalls.push(Date.now());
      },
      getWorkspaceTarget() {
        return "windows";
      },
      loadThreadMessages: async () => {},
      THREAD_PULL_REFRESH_TRIGGER_PX: 44,
      THREAD_PULL_REFRESH_MAX_PX: 84,
      THREAD_PULL_REFRESH_MIN_MS: 520,
      THREAD_PULL_HINT_CLEAR_DELAY_MS: 160,
      THREAD_AUTO_REFRESH_CONNECTED_MS: 20000,
      THREAD_AUTO_REFRESH_DISCONNECTED_MS: 3500,
      ACTIVE_THREAD_LIVE_POLL_MS: 1500,
      WebSocketRef: { OPEN: 1 },
      setIntervalRef(callback) {
        callbacks.push(callback);
        return 1;
      },
    });

    try {
      module.startThreadAutoRefreshLoop();
      await callbacks[0]();
      expect(refreshVersionCalls).toHaveLength(0);
      expect(refreshThreadCalls).toHaveLength(0);

      now += 20_001;
      await callbacks[0]();
      expect(refreshVersionCalls).toHaveLength(1);
      expect(refreshThreadCalls).toHaveLength(1);

      now += 1_000;
      await callbacks[0]();
      expect(refreshVersionCalls).toHaveLength(1);
      expect(refreshThreadCalls).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("auto refreshes both windows and wsl thread lists when both are available", async () => {
    const callbacks = [];
    const refreshThreadCalls = [];
    let now = 10_000;
    const realNow = Date.now;
    Date.now = () => now;
    const module = createThreadLiveModule({
      state: {
        workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
        codexVersionRefreshLastMs: 0,
        codexVersionRefreshInFlight: false,
        threadAutoRefreshInFlight: false,
        threadRefreshAbortByWorkspace: { windows: null, wsl2: null },
        threadAutoRefreshLastMsByWorkspace: { windows: 0, wsl2: 0 },
        ws: { readyState: 1 },
        wsSubscribedEvents: true,
      },
      byId() {
        return null;
      },
      waitMs: async () => {},
      setStatus() {},
      refreshThreads: async (...args) => {
        refreshThreadCalls.push(args);
      },
      refreshCodexVersions: async () => {},
      getWorkspaceTarget() {
        return "windows";
      },
      loadThreadMessages: async () => {},
      THREAD_PULL_REFRESH_TRIGGER_PX: 44,
      THREAD_PULL_REFRESH_MAX_PX: 84,
      THREAD_PULL_REFRESH_MIN_MS: 520,
      THREAD_PULL_HINT_CLEAR_DELAY_MS: 160,
      THREAD_AUTO_REFRESH_CONNECTED_MS: 20000,
      THREAD_AUTO_REFRESH_DISCONNECTED_MS: 3500,
      ACTIVE_THREAD_LIVE_POLL_MS: 1500,
      WebSocketRef: { OPEN: 1 },
      setIntervalRef(callback) {
        callbacks.push(callback);
        return 1;
      },
    });

    try {
      module.startThreadAutoRefreshLoop();
      await callbacks[0]();
      expect(refreshThreadCalls).toHaveLength(0);

      now += 20_001;
      await callbacks[0]();
      expect(refreshThreadCalls).toHaveLength(2);
      expect(refreshThreadCalls.map((call) => call[0])).toEqual([
        "windows",
        "wsl2",
      ]);
    } finally {
      Date.now = realNow;
    }
  });
});
