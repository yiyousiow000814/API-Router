import type { OfficialAccountProfileSummary } from '../types'

function parsePct(value?: string | null): number | null {
  if (!value) return null
  const match = value.match(/(\d+(?:\.\d+)?)%/)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null
}

export function OfficialAccountQuotaSummary({
  profile,
}: {
  profile: OfficialAccountProfileSummary
}) {
  const has5h = Boolean(profile.limit_5h_remaining)
  const hasWeekly = Boolean(profile.limit_weekly_remaining)
  if (profile.needs_reauth) {
    return <span className="aoAccountsQuotaFallback aoAccountsQuotaExpired">Session expired</span>
  }
  if (!has5h && !hasWeekly) {
    return <span className="aoAccountsQuotaFallback">No cached limits yet</span>
  }

  return (
    <div className="aoAccountsUsageStack">
      {has5h ? (
        <div className="aoAccountsUsageMetric">
          <div className="aoAccountsUsageMeta">
            <span className="aoAccountsUsageLabel">5-hour</span>
            <span className="aoAccountsUsageValue">{profile.limit_5h_remaining}</span>
          </div>
          <span className="aoAccountsUsageBar" aria-hidden="true">
            <span
              className="aoAccountsUsageBarFill"
              style={{ width: `${parsePct(profile.limit_5h_remaining) ?? 0}%` }}
            />
          </span>
        </div>
      ) : null}
      {hasWeekly ? (
        <div className="aoAccountsUsageMetric">
          <div className="aoAccountsUsageMeta">
            <span className="aoAccountsUsageLabel">Weekly</span>
            <span className="aoAccountsUsageValue">{profile.limit_weekly_remaining}</span>
          </div>
          <span className="aoAccountsUsageBar" aria-hidden="true">
            <span
              className="aoAccountsUsageBarFill"
              style={{ width: `${parsePct(profile.limit_weekly_remaining) ?? 0}%` }}
            />
          </span>
        </div>
      ) : null}
    </div>
  )
}
