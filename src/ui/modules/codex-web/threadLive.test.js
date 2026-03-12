import { describe, expect, it } from "vitest";

import {
  createThreadLiveModule,
  resolveActiveThreadLivePollInterval,
  resolveThreadAutoRefreshInterval,
  shouldPollActiveThreadLive,
} from "./threadLive.js";

describe("threadLive", () => {
  it("prefers connected interval only when ws is open and subscribed", () => {
    expect(resolveThreadAutoRefreshInterval(true, true, 20000, 3500)).toBe(20000);
    expect(resolveThreadAutoRefreshInterval(true, false, 20000, 3500)).toBe(3500);
    expect(resolveThreadAutoRefreshInterval(false, true, 20000, 3500)).toBe(3500);
  });

  it("keeps polling active thread history while ws live updates are subscribed", () => {
    expect(
      shouldPollActiveThreadLive({
        threadId: "thread-1",
        activeMainTab: "chat",
        wsReadyState: 1,
        wsSubscribed: true,
        webSocketOpenValue: 1,
      })
    ).toBe(true);
  });

  it("polls active thread history only when chat is active and ws live updates are unavailable", () => {
    expect(
      shouldPollActiveThreadLive({
        threadId: "thread-1",
        activeMainTab: "chat",
        wsReadyState: 0,
        wsSubscribed: false,
        webSocketOpenValue: 1,
      })
    ).toBe(true);
    expect(
      shouldPollActiveThreadLive({
        threadId: "",
        activeMainTab: "chat",
        wsReadyState: 0,
        wsSubscribed: false,
        webSocketOpenValue: 1,
      })
    ).toBe(false);
    expect(
      shouldPollActiveThreadLive({
        threadId: "thread-1",
        activeMainTab: "settings",
        wsReadyState: 0,
        wsSubscribed: false,
        webSocketOpenValue: 1,
      })
    ).toBe(false);
  });

  it("keeps the fast live poll interval for incomplete threads even when ws is subscribed", () => {
    expect(resolveActiveThreadLivePollInterval(true, true, 1500, 3000)).toBe(1500);
    expect(resolveActiveThreadLivePollInterval(true, false, 1500, 3000)).toBe(3000);
    expect(resolveActiveThreadLivePollInterval(false, true, 1500, 3000)).toBe(1500);
  });

  it("uses the ws fallback polling interval when ws is subscribed", async () => {
    const callbacks = [];
    const loadCalls = [];
    let now = 10_000;
    const realNow = Date.now;
    Date.now = () => now;
    const module = createThreadLiveModule({
      state: {
        activeThreadId: "thread-1",
        activeMainTab: "chat",
        ws: { readyState: 1 },
        wsSubscribedEvents: true,
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

      now += 1_100;
      await callbacks[0]();
      expect(loadCalls).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("does not slow incomplete active-thread polling just because ws is subscribed", async () => {
    const callbacks = [];
    const loadCalls = [];
    let now = 10_000;
    const realNow = Date.now;
    Date.now = () => now;
    const module = createThreadLiveModule({
      state: {
        activeThreadId: "thread-1",
        activeMainTab: "chat",
        ws: { readyState: 1 },
        wsSubscribedEvents: true,
        activeThreadHistoryIncomplete: true,
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
      expect(loadCalls).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });
});
