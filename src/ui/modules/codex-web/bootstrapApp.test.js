import { describe, expect, it } from "vitest";

import { restoreFavoriteThreadIds, restoreStartCwdState } from "./bootstrapApp.js";

describe("bootstrapApp", () => {
  it("restores normalized start cwd state", () => {
    const state = restoreStartCwdState(
      JSON.stringify({ windows: "C:\\repo\\", wsl2: "/home/test/" }),
      (value, target) => `${target}:${String(value || "").replace(/[\\/]+$/, "")}`
    );
    expect(state).toEqual({ windows: "windows:C:\\repo", wsl2: "wsl2:/home/test" });
  });

  it("falls back on invalid favorite payloads", () => {
    expect(Array.from(restoreFavoriteThreadIds('["a",2]'))).toEqual(["a", "2"]);
    expect(Array.from(restoreFavoriteThreadIds("{bad json}"))).toEqual([]);
  });
});
