import { describe, expect, it } from "vitest";

import {
  buildThreadResumeUrl,
  buildWorkspaceEntries,
  filterWorkspaceSectionThreads,
  resumeThreadLiveOnOpen,
} from "./threadListView.js";

describe("threadListView", () => {
  it("builds stable workspace entries grouped by label", () => {
    const entries = buildWorkspaceEntries(
      [
        { id: "1", workspaceLabel: "WSL2" },
        { id: "2", workspaceLabel: "WIN" },
        { id: "3", workspaceLabel: "wsl2" },
      ],
      (thread) => thread.workspaceLabel
    );
    expect(entries.map(([label, items]) => [label, items.map((item) => item.id)])).toEqual([
      ["WIN", ["2"]],
      ["WSL2", ["1", "3"]],
    ]);
  });

  it("filters section threads by favorites and query", () => {
    const items = [
      { id: "fav-1", title: "Alpha" },
      { id: "keep-1", title: "Beta Thread" },
      { id: "keep-2", title: "Gamma" },
    ];
    const favoriteSet = new Set(["fav-1"]);
    expect(filterWorkspaceSectionThreads(items, favoriteSet, "", "WIN").map((item) => item.id)).toEqual([
      "keep-1",
      "keep-2",
    ]);
    expect(filterWorkspaceSectionThreads(items, favoriteSet, "beta", "WIN").map((item) => item.id)).toEqual([
      "keep-1",
    ]);
    expect(filterWorkspaceSectionThreads(items, favoriteSet, "win", "WIN").map((item) => item.id)).toEqual([
      "keep-1",
      "keep-2",
    ]);
  });

  it("builds resume urls with workspace and rolloutPath", () => {
    expect(
      buildThreadResumeUrl("thread-1", {
        workspace: "windows",
        rolloutPath: "C:\\Users\\yiyou\\.codex\\sessions\\rollout.jsonl",
      })
    ).toBe(
      "/codex/threads/thread-1/resume?workspace=windows&rolloutPath=C%3A%5CUsers%5Cyiyou%5C.codex%5Csessions%5Crollout.jsonl"
    );
  });

  it("resumes opened threads in background to attach live updates", async () => {
    const calls = [];
    const state = {
      activeThreadNeedsResume: true,
      pendingThreadResumes: new Map(),
    };
    const api = async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET" });
      return { ok: true };
    };
    const ws = [];

    await resumeThreadLiveOnOpen({
      threadId: "thread-1",
      workspace: "windows",
      rolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      state,
      api,
      connectWs() {
        ws.push("connect");
      },
      syncEventSubscription() {
        ws.push("sync");
      },
      registerPendingThreadResume(map, threadId, promise) {
        map.set(threadId, promise);
      },
    });

    expect(ws).toEqual(["connect", "sync"]);
    expect(calls).toEqual([
      {
        path: "/codex/threads/thread-1/resume?workspace=windows&rolloutPath=C%3A%5Crepo%5C.codex%5Csessions%5Crollout.jsonl",
        method: "POST",
      },
    ]);
    expect(state.activeThreadNeedsResume).toBe(false);
  });
});
