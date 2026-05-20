import { describe, expect, it, vi } from "vitest";

import {
  createCodexWebDiagnostics,
  normalizeCodexWebActivePage,
  shouldReportFrontendError,
} from "./webDiagnostics.js";

describe("webDiagnostics", () => {
  it("normalizes Codex Web active pages", () => {
    expect(normalizeCodexWebActivePage({ activeMainTab: "chat" })).toBe("codex-web");
    expect(normalizeCodexWebActivePage({ activeMainTab: "settings" })).toBe("codex-web:settings");
  });

  it("ignores generic cross-origin script errors", () => {
    expect(shouldReportFrontendError("Script error.")).toBe(false);
    expect(shouldReportFrontendError("Cannot read properties of undefined")).toBe(true);
  });

  it("posts heartbeat and API results to the gateway watchdog endpoint", async () => {
    const requests = [];
    const timers = [];
    const diagnostics = createCodexWebDiagnostics({
      state: {
        token: "test-token",
        activeMainTab: "settings",
        providerSwitchboardApplying: true,
      },
      windowRef: { addEventListener() {} },
      documentRef: { visibilityState: "visible" },
      fetchRef: async (path, options) => {
        requests.push({ path, body: JSON.parse(options.body), headers: options.headers });
        return { ok: true };
      },
      requestAnimationFrameRef: null,
      PerformanceObserverRef: null,
      setTimeoutRef: vi.fn((fn) => {
        timers.push(fn);
        return timers.length;
      }),
      clearTimeoutRef: vi.fn(),
      setIntervalRef: vi.fn(),
      clearIntervalRef: vi.fn(),
      nowRef: () => 1000,
    });

    diagnostics.install();
    diagnostics.recordApiResult({
      command: "GET /codex/threads",
      elapsedMs: 25,
      ok: true,
    });
    await diagnostics.flush();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      path: "/codex/ui-diagnostics",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(requests[0].body.heartbeat).toMatchObject({
      activePage: "codex-web:settings",
      providerSwitchInFlight: true,
    });
    expect(requests[1].body.invokeResults[0]).toMatchObject({
      command: "GET /codex/threads",
      elapsedMs: 25,
      ok: true,
      activePage: "codex-web:settings",
    });
  });

  it("posts slow local UI tasks to the gateway watchdog endpoint", async () => {
    const requests = [];
    const timers = [];
    const diagnostics = createCodexWebDiagnostics({
      state: {
        token: "test-token",
        activeMainTab: "chat",
      },
      windowRef: { addEventListener() {} },
      documentRef: { visibilityState: "visible" },
      fetchRef: async (path, options) => {
        requests.push({ path, body: JSON.parse(options.body), headers: options.headers });
        return { ok: true };
      },
      requestAnimationFrameRef: null,
      PerformanceObserverRef: null,
      setTimeoutRef: vi.fn((fn) => {
        timers.push(fn);
        return timers.length;
      }),
      clearTimeoutRef: vi.fn(),
      setIntervalRef: vi.fn(),
      clearIntervalRef: vi.fn(),
      nowRef: () => 1000,
      localTaskThresholdMs: 10,
    });

    diagnostics.recordLocalTask({
      command: "thread list render",
      elapsedMs: 38,
      fields: { sourceCount: 116, workspace: "windows" },
    });
    await diagnostics.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0].body.localTasks[0]).toMatchObject({
      command: "thread list render",
      elapsedMs: 38,
      activePage: "codex-web",
      fields: { sourceCount: 116, workspace: "windows" },
    });
  });

  it("retries queued diagnostics after a failed flush instead of dropping them", async () => {
    const requests = [];
    let shouldFail = true;
    const diagnostics = createCodexWebDiagnostics({
      state: {
        token: "test-token",
        activeMainTab: "chat",
      },
      windowRef: { addEventListener() {} },
      documentRef: { visibilityState: "visible" },
      fetchRef: async (_path, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        if (shouldFail) throw new Error("network down");
        return { ok: true };
      },
      requestAnimationFrameRef: null,
      PerformanceObserverRef: null,
      setTimeoutRef: vi.fn(),
      clearTimeoutRef: vi.fn(),
      setIntervalRef: vi.fn(),
      clearIntervalRef: vi.fn(),
      nowRef: () => 1000,
      localTaskThresholdMs: 10,
    });

    diagnostics.recordLocalTask({
      command: "thread list render",
      elapsedMs: 38,
      fields: { sourceCount: 116, workspace: "windows" },
    });

    await diagnostics.flush();
    shouldFail = false;
    await diagnostics.flush();

    expect(requests).toHaveLength(2);
    expect(requests[0].localTasks).toEqual([
      expect.objectContaining({
        command: "thread list render",
        elapsedMs: 38,
      }),
    ]);
    expect(requests[1].localTasks).toEqual([
      expect.objectContaining({
        command: "thread list render",
        elapsedMs: 38,
      }),
    ]);
  });

  it("does not duplicate or drop queued diagnostics across overlapping flushes", async () => {
    const requests = [];
    const resolvers = [];
    const diagnostics = createCodexWebDiagnostics({
      state: {
        token: "test-token",
        activeMainTab: "chat",
      },
      windowRef: { addEventListener() {} },
      documentRef: { visibilityState: "visible" },
      fetchRef: (_path, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return new Promise((resolve) => {
          resolvers.push(() => resolve({ ok: true }));
        });
      },
      requestAnimationFrameRef: null,
      PerformanceObserverRef: null,
      setTimeoutRef: vi.fn(),
      clearTimeoutRef: vi.fn(),
      setIntervalRef: vi.fn(),
      clearIntervalRef: vi.fn(),
      nowRef: () => 1000,
      localTaskThresholdMs: 10,
    });

    diagnostics.recordLocalTask({
      command: "first event",
      elapsedMs: 38,
      fields: { order: 1 },
    });

    const firstFlush = diagnostics.flush();
    const overlappingFlush = diagnostics.flush();

    diagnostics.recordLocalTask({
      command: "second event",
      elapsedMs: 41,
      fields: { order: 2 },
    });

    resolvers.shift()();
    await Promise.resolve();
    await Promise.resolve();
    resolvers.shift()();
    await firstFlush;
    await overlappingFlush;
    await diagnostics.flush();

    expect(requests).toHaveLength(2);
    expect(requests[0].localTasks).toEqual([
      expect.objectContaining({
        command: "first event",
        elapsedMs: 38,
      }),
    ]);
    expect(requests[1].localTasks).toEqual([
      expect.objectContaining({
        command: "second event",
        elapsedMs: 41,
      }),
    ]);
  });

  it("keeps monitoring frames after scroll-like interactions", async () => {
    const requests = [];
    const timers = [];
    const listeners = {};
    const rafCallbacks = [];
    let now = 1000;
    const diagnostics = createCodexWebDiagnostics({
      state: {
        token: "test-token",
        activeMainTab: "chat",
      },
      windowRef: {
        addEventListener(name, handler) {
          listeners[name] = handler;
        },
      },
      documentRef: { visibilityState: "visible" },
      fetchRef: async (path, options) => {
        requests.push({ path, body: JSON.parse(options.body), headers: options.headers });
        return { ok: true };
      },
      requestAnimationFrameRef: vi.fn((fn) => {
        rafCallbacks.push(fn);
        return rafCallbacks.length;
      }),
      PerformanceObserverRef: null,
      setTimeoutRef: vi.fn((fn) => {
        timers.push(fn);
        return timers.length;
      }),
      clearTimeoutRef: vi.fn(),
      setIntervalRef: vi.fn(),
      clearIntervalRef: vi.fn(),
      nowRef: () => now,
      frameStallThresholdMs: 50,
      interactionSampleCooldownMs: 0,
      interactionMonitorWindowMs: 1000,
    });

    diagnostics.install();
    requests.length = 0;
    listeners.wheel();
    expect(rafCallbacks).toHaveLength(2);

    now += 80;
    rafCallbacks.shift()();
    now += 80;
    rafCallbacks.shift()();
    await diagnostics.flush();

    expect(requests.at(-1).body.frameStalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activePage: "codex-web",
          elapsedMs: 160,
          monitorKind: "interaction",
        }),
      ])
    );
    expect(rafCallbacks.length).toBeGreaterThan(0);
  });

  it("includes the current UI activity when reporting an interaction stall", async () => {
    const requests = [];
    const listeners = {};
    const rafCallbacks = [];
    let now = 1000;
    const windowRef = {
      __API_ROUTER_UI_ACTIVITY_STACK__: [
        {
          kind: "history.load.fetch",
          fields: { threadId: "thread-1", workspace: "windows" },
          startedAtUnixMs: 850,
        },
      ],
      addEventListener(name, handler) {
        listeners[name] = handler;
      },
    };
    const diagnostics = createCodexWebDiagnostics({
      state: {
        token: "test-token",
        activeMainTab: "chat",
      },
      windowRef,
      documentRef: { visibilityState: "visible" },
      fetchRef: async (path, options) => {
        requests.push({ path, body: JSON.parse(options.body), headers: options.headers });
        return { ok: true };
      },
      requestAnimationFrameRef: vi.fn((fn) => {
        rafCallbacks.push(fn);
        return rafCallbacks.length;
      }),
      PerformanceObserverRef: null,
      setTimeoutRef: vi.fn(),
      clearTimeoutRef: vi.fn(),
      setIntervalRef: vi.fn(),
      clearIntervalRef: vi.fn(),
      nowRef: () => now,
      frameStallThresholdMs: 50,
      interactionSampleCooldownMs: 0,
      interactionMonitorWindowMs: 1000,
    });

    diagnostics.install();
    requests.length = 0;
    listeners.pointerdown();

    now += 100;
    rafCallbacks[1]();
    await diagnostics.flush();

    expect(requests.at(-1).body.frameStalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activePage: "codex-web",
          elapsedMs: 100,
          monitorKind: "interaction",
          activityKind: "history.load.fetch",
          activityFields: { threadId: "thread-1", workspace: "windows" },
          activityAgeMs: 250,
          activityDepth: 1,
        }),
      ])
    );
  });

  it("falls back to the last interaction context when no UI activity is active", async () => {
    const requests = [];
    const listeners = {};
    const rafCallbacks = [];
    let now = 1000;
    const diagnostics = createCodexWebDiagnostics({
      state: {
        token: "test-token",
        activeMainTab: "chat",
      },
      windowRef: {
        addEventListener(name, handler) {
          listeners[name] = handler;
        },
      },
      documentRef: {
        visibilityState: "visible",
        hasFocus() {
          return true;
        },
      },
      fetchRef: async (path, options) => {
        requests.push({ path, body: JSON.parse(options.body), headers: options.headers });
        return { ok: true };
      },
      requestAnimationFrameRef: vi.fn((fn) => {
        rafCallbacks.push(fn);
        return rafCallbacks.length;
      }),
      PerformanceObserverRef: null,
      setTimeoutRef: vi.fn(),
      clearTimeoutRef: vi.fn(),
      setIntervalRef: vi.fn(),
      clearIntervalRef: vi.fn(),
      nowRef: () => now,
      frameStallThresholdMs: 50,
      interactionSampleCooldownMs: 0,
      interactionMonitorWindowMs: 1000,
    });

    diagnostics.install();
    requests.length = 0;
    listeners.pointerdown();

    now += 90;
    rafCallbacks[1]();
    await diagnostics.flush();

    expect(requests.at(-1).body.frameStalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activePage: "codex-web",
          elapsedMs: 90,
          monitorKind: "interaction",
          activityKind: "interaction.pointerdown",
          activityDepth: 1,
          activityFields: expect.objectContaining({
            source: "last_interaction",
            eventType: "pointerdown",
            ageMs: 90,
            visible: true,
            hasFocus: true,
          }),
        }),
      ])
    );
  });

  it("captures visible sub-second animation jank by default", async () => {
    const requests = [];
    const listeners = {};
    const rafCallbacks = [];
    let now = 1000;
    const diagnostics = createCodexWebDiagnostics({
      state: {
        token: "test-token",
        activeMainTab: "chat",
      },
      windowRef: {
        addEventListener(name, handler) {
          listeners[name] = handler;
        },
      },
      documentRef: { visibilityState: "visible" },
      fetchRef: async (path, options) => {
        requests.push({ path, body: JSON.parse(options.body), headers: options.headers });
        return { ok: true };
      },
      requestAnimationFrameRef: vi.fn((fn) => {
        rafCallbacks.push(fn);
        return rafCallbacks.length;
      }),
      PerformanceObserverRef: null,
      setTimeoutRef: vi.fn(),
      clearTimeoutRef: vi.fn(),
      setIntervalRef: vi.fn(),
      clearIntervalRef: vi.fn(),
      nowRef: () => now,
      interactionSampleCooldownMs: 0,
      interactionMonitorWindowMs: 1000,
    });

    diagnostics.install();
    requests.length = 0;
    listeners.pointerdown();
    now += 100;
    rafCallbacks.shift()();
    await diagnostics.flush();

    expect(requests.at(-1).body.frameStalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activePage: "codex-web",
          elapsedMs: 100,
          monitorKind: "startup",
        }),
      ])
    );
  });
});
