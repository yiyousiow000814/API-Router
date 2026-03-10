import { describe, expect, it } from "vitest";

import {
  buildWorkspaceEntries,
  filterWorkspaceSectionThreads,
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
});
