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
});
