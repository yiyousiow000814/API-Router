import { describe, expect, it } from "vitest";

import {
  buildThreadRenderSig,
  detectThreadWorkspaceTarget,
  detectWorkspaceAvailabilityFromThreads,
  filterThreadsForWorkspace,
  sortThreadsByNewest,
  threadSortTimestampMs,
} from "./threadMeta.js";

describe("threadMeta", () => {
  it("detects thread workspace targets from path and workspace hints", () => {
    expect(detectThreadWorkspaceTarget({ cwd: "/home/yiyou/project" })).toBe("wsl2");
    expect(detectThreadWorkspaceTarget({ cwd: "C:\\repo\\project" })).toBe("windows");
    expect(detectThreadWorkspaceTarget({ workspace: "wsl" })).toBe("wsl2");
    expect(detectThreadWorkspaceTarget({ workspace: "windows" })).toBe("windows");
    expect(detectThreadWorkspaceTarget({ __workspaceQueryTarget: "windows" })).toBe("unknown");
    expect(detectThreadWorkspaceTarget({})).toBe("unknown");
  });

  it("normalizes numeric and iso timestamps for sorting", () => {
    expect(threadSortTimestampMs({ updatedAt: 1710000000 })).toBe(1710000000000);
    expect(threadSortTimestampMs({ updatedAt: "1710000000" })).toBe(1710000000000);
    expect(threadSortTimestampMs({ updatedAt: "2026-03-09T00:00:00Z" })).toBe(Date.parse("2026-03-09T00:00:00Z"));
  });

  it("sorts newest threads first with id tie-breaker", () => {
    const sorted = sortThreadsByNewest([
      { id: "a", updatedAt: "2026-03-08T00:00:00Z" },
      { id: "c", updatedAt: "2026-03-09T00:00:00Z" },
      { id: "b", updatedAt: "2026-03-09T00:00:00Z" },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("builds stable render signatures from sorted thread data", () => {
    expect(
      buildThreadRenderSig([
        { id: "a", updatedAt: "2026-03-08T00:00:00Z", status: "done", preview: "older" },
        { id: "b", updatedAt: "2026-03-09T00:00:00Z", status: { type: "running" }, title: "newer" },
      ])
    ).toBe("b:2026-03-09T00:00:00Z:running:newer|a:2026-03-08T00:00:00Z:done:older");
  });

  it("filters visible threads for the active workspace while keeping unknown items", () => {
    const items = [
      { id: "win", cwd: "C:\\repo\\project" },
      { id: "wsl", cwd: "/home/yiyou/project" },
      { id: "unknown", title: "no path" },
    ];
    expect(
      filterThreadsForWorkspace(items, {
        hasDualWorkspaceTargets: true,
        currentTarget: "windows",
      }).map((item) => item.id)
    ).toEqual(["win", "unknown"]);
  });

  it("detects workspace availability from thread collections", () => {
    expect(
      detectWorkspaceAvailabilityFromThreads(
        [
          { cwd: "C:\\repo\\project" },
          { cwd: "/home/yiyou/project" },
        ],
        { windowsInstalled: false, wsl2Installed: false }
      )
    ).toEqual({
      windowsInstalled: true,
      wsl2Installed: true,
    });
  });
});
