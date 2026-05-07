import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAppPersistenceModule,
  relativeTimeLabel,
  shouldApplyVersionAvailabilityPayload,
  truncateLabel,
} from "./appPersistence.js";

describe("appPersistence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("renders visible attachment pills with kind and file name", () => {
    const children = [];
    const box = {
      innerHTML: "",
      attrs: {},
      hidden: false,
      appendChild(node) {
        children.push(node);
      },
      setAttribute(key, value) {
        this.attrs[key] = value;
      },
      toggleAttribute(key, force) {
        this[key] = !!force;
      },
    };
    const createElement = (tagName) => ({
      tagName,
      className: "",
      textContent: "",
      title: "",
      attrs: {},
      children: [],
      setAttribute(key, value) {
        this.attrs[key] = value;
      },
      appendChild(node) {
        this.children.push(node);
      },
    });
    const module = createAppPersistenceModule({
      state: {},
      byId: (id) => (id === "attachmentPills" ? box : null),
      api: async () => ({}),
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
      CODEX_VERSION_CACHE_KEY: "versions",
      THREADS_CACHE_KEY: "threads",
      REASONING_EFFORT_KEY: "effort",
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      documentRef: { createElement },
    });

    module.renderAttachmentPills([{ kind: "image", fileName: "screen.png" }]);

    expect(box.hidden).toBe(false);
    expect(box.attrs["aria-live"]).toBe("polite");
    expect(box.attrs["aria-label"]).toBe("1 attachment ready");
    expect(children).toHaveLength(1);
    expect(children[0].className).toContain("attachmentPill");
    expect(children[0].children[0].className).toBe("attachmentPillPreview");
    expect(children[0].children[0].attrs["data-attachment-action"]).toBe("preview");
    expect(children[0].children[0].children[0].textContent).toBe("IMG");
    expect(children[0].children[0].children[1].textContent).toBe("screen.png");
    expect(children[0].children[1].className).toBe("attachmentPillRemove");
    expect(children[0].children[1].attrs["data-attachment-action"]).toBe("remove");
  });

  it("restores version info from local cache without calling the API", () => {
    const apiCalls = [];
    const availabilityUpdates = [];
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
    const state = {};
    const module = createAppPersistenceModule({
      state,
      byId: (id) => nodes[id] || null,
      api(path) {
        apiCalls.push(path);
        return Promise.resolve({});
      },
      setStatus: () => {},
      updateWorkspaceAvailability(...args) {
        availabilityUpdates.push(args);
      },
      getEmbeddedToken: () => "",
      ensureArrayItems: (value) => (Array.isArray(value) ? value : []),
      normalizeModelOption: (item) => item,
      pickLatestModelId: () => "",
      buildThreadRenderSig: () => "",
      sortThreadsByNewest: (items) => items,
      isThreadListActuallyVisible: () => false,
      MODELS_CACHE_KEY: "models",
      CODEX_VERSION_CACHE_KEY: "versions",
      THREADS_CACHE_KEY: "threads",
      REASONING_EFFORT_KEY: "effort",
      localStorageRef: {
        getItem(key) {
          if (key !== "versions") return "";
          return JSON.stringify({
            value: {
              windows: "codex-cli 1.2.3",
              wsl2: "codex-cli 1.2.4",
              windowsInstalled: true,
              wsl2Installed: true,
            },
            updatedAt: 1777379704000,
          });
        },
        setItem() {},
      },
      documentRef: {},
    });

    expect(module.restoreCodexVersionCache()).toBe(true);
    expect(apiCalls).toEqual([]);
    expect(nodes.windowsCodexVersion.textContent).toBe("codex-cli 1.2.3");
    expect(nodes.wslCodexVersion.textContent).toBe("codex-cli 1.2.4");
    expect(availabilityUpdates).toEqual([[true, true]]);
    expect(state.codexVersionInfoRestoredFromCache).toBe(true);
    expect(state.codexVersionInfoUpdatedAt).toBe(1777379704000);
  });

  it("clears model loading state when model cache is restored", () => {
    const state = {
      modelOptions: [],
      modelOptionsLoading: true,
      selectedModel: "",
      selectedReasoningEffort: "",
    };
    const module = createAppPersistenceModule({
      state,
      byId: () => null,
      api: async () => ({}),
      setStatus: () => {},
      updateWorkspaceAvailability: () => {},
      getEmbeddedToken: () => "",
      ensureArrayItems: (value) => (Array.isArray(value) ? value : []),
      normalizeModelOption: (item) => item,
      pickLatestModelId: (items) => items[0]?.id || "",
      buildThreadRenderSig: () => "",
      sortThreadsByNewest: (items) => items,
      isThreadListActuallyVisible: () => false,
      MODELS_CACHE_KEY: "models",
      CODEX_VERSION_CACHE_KEY: "versions",
      THREADS_CACHE_KEY: "threads",
      REASONING_EFFORT_KEY: "effort",
      localStorageRef: {
        getItem(key) {
          if (key !== "models") return "";
          return JSON.stringify({
            items: [{ id: "gpt-5", supportedReasoningEfforts: [{ effort: "medium" }] }],
          });
        },
        setItem() {},
      },
      documentRef: {},
    });

    expect(module.restoreModelsCache()).toBe(true);
    expect(state.modelOptionsLoading).toBe(false);
    expect(state.selectedModel).toBe("gpt-5");
  });

  it("defers and coalesces thread cache writes off the current interaction turn", () => {
    vi.useFakeTimers();
    const writes = [];
    const state = {
      threadItemsByWorkspace: {
        windows: [{ id: "first" }],
        wsl2: [],
      },
    };
    const module = createAppPersistenceModule({
      state,
      byId: () => null,
      api: async () => ({}),
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
      CODEX_VERSION_CACHE_KEY: "versions",
      THREADS_CACHE_KEY: "threads",
      REASONING_EFFORT_KEY: "effort",
      localStorageRef: {
        getItem() { return ""; },
        setItem(key, value) {
          writes.push({ key, value: JSON.parse(value) });
        },
      },
      documentRef: {},
    });

    module.persistThreadsCache();
    state.threadItemsByWorkspace.windows = [{ id: "second" }];
    module.persistThreadsCache();

    expect(writes).toEqual([]);
    vi.advanceTimersByTime(249);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      key: "threads",
      value: { windows: [{ id: "second" }], wsl2: [] },
    });
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
