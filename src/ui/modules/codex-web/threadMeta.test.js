import { describe, expect, it } from "vitest";

import {
  buildThreadRenderSig,
  detectThreadWorkspaceTarget,
  detectWorkspaceAvailabilityFromThreads,
  filterThreadsForWorkspace,
  mergeThreadItem,
  normalizeThreadCwdForMatch,
  readThreadItemId,
  sortThreadsByNewest,
  threadMatchesStartCwd,
  threadSortTimestampMs,
  upsertThreadItem,
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

  it("reads thread ids from both supported field names", () => {
    expect(readThreadItemId({ id: "thread-1" })).toBe("thread-1");
    expect(readThreadItemId({ threadId: "thread-2" })).toBe("thread-2");
    expect(readThreadItemId({})).toBe("");
  });

  it("merges provisional thread items without dropping richer existing fields", () => {
    const merged = mergeThreadItem(
      {
        id: "thread-1",
        workspace: "windows",
        path: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
        preview: "existing preview",
        updatedAt: "2026-03-18T00:00:00Z",
        provisional: true,
      },
      {
        id: "thread-1",
        workspace: "windows",
        status: { type: "running" },
        updatedAt: "2026-03-19T00:00:00Z",
        provisional: false,
      }
    );

    expect(merged.path).toBe("C:\\repo\\.codex\\sessions\\rollout.jsonl");
    expect(merged.preview).toBe("existing preview");
    expect(merged.status).toEqual({ type: "running" });
    expect(merged.provisional).toBe(false);
    expect(merged.updatedAt).toBe("2026-03-19T00:00:00Z");
  });

  it("upserts thread items by id and keeps newest order", () => {
    const next = upsertThreadItem(
      [
        { id: "a", updatedAt: "2026-03-18T00:00:00Z" },
        { id: "b", updatedAt: "2026-03-17T00:00:00Z" },
      ],
      { id: "b", updatedAt: "2026-03-19T00:00:00Z", status: { type: "running" } }
    );

    expect(next.map((item) => item.id)).toEqual(["b", "a"]);
    expect(next[0].status).toEqual({ type: "running" });
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

  it("normalizes cwd values for folder matching", () => {
    expect(normalizeThreadCwdForMatch("C:\\Repo\\Demo\\", "windows")).toBe("c:/repo/demo");
    expect(normalizeThreadCwdForMatch("/home/user/demo/", "wsl2")).toBe("/home/user/demo");
  });

  it("matches threads within the selected start folder", () => {
    expect(
      threadMatchesStartCwd({ cwd: "C:\\repo\\demo\\nested" }, "C:\\repo\\demo", "windows")
    ).toBe(true);
    expect(
      threadMatchesStartCwd({ cwd: "C:\\repo\\other" }, "C:\\repo\\demo", "windows")
    ).toBe(false);
  });

  it("filters threads to the selected folder within the active workspace", () => {
    const items = [
      { id: "root", cwd: "C:\\repo\\demo", updatedAt: "2026-03-09T00:00:00Z" },
      { id: "child", cwd: "C:\\repo\\demo\\nested", updatedAt: "2026-03-08T00:00:00Z" },
      { id: "other", cwd: "C:\\repo\\other", updatedAt: "2026-03-10T00:00:00Z" },
      { id: "wsl", cwd: "/home/yiyou/demo", updatedAt: "2026-03-11T00:00:00Z" },
    ];
    expect(
      filterThreadsForWorkspace(items, {
        hasDualWorkspaceTargets: true,
        currentTarget: "windows",
        startCwd: "C:\\repo\\demo",
      }).map((item) => item.id)
    ).toEqual(["root", "child"]);
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
