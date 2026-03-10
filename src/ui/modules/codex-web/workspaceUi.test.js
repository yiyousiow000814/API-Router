import { describe, expect, it } from "vitest";

import { folderDisplayName, normalizeStartCwd } from "./workspaceUi.js";

describe("workspaceUi", () => {
  it("normalizes windows and wsl cwd values", () => {
    expect(normalizeStartCwd("C:\\repo\\", "windows")).toBe("C:\\repo");
    expect(normalizeStartCwd("/home/user/project/", "wsl2")).toBe("/home/user/project");
    expect(normalizeStartCwd("relative/path", "windows")).toBe("");
  });

  it("builds display labels from folder paths", () => {
    expect(folderDisplayName("C:\\repo\\demo", "windows")).toBe("demo");
    expect(folderDisplayName("D:", "windows")).toBe("D:\\");
    expect(folderDisplayName("/home/user/demo", "wsl2")).toBe("demo");
  });
});
