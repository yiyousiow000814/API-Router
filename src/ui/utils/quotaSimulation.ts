import type { Status, UsageStatistics, UsageStatisticsOverview } from '../types'

type ProviderQuota = Status['quota'][string]
type ProviderLedger = Status['ledgers'][string] | undefined

function resolveEstimatedAvgRequestCostUsd(
  provider: string,
  usageStatistics: UsageStatistics | UsageStatisticsOverview | null | undefined,
): number | null {
  const rows =
    usageStatistics?.summary?.by_provider?.filter(
      (row) =>
        row.provider === provider &&
        row.estimated_avg_request_cost_usd != null &&
        Number.isFinite(row.estimated_avg_request_cost_usd) &&
        (row.estimated_avg_request_cost_usd ?? 0) > 0,
    ) ?? []
  if (!rows.length) return null

  const weighted = rows.reduce(
    (acc, row) => {
      const weight = Math.max(0, row.estimated_cost_request_count ?? row.requests ?? 0)
      if (weight <= 0) return acc
      return {
        totalCost: acc.totalCost + (row.estimated_avg_request_cost_usd ?? 0) * weight,
        totalWeight: acc.totalWeight + weight,
      }
    },
    { totalCost: 0, totalWeight: 0 },
  )

  if (weighted.totalWeight > 0) {
    return weighted.totalCost / weighted.totalWeight
  }

  const simpleMean =
    rows.reduce((sum, row) => sum + (row.estimated_avg_request_cost_usd ?? 0), 0) / rows.length
  return Number.isFinite(simpleMean) && simpleMean > 0 ? simpleMean : null
}

export function simulateQuotaForDisplay(
  provider: string,
  quota: ProviderQuota | undefined,
  ledger: ProviderLedger,
  usageStatistics: UsageStatistics | UsageStatisticsOverview | null | undefined,
): ProviderQuota | undefined {
  if (!quota || quota.kind !== 'budget_info' || quota.updated_at_unix_ms <= 0) {
    return quota
  }

  const requestsSinceRefresh = ledger?.since_last_quota_refresh_requests ?? 0
  if (!Number.isFinite(requestsSinceRefresh) || requestsSinceRefresh <= 0) {
    return quota
  }

  const avgUsdPerReq = resolveEstimatedAvgRequestCostUsd(provider, usageStatistics)
  if (avgUsdPerReq == null || !Number.isFinite(avgUsdPerReq) || avgUsdPerReq <= 0) {
    return quota
  }

  const deltaUsd = requestsSinceRefresh * avgUsdPerReq
  return {
    ...quota,
    daily_spent_usd:
      quota.daily_spent_usd != null && Number.isFinite(quota.daily_spent_usd)
        ? quota.daily_spent_usd + deltaUsd
        : quota.daily_spent_usd,
    weekly_spent_usd:
      quota.weekly_spent_usd != null && Number.isFinite(quota.weekly_spent_usd)
        ? quota.weekly_spent_usd + deltaUsd
        : quota.weekly_spent_usd,
    monthly_spent_usd:
      quota.monthly_spent_usd != null && Number.isFinite(quota.monthly_spent_usd)
        ? quota.monthly_spent_usd + deltaUsd
        : quota.monthly_spent_usd,
  }
}
