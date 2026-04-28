import { describe, expect, it } from "vitest";

import {
  createAppPersistenceModule,
  relativeTimeLabel,
  shouldApplyVersionAvailabilityPayload,
  truncateLabel,
} from "./appPersistence.js";

describe("appPersistence", () => {
  it("truncates labels with ellipsis", () => {
    expect(truncateLabel("123456", 5)).toBe("1234...");
  });

  it("formats relative time labels", () => {
    expect(relativeTimeLabel(Date.now() - 2 * 86400 * 1000)).toBe("2d");
  });

  it("uses local calendar days for today labels instead of rolling 24 hours", () => {
    const realNow = Date.now;
    Date.now = () => new Date("2026-03-25T10:00:00+08:00").getTime();
    try {
      expect(relativeTimeLabel("2026-03-25T00:30:00+08:00")).toBe("today");
      expect(relativeTimeLabel("2026-03-24T23:50:00+08:00")).toBe("1d");
    } finally {
      Date.now = realNow;
    }
  });

  it("does not apply provisional detecting version availability", () => {
    expect(
      shouldApplyVersionAvailabilityPayload({
        windows: "Detecting",
        wsl2: "Detecting",
        windowsInstalled: false,
        wsl2Installed: false,
      })
    ).toBe(false);
    expect(
      shouldApplyVersionAvailabilityPayload({
        windows: "codex-cli 1.0.0",
        wsl2: "Not installed",
        windowsInstalled: true,
        wsl2Installed: false,
      })
    ).toBe(true);
  });

  it("coalesces concurrent version refreshes into one API request", async () => {
    let resolveVersion;
    const versionResponse = new Promise((resolve) => {
      resolveVersion = resolve;
    });
    const apiCalls = [];
    const nodes = {
      windowsCodexVersion: {
        textContent: "",
        classList: { add() {}, remove() {} },
        get offsetWidth() { return 1; },
      },
      wslCodexVersion: {
        textContent: "",
        classList: { add() {}, remove() {} },
        get offsetWidth() { return 1; },
      },
    };
    const module = createAppPersistenceModule({
      state: {},
      byId: (id) => nodes[id] || null,
      api(path) {
        apiCalls.push(path);
        return versionResponse;
      },
      setStatus: () => {},
      updateWorkspaceAvailability: () => {},
      getEmbeddedToken: () => "",
      ensureArrayItems: (value) => (Array.isArray(value) ? value : []),
      normalizeModelOption: (item) => item,
      pickLatestModelId: () => "",
      buildThreadRenderSig: () => "",
      sortThreadsByNewest: (items) => items,
      isThreadListActuallyVisible: () => false,
      MODELS_CACHE_KEY: "models",
      THREADS_CACHE_KEY: "threads",
      REASONING_EFFORT_KEY: "effort",
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      documentRef: {},
    });

    const first = module.refreshCodexVersions();
    const second = module.refreshCodexVersions();
    await Promise.resolve();
    expect(apiCalls).toEqual(["/codex/version-info"]);

    resolveVersion({
      windows: "codex-cli 1.0.0",
      wsl2: "codex-cli 1.0.0",
      windowsInstalled: true,
      wsl2Installed: true,
    });
    await Promise.all([first, second]);
    expect(nodes.windowsCodexVersion.textContent).toBe("codex-cli 1.0.0");
    expect(nodes.wslCodexVersion.textContent).toBe("codex-cli 1.0.0");
  });
});
