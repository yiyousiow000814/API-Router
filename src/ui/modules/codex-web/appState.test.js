import { describe, expect, it } from "vitest";

import {
  CHAT_STICKY_BOTTOM_PX,
  createInitialState,
  createThreadAnimDebugState,
} from "./appState.js";

describe("appState", () => {
  it("creates fresh mutable containers", () => {
    const a = createInitialState();
    const b = createInitialState();
    expect(a.threadItemsByWorkspace).not.toBe(b.threadItemsByWorkspace);
    expect(a.favoriteThreadIds).not.toBe(b.favoriteThreadIds);
    expect(CHAT_STICKY_BOTTOM_PX).toBe(12);
  });

  it("creates disabled thread animation debug state", () => {
    expect(createThreadAnimDebugState()).toEqual({ enabled: false, events: [], seq: 0 });
  });

  it("initializes git metadata state explicitly", () => {
    expect(createInitialState()).toMatchObject({
      activeThreadCurrentBranch: "",
      activeThreadBranchOptions: [],
      activeThreadIsWorktree: false,
      activeThreadUncommittedFileCount: 0,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: false,
      activeThreadGitMetaError: "",
      activeThreadGitMetaErrorKey: "",
      activeThreadGitMetaKey: "",
      activeThreadGitMetaCwd: "",
      activeThreadGitMetaSource: "",
      activeThreadGitMetaReqSeq: 0,
    });
  });

  it("keeps workspace switches selectable while runtime detection is pending", () => {
    expect(createInitialState().workspaceAvailability).toEqual({
      windowsInstalled: true,
      wsl2Installed: true,
    });
  });
});
