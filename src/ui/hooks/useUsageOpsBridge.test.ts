import { describe, expect, it } from 'vitest'

import { isDashboardUsageRefreshSource } from './useUsageOpsBridge'

describe('useUsageOpsBridge', () => {
  it('treats dashboard usage-page refreshes as overview-only', () => {
    expect(isDashboardUsageRefreshSource('usage_page_bootstrap:dashboard')).toBe(true)
    expect(isDashboardUsageRefreshSource('usage_page_interval:dashboard')).toBe(true)
    expect(isDashboardUsageRefreshSource('usage_page_entry:dashboard')).toBe(true)
  })

  it('does not reroute non-dashboard or intent prefetch refreshes', () => {
    expect(isDashboardUsageRefreshSource('usage_page_interval:usage_statistics')).toBe(false)
    expect(isDashboardUsageRefreshSource('top_nav_usage_intent_prefetch')).toBe(false)
    expect(isDashboardUsageRefreshSource('unknown')).toBe(false)
  })
})
