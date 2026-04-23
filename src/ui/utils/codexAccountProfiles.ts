import type { OfficialAccountProfileSummary, Status } from "../types";

const DEV_PROFILE_BASE_TIME = Date.UTC(2026, 3, 23, 13, 24, 48);

export function buildDevPreviewOfficialAccountProfiles(
  codexAccount: Status["codex_account"] | null | undefined,
): OfficialAccountProfileSummary[] {
  const signedIn = Boolean(codexAccount?.signed_in);
  return [
    {
      id: "dev-official-primary",
      label: signedIn ? "Official account 1" : "Official account 1 (signed out)",
      updated_at_unix_ms: DEV_PROFILE_BASE_TIME,
      active: signedIn,
      limit_5h_remaining: codexAccount?.limit_5h_remaining ?? "87%",
      limit_5h_reset_at:
        codexAccount?.limit_5h_reset_at ??
        String(DEV_PROFILE_BASE_TIME + 7_200_000),
      limit_weekly_remaining: codexAccount?.limit_weekly_remaining ?? "13%",
      limit_weekly_reset_at:
        codexAccount?.limit_weekly_reset_at ??
        String(DEV_PROFILE_BASE_TIME + 255_600_000),
    },
    {
      id: "dev-official-secondary",
      label: "Official account 2",
      updated_at_unix_ms: DEV_PROFILE_BASE_TIME - 86_400_000,
      active: false,
      limit_5h_remaining: "64%",
      limit_5h_reset_at: String(DEV_PROFILE_BASE_TIME + 5_400_000),
      limit_weekly_remaining: "41%",
      limit_weekly_reset_at: String(DEV_PROFILE_BASE_TIME + 172_800_000),
    },
  ];
}

export function activateDevPreviewOfficialAccountProfile(
  profiles: OfficialAccountProfileSummary[],
  profileId: string,
): OfficialAccountProfileSummary[] {
  return profiles.map((profile) => ({
    ...profile,
    active: profile.id === profileId,
  }));
}

export function removeDevPreviewOfficialAccountProfile(
  profiles: OfficialAccountProfileSummary[],
  profileId: string,
): OfficialAccountProfileSummary[] {
  const remaining = profiles.filter((profile) => profile.id !== profileId);
  if (!remaining.length) return [];
  if (remaining.some((profile) => profile.active)) return remaining;
  return remaining.map((profile, index) => ({
    ...profile,
    active: index === 0,
  }));
}

export function addDevPreviewOfficialAccountProfile(
  profiles: OfficialAccountProfileSummary[],
): OfficialAccountProfileSummary[] {
  const nextIndex = profiles.length + 1;
  return [
    ...profiles.map((profile) => ({ ...profile, active: false })),
    {
      id: `dev-official-${nextIndex}`,
      label: `Official account ${nextIndex}`,
      updated_at_unix_ms: DEV_PROFILE_BASE_TIME + nextIndex * 60_000,
      active: true,
      limit_5h_remaining: "100%",
      limit_5h_reset_at: String(DEV_PROFILE_BASE_TIME + 9_000_000),
      limit_weekly_remaining: "100%",
      limit_weekly_reset_at: String(DEV_PROFILE_BASE_TIME + 302_400_000),
    },
  ];
}
