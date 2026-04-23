import { describe, expect, it } from "vitest";
import { buildDevPreviewOfficialAccountProfiles } from "./codexAccountProfiles";

describe("buildDevPreviewOfficialAccountProfiles", () => {
  it("returns multiple preview profiles with the signed-in profile active", () => {
    const profiles = buildDevPreviewOfficialAccountProfiles({
      ok: true,
      signed_in: true,
    });

    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toMatchObject({
      id: "dev-official-primary",
      active: true,
    });
    expect(profiles[1]).toMatchObject({
      id: "dev-official-secondary",
      active: false,
    });
  });

  it("keeps preview profiles visible even when signed out", () => {
    const profiles = buildDevPreviewOfficialAccountProfiles({
      ok: true,
      signed_in: false,
    });

    expect(profiles).toHaveLength(2);
    expect(profiles.some((profile) => profile.active)).toBe(false);
  });
});
