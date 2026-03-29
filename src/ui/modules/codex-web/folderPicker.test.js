import { describe, expect, it } from "vitest";

import {
  folderPickerItemsRenderSig,
  normalizeFolderPickerItems,
} from "./folderPicker.js";

describe("folderPicker", () => {
  it("builds stable render signatures for empty and populated lists", () => {
    expect(folderPickerItemsRenderSig("windows", "", "", [], "oops")).toBe("windows|||empty|oops");
    expect(
      folderPickerItemsRenderSig("wsl2", "/home", "/home/..", [
        { name: "repo", path: "/home/repo" },
        { name: "tmp", path: "/tmp" },
      ])
    ).toBe("wsl2|/home|/home/..|repo\u0001/home/repo\u0002tmp\u0001/tmp");
  });

  it("normalizes folder items and filters invalid entries", () => {
    const items = normalizeFolderPickerItems(
      [
        { name: " repo ", path: " /home/repo " },
        { name: "", path: "/tmp" },
        { name: "tmp", path: "" },
      ],
      (value) => value
    );
    expect(items).toEqual([{ name: "repo", path: "/home/repo" }]);
  });
});
