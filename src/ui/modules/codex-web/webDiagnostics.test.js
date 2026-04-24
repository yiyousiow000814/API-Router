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
});
