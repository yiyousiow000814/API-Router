import { describe, expect, it, vi } from "vitest";

import { createThreadListRefreshModule } from "./threadListRefresh.js";

describe("threadListRefresh", () => {
  it("filters and sorts threads for the active workspace before rendering", () => {
    const rendered = [];
    const state = {
      threadItemsAll: [
        { id: "b", cwd: "C:\\repo\\b", updatedAt: "2026-03-08T00:00:00Z" },
        { id: "a", cwd: "C:\\repo\\a", updatedAt: "2026-03-09T00:00:00Z" },
        { id: "w", cwd: "/home/yiyou/w", updatedAt: "2026-03-10T00:00:00Z" },
      ],
    };
    const module = createThreadListRefreshModule({
      state,
      byId: () => null,
      windowRef: { getComputedStyle: () => ({ display: "block", visibility: "visible" }), innerWidth: 1280, innerHeight: 720 },
      documentRef: { documentElement: { clientWidth: 1280, clientHeight: 720 }, body: { classList: { contains: () => false } } },
      api: vi.fn(),
      ensureArrayItems: (value) => (Array.isArray(value) ? value : []),
      normalizeWorkspaceTarget: (value) => (value === "wsl2" ? "wsl2" : "windows"),
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "C:\\repo\\a",
      sortThreadsByNewest: (items) => [...items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
      filterThreadsForWorkspace: (items, options) =>
        items.filter(
          (item) =>
            String(item.cwd || "").startsWith("C:\\") &&
            String(item.cwd || "").startsWith(String(options?.startCwd || ""))
        ),
      hasDualWorkspaceTargets: () => true,
      detectWorkspaceAvailabilityFromThreads: vi.fn(),
      buildThreadRenderSig: vi.fn(),
      persistThreadsCache: vi.fn(),
      syncActiveThreadMetaFromList: vi.fn(),
      updateHeaderUi: vi.fn(),
      pushThreadAnimDebug: vi.fn(),
      renderThreads: (items) => rendered.push(items.map((item) => item.id)),
      applyWorkspaceUi: vi.fn(),
      setStatus: vi.fn(),
      THREAD_FORCE_REFRESH_MIN_INTERVAL_MS: 1800,
    });

    module.applyThreadFilter();

    expect(state.threadItems.map((item) => item.id)).toEqual(["a"]);
    expect(rendered).toEqual([["a"]]);
  });

  it("updates workspace availability from discovered thread paths", () => {
    const state = {
      workspaceAvailability: {
        windowsInstalled: false,
        wsl2Installed: false,
      },
      threadItemsAll: [],
    };
    const module = createThreadListRefreshModule({
      state,
      byId: () => null,
      windowRef: { getComputedStyle: () => ({ display: "block", visibility: "visible" }), innerWidth: 1280, innerHeight: 720 },
      documentRef: { documentElement: { clientWidth: 1280, clientHeight: 720 }, body: { classList: { contains: () => false } } },
      api: vi.fn(),
      ensureArrayItems: (value) => (Array.isArray(value) ? value : []),
      normalizeWorkspaceTarget: (value) => value,
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      sortThreadsByNewest: (items) => items,
      filterThreadsForWorkspace: (items) => items,
      hasDualWorkspaceTargets: () => true,
      detectWorkspaceAvailabilityFromThreads: () => ({
        windowsInstalled: true,
        wsl2Installed: true,
      }),
      buildThreadRenderSig: vi.fn(),
      persistThreadsCache: vi.fn(),
      syncActiveThreadMetaFromList: vi.fn(),
      updateHeaderUi: vi.fn(),
      pushThreadAnimDebug: vi.fn(),
      renderThreads: vi.fn(),
      applyWorkspaceUi: vi.fn(),
      setStatus: vi.fn(),
      THREAD_FORCE_REFRESH_MIN_INTERVAL_MS: 1800,
    });

    module.updateWorkspaceAvailabilityFromThreads([{ cwd: "C:\\repo" }, { cwd: "/home/yiyou/repo" }]);

    expect(state.workspaceAvailability).toEqual({
      windowsInstalled: true,
      wsl2Installed: true,
    });
  });

  it("upserts provisional live thread items into the active workspace cache", () => {
    const rendered = [];
    const persisted = vi.fn();
    const state = {
      threadItemsAll: [],
      threadItems: [],
      threadItemsByWorkspace: { windows: [], wsl2: [] },
      threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: false },
      threadListRenderSigByWorkspace: { windows: "", wsl2: "" },
      workspaceAvailability: { windowsInstalled: false, wsl2Installed: false },
    };
    const module = createThreadListRefreshModule({
      state,
      byId: () => null,
      windowRef: { getComputedStyle: () => ({ display: "block", visibility: "visible" }), innerWidth: 1280, innerHeight: 720 },
      documentRef: { documentElement: { clientWidth: 1280, clientHeight: 720 }, body: { classList: { contains: () => false } } },
      api: vi.fn(),
      ensureArrayItems: (value) => (Array.isArray(value) ? value : []),
      normalizeWorkspaceTarget: (value) => (value === "wsl2" ? "wsl2" : "windows"),
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      sortThreadsByNewest: (items) => [...items].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
      filterThreadsForWorkspace: (items) => items,
      hasDualWorkspaceTargets: () => true,
      detectWorkspaceAvailabilityFromThreads: () => ({
        windowsInstalled: true,
        wsl2Installed: false,
      }),
      buildThreadRenderSig: (items) => items.map((item) => item.id).join("|"),
      persistThreadsCache: persisted,
      syncActiveThreadMetaFromList: vi.fn(),
      updateHeaderUi: vi.fn(),
      pushThreadAnimDebug: vi.fn(),
      renderThreads: (items) => rendered.push(items.map((entry) => entry.id)),
      applyWorkspaceUi: vi.fn(),
      setStatus: vi.fn(),
      THREAD_FORCE_REFRESH_MIN_INTERVAL_MS: 1800,
    });

    expect(
      module.upsertProvisionalThreadItem({
        id: "thread-live",
        workspace: "windows",
        __workspaceQueryTarget: "windows",
        preview: "build exe",
        updatedAt: 1742340000000,
        provisional: true,
      })
    ).toBe(true);

    expect(state.threadItemsByWorkspace.windows.map((item) => item.id)).toEqual(["thread-live"]);
    expect(state.threadItemsAll.map((item) => item.id)).toEqual(["thread-live"]);
    expect(state.workspaceAvailability.windowsInstalled).toBe(true);
    expect(rendered).toEqual([["thread-live"]]);
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it("keeps stale WSL2 threads when backend refresh is still pending", async () => {
    const rendered = [];
    const persisted = vi.fn();
    const previous = [{ id: "thread-wsl", workspace: "wsl2", cwd: "/home/yiyou/repo", updatedAt: 1742340000 }];
    const state = {
      threadItemsAll: previous,
      threadItems: previous,
      threadItemsByWorkspace: { windows: [], wsl2: previous },
      threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: true },
      threadRefreshAbortByWorkspace: { windows: null, wsl2: null },
      threadRefreshReqSeqByWorkspace: { windows: 0, wsl2: 0 },
      threadListRenderSigByWorkspace: { windows: "", wsl2: "thread-wsl" },
      threadListDeferredRenderTimerByWorkspace: { windows: 0, wsl2: 0 },
      threadListAnimationHoldUntilByWorkspace: { windows: 0, wsl2: 0 },
      threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
      workspaceAvailability: { windowsInstalled: false, wsl2Installed: true },
    };
    const listNode = {
      isConnected: true,
      querySelector: () => ({ nodeType: 1 }),
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 320, bottom: 480, width: 320, height: 480 }),
    };
    const module = createThreadListRefreshModule({
      state,
      byId: (id) => (id === "threadList" ? listNode : null),
      windowRef: { getComputedStyle: () => ({ display: "block", visibility: "visible" }), innerWidth: 1280, innerHeight: 720 },
      documentRef: {
        documentElement: { clientWidth: 1280, clientHeight: 720 },
        body: { classList: { contains: () => false } },
      },
      api: vi.fn(async () => ({
        items: { data: [], nextCursor: null },
        meta: { workspace: "wsl2", cacheHit: false, refreshing: true, totalMs: 0, rebuildMs: 0 },
      })),
      ensureArrayItems: (value) => (Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : []),
      normalizeWorkspaceTarget: (value) => (value === "wsl2" ? "wsl2" : "windows"),
      getWorkspaceTarget: () => "wsl2",
      getStartCwdForWorkspace: () => "",
      sortThreadsByNewest: (items) => items,
      filterThreadsForWorkspace: (items) => items,
      hasDualWorkspaceTargets: () => true,
      detectWorkspaceAvailabilityFromThreads: () => ({
        windowsInstalled: false,
        wsl2Installed: true,
      }),
      buildThreadRenderSig: (items) => items.map((item) => item.id).join("|"),
      persistThreadsCache: persisted,
      syncActiveThreadMetaFromList: vi.fn(),
      updateHeaderUi: vi.fn(),
      pushThreadAnimDebug: vi.fn(),
      renderThreads: (items) => rendered.push(items.map((entry) => entry.id)),
      applyWorkspaceUi: vi.fn(),
      setStatus: vi.fn(),
      THREAD_FORCE_REFRESH_MIN_INTERVAL_MS: 1800,
    });

    await module.refreshThreads("wsl2", { silent: true });

    expect(state.threadItemsByWorkspace.wsl2).toBe(previous);
    expect(state.threadItemsAll).toEqual(previous);
    expect(state.threadItems.map((item) => item.id)).toEqual(["thread-wsl"]);
    expect(persisted).not.toHaveBeenCalled();
    expect(rendered).toEqual([["thread-wsl"]]);
  });

  it("records thread refresh fetch, processing, cache, and render timings", async () => {
    const localTasks = [];
    let now = 0;
    const payload = {
      items: [{ id: "thread-a", workspace: "windows", cwd: "C:\\repo", updatedAt: 1 }],
      meta: { workspace: "windows", cacheHit: true, refreshing: false },
    };
    Object.defineProperty(payload, "__apiTrace", {
      value: {
        requestId: "req_trace",
        responseBytes: 4096,
        headersMs: 20,
        bodyReadMs: 3,
        parseMs: 2,
      },
    });
    const state = {
      threadItemsAll: [],
      threadItems: [],
      threadItemsByWorkspace: { windows: [], wsl2: [] },
      threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: false },
      threadRefreshAbortByWorkspace: { windows: null, wsl2: null },
      threadRefreshReqSeqByWorkspace: { windows: 0, wsl2: 0 },
      threadListRenderSigByWorkspace: { windows: "", wsl2: "" },
      threadListDeferredRenderTimerByWorkspace: { windows: 0, wsl2: 0 },
      threadListAnimationHoldUntilByWorkspace: { windows: 0, wsl2: 0 },
      threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: false },
    };
    const module = createThreadListRefreshModule({
      state,
      byId: () => ({
        isConnected: true,
        querySelector: () => ({ nodeType: 1 }),
        closest: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 320, bottom: 480, width: 320, height: 480 }),
      }),
      windowRef: { getComputedStyle: () => ({ display: "block", visibility: "visible" }), innerWidth: 1280, innerHeight: 720 },
      documentRef: {
        documentElement: { clientWidth: 1280, clientHeight: 720 },
        body: { classList: { contains: () => false } },
      },
      api: vi.fn(async () => payload),
      ensureArrayItems: (value) => (Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : []),
      normalizeWorkspaceTarget: (value) => (value === "wsl2" ? "wsl2" : "windows"),
      getWorkspaceTarget: () => "windows",
      getStartCwdForWorkspace: () => "",
      sortThreadsByNewest: (items) => items,
      filterThreadsForWorkspace: (items) => items,
      hasDualWorkspaceTargets: () => true,
      detectWorkspaceAvailabilityFromThreads: () => ({
        windowsInstalled: true,
        wsl2Installed: false,
      }),
      buildThreadRenderSig: (items) => items.map((item) => item.id).join("|"),
      persistThreadsCache: vi.fn(),
      syncActiveThreadMetaFromList: vi.fn(),
      updateHeaderUi: vi.fn(),
      pushThreadAnimDebug: vi.fn(),
      renderThreads: vi.fn(),
      applyWorkspaceUi: vi.fn(),
      setStatus: vi.fn(),
      recordLocalTask: (entry) => localTasks.push(entry),
      performanceRef: { now: () => ++now },
      THREAD_FORCE_REFRESH_MIN_INTERVAL_MS: 1800,
    });

    await module.refreshThreads("windows", { silent: true });

    expect(localTasks.map((task) => task.command)).toEqual(
      expect.arrayContaining([
        "thread refresh fetch",
        "thread refresh materialize",
        "thread cache persist",
        "thread filter render",
        "thread refresh total",
      ])
    );
    expect(localTasks.find((task) => task.command === "thread refresh fetch").fields).toMatchObject({
      workspace: "windows",
      requestId: "req_trace",
      responseBytes: 4096,
      headersMs: 20,
      bodyReadMs: 3,
      parseMs: 2,
    });
  });
});
