import { describe, expect, it } from "vitest";

import { pickPendingDefaults } from "./connectionFlows.js";

describe("connectionFlows", () => {
  it("picks the first pending ids", () => {
    expect(
      pickPendingDefaults([{ id: "a1" }, { id: "a2" }], [{ id: "u1" }])
    ).toEqual({
      approvalId: "a1",
      userInputId: "u1",
    });
  });

  it("returns empty ids when lists are empty", () => {
    expect(pickPendingDefaults([], [])).toEqual({
      approvalId: "",
      userInputId: "",
    });
  });
});
