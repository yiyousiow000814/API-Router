import { describe, expect, it } from "vitest";

import {
  buildBranchPickerItemState,
  buildBranchPickerState,
  resolveBranchPickerSelection,
} from "./branchPickerState.js";

describe("branchPickerState", () => {
  it("builds one canonical picker model for dirty repositories", () => {
    const picker = buildBranchPickerState({
      activeThreadCurrentBranch: "feat/ui",
      activeThreadBranchOptions: [
        { name: "main" },
        { name: "feat/ui", prNumber: 196 },
        { name: "fix/other", prNumber: 150 },
      ],
      activeThreadUncommittedFileCount: 3,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
    });

    expect(picker.branchLabel).toBe("feat/ui");
    expect(picker.canPickBranch).toBe(true);
    expect(picker.branchSwitchLocked).toBe(true);
    expect(picker.uncommittedFileCount).toBe(3);
    expect(picker.visibleBranches.map((branch) => branch.name)).toEqual([
      "main",
      "feat/ui",
      "fix/other",
    ]);
    expect(buildBranchPickerItemState(picker, { name: "main" }).disabled).toBe(true);
    expect(buildBranchPickerItemState(picker, { name: "feat/ui" }).disabled).toBe(false);
  });

  it("never switches when selecting the active branch", () => {
    expect(resolveBranchPickerSelection({
      activeThreadCurrentBranch: "feat/ui",
      activeThreadBranchOptions: [{ name: "main" }, { name: "feat/ui" }],
      activeThreadUncommittedFileCount: 3,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
    }, "feat/ui")).toEqual({ action: "close" });
  });

  it("blocks dirty branch switches before any backend call", () => {
    expect(resolveBranchPickerSelection({
      activeThreadCurrentBranch: "feat/ui",
      activeThreadBranchOptions: [{ name: "main" }, { name: "feat/ui" }],
      activeThreadUncommittedFileCount: 3,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
    }, "main")).toEqual({
      action: "blocked",
      reason: "uncommitted",
      uncommittedFileCount: 3,
    });
  });

  it("switches only known non-active branches when ready and clean", () => {
    expect(resolveBranchPickerSelection({
      activeThreadCurrentBranch: "feat/ui",
      activeThreadBranchOptions: [{ name: "main" }, { name: "feat/ui" }],
      activeThreadUncommittedFileCount: 0,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
    }, "main")).toEqual({ action: "switch", branch: "main" });
  });

  it("closes stale menu clicks while git metadata is loading", () => {
    expect(resolveBranchPickerSelection({
      activeThreadCurrentBranch: "feat/ui",
      activeThreadBranchOptions: [{ name: "main" }, { name: "feat/ui" }],
      activeThreadUncommittedFileCount: 0,
      activeThreadGitMetaLoading: true,
      activeThreadGitMetaLoaded: true,
    }, "main")).toEqual({ action: "close" });
  });
});
