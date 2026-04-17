import { describe, expect, it } from "vitest";

import {
  activeComposerWorkspace,
  applyActiveThreadGitMetaState,
  buildActiveThreadGitMetaKey,
} from "./threadGitMetaState.js";

describe("threadGitMetaState", () => {
  it("normalizes the active composer workspace", () => {
    expect(activeComposerWorkspace({ activeThreadWorkspace: "WSL2" })).toBe("wsl2");
    expect(activeComposerWorkspace({ workspaceTarget: "windows" })).toBe("windows");
    expect(activeComposerWorkspace({})).toBe("windows");
  });

  it("applies thread git meta through one canonical state mutation path", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      activeThreadCurrentBranch: "",
      activeThreadBranchOptions: [],
      activeThreadGitMetaLoading: true,
      activeThreadGitMetaLoaded: false,
      activeThreadGitMetaError: "git metadata unavailable",
      activeThreadGitMetaErrorKey: "thread:windows:thread-1",
      activeThreadGitMetaCwd: "",
      activeThreadGitMetaSource: "",
      activeThreadGitMetaKey: "",
      activeThreadIsWorktree: false,
    };
    const payload = {
      threadId: "thread-1",
      workspace: "windows",
      cwd: "C:\\repo",
      currentBranch: "feat/ui",
      branches: [{ name: "main" }, { name: "feat/ui", prNumber: 182 }],
      isWorktree: true,
    };

    const result = applyActiveThreadGitMetaState(state, payload);

    expect(result).toBe(payload);
    expect(state.activeThreadCurrentBranch).toBe("feat/ui");
    expect(state.activeThreadBranchOptions).toEqual([
      { name: "main" },
      { name: "feat/ui", prNumber: 182 },
    ]);
    expect(state.activeThreadGitMetaLoading).toBe(false);
    expect(state.activeThreadGitMetaLoaded).toBe(true);
    expect(state.activeThreadGitMetaError).toBe("");
    expect(state.activeThreadGitMetaErrorKey).toBe("");
    expect(state.activeThreadGitMetaCwd).toBe("C:\\repo");
    expect(state.activeThreadGitMetaSource).toBe("thread");
    expect(state.activeThreadGitMetaKey).toBe("thread:windows:thread-1");
    expect(state.activeThreadIsWorktree).toBe(true);
  });

  it("builds cwd git meta keys when no thread id is available", () => {
    expect(
      buildActiveThreadGitMetaKey({ workspace: "WSL2", cwd: "/repo/demo" })
    ).toBe("cwd:wsl2:/repo/demo");
  });
});
