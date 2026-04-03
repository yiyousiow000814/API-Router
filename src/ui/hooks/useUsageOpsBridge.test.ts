import { describe, expect, it } from 'vitest'

import type { Config } from '../types'
import { buildDevPreviewUsageSnapshot, isDashboardUsageRefreshSource } from './useUsageOpsBridge'

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

  it('builds both stats and overview for dev preview refreshes', () => {
    const config: Config = {
      listen: { host: '127.0.0.1', port: 4000 },
      routing: {
        preferred_provider: 'official',
        auto_return_to_preferred: true,
        preferred_stable_seconds: 30,
        failure_threshold: 2,
        cooldown_seconds: 30,
        request_timeout_seconds: 60,
      },
      providers: {
        official: {
          display_name: 'Official',
          base_url: 'https://api.openai.com/v1',
          has_key: true,
        },
      },
      provider_order: ['official'],
    }

    const snapshot = buildDevPreviewUsageSnapshot({
      now: 1_700_000_000_000,
      usageWindowHours: 24,
      usageFilterNodes: [],
      usageFilterProviders: [],
      usageFilterModels: [],
      usageFilterOrigins: [],
      config,
    })

    expect(snapshot.stats).not.toBeNull()
    expect(snapshot.overview).not.toBeNull()
  })
})
