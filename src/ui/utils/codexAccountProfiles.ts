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
    },
    {
      id: "dev-official-secondary",
      label: "Official account 2",
      updated_at_unix_ms: DEV_PROFILE_BASE_TIME - 86_400_000,
      active: false,
    },
  ];
}
