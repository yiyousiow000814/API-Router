import { describe, expect, it } from 'vitest'
import { shouldRefreshUsageSilently, usageStatisticsRefreshIntervalMs } from './useAppUsageEffects'

describe('useAppUsageEffects', () => {
  it('refreshes dashboard usage cards less aggressively', () => {
    expect(usageStatisticsRefreshIntervalMs('dashboard')).toBe(60000)
  })

  it('keeps the dedicated usage page refresh cadence fast', () => {
    expect(usageStatisticsRefreshIntervalMs('usage_statistics')).toBe(15000)
  })

  it('does not schedule usage refresh on unrelated pages', () => {
    expect(usageStatisticsRefreshIntervalMs('event_log')).toBeNull()
    expect(usageStatisticsRefreshIntervalMs('web_codex')).toBeNull()
  })

  it('does not silence the first dashboard refresh when there is no usage snapshot yet', () => {
    expect(shouldRefreshUsageSilently(null, 'dashboard', false)).toBe(false)
  })

  it('keeps page-entry refresh silent after usage data already exists', () => {
    expect(shouldRefreshUsageSilently('event_log', 'dashboard', true)).toBe(true)
  })
})
