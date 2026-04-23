import { describe, expect, it } from "vitest";
import {
  activateDevPreviewOfficialAccountProfile,
  addDevPreviewOfficialAccountProfile,
  buildDevPreviewOfficialAccountProfiles,
  removeDevPreviewOfficialAccountProfile,
  shouldRefreshOfficialAccountProfilesUsage,
} from "./codexAccountProfiles";

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

  it("activates the requested preview profile", () => {
    const profiles = buildDevPreviewOfficialAccountProfiles({
      ok: true,
      signed_in: true,
    });

    const next = activateDevPreviewOfficialAccountProfile(
      profiles,
      "dev-official-secondary",
    );

    expect(
      next.find((profile) => profile.id === "dev-official-secondary")?.active,
    ).toBe(true);
    expect(
      next.find((profile) => profile.id === "dev-official-primary")?.active,
    ).toBe(false);
  });

  it("adds and removes preview profiles while preserving one active profile", () => {
    const profiles = buildDevPreviewOfficialAccountProfiles({
      ok: true,
      signed_in: true,
    });

    const added = addDevPreviewOfficialAccountProfile(profiles);
    expect(added).toHaveLength(3);
    expect(added[2]?.active).toBe(true);

    const removed = removeDevPreviewOfficialAccountProfile(
      added,
      "dev-official-3",
    );
    expect(removed).toHaveLength(2);
    expect(removed.some((profile) => profile.active)).toBe(true);
  });

  it("does not refresh per-profile usage on status ticks", () => {
    expect(
      shouldRefreshOfficialAccountProfilesUsage("status_tick", {
        ok: true,
        signed_in: true,
      }),
    ).toBe(false);
  });

  it("refreshes per-profile usage after a new account is added", () => {
    expect(
      shouldRefreshOfficialAccountProfilesUsage("profile_add_complete", {
        ok: true,
        signed_in: true,
      }),
    ).toBe(true);
  });
});
