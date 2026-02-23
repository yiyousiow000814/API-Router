import type { Status } from '../types'

export const QUOTA_HARD_CAP_PERIODS = ['daily', 'weekly', 'monthly'] as const

export type QuotaHardCapPeriod = (typeof QUOTA_HARD_CAP_PERIODS)[number]

export function isBudgetInfoQuota(quota: Status['quota'][string] | undefined): boolean {
  return quota?.kind === 'budget_info'
}

export function getBudgetWindowVisibleByPeriod(
  quota: Status['quota'][string] | undefined,
): Record<QuotaHardCapPeriod, boolean> {
  const hasBudgetInfo = isBudgetInfoQuota(quota)
  return {
    daily: hasBudgetInfo && quota?.daily_spent_usd != null && quota?.daily_budget_usd != null,
    weekly: hasBudgetInfo && quota?.weekly_spent_usd != null && quota?.weekly_budget_usd != null,
    monthly: hasBudgetInfo && quota?.monthly_spent_usd != null && quota?.monthly_budget_usd != null,
  }
}

export function getVisibleBudgetHardCapPeriods(
  quota: Status['quota'][string] | undefined,
): QuotaHardCapPeriod[] {
  const visibleByPeriod = getBudgetWindowVisibleByPeriod(quota)
  return QUOTA_HARD_CAP_PERIODS.filter((period) => visibleByPeriod[period])
}
