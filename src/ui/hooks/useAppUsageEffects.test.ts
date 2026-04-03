import { describe, expect, it } from 'vitest'
import {
  buildUsageRefreshRevision,
  buildUsageHistoryQuotaRefreshToken,
  shouldRefreshUsageHistoryFromQuotaToken,
  shouldRefreshUsageSilently,
  usageRefreshMode,
  usageStatisticsRefreshIntervalMs,
} from './useAppUsageEffects'

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

  it('uses overview only on dashboard and full stats only on usage page', () => {
    expect(usageRefreshMode('dashboard')).toBe('overview')
    expect(usageRefreshMode('usage_statistics')).toBe('full')
    expect(usageRefreshMode('event_log')).toBeNull()
  })

  it('changes the history refresh token when quota snapshots advance', () => {
    const before = buildUsageHistoryQuotaRefreshToken({
      aigateway: {
        kind: 'budget_info',
        updated_at_unix_ms: 100,
        remaining: null,
        today_used: null,
        today_added: null,
        daily_spent_usd: 17.47,
        daily_budget_usd: 200,
        monthly_spent_usd: null,
        monthly_budget_usd: null,
        last_error: '',
      },
    })
    const after = buildUsageHistoryQuotaRefreshToken({
      aigateway: {
        kind: 'budget_info',
        updated_at_unix_ms: 200,
        remaining: null,
        today_used: null,
        today_added: null,
        daily_spent_usd: 94.406078,
        daily_budget_usd: 200,
        monthly_spent_usd: null,
        monthly_budget_usd: null,
        last_error: '',
      },
    })

    expect(after).not.toBe(before)
  })

  it('changes the refresh revision when usage filters change', () => {
    const before = buildUsageRefreshRevision({
      usageWindowHours: 24,
      usageFilterNodes: ['windows'],
      usageFilterProviders: ['aigateway'],
      usageFilterModels: [],
      usageFilterOrigins: [],
    })
    const after = buildUsageRefreshRevision({
      usageWindowHours: 24,
      usageFilterNodes: ['windows'],
      usageFilterProviders: ['official'],
      usageFilterModels: [],
      usageFilterOrigins: [],
    })

    expect(after).not.toBe(before)
  })

  it('only refreshes history from quota changes after the modal has loaded once', () => {
    expect(
      shouldRefreshUsageHistoryFromQuotaToken({
        usageHistoryModalOpen: false,
        usageHistoryLoaded: true,
        usageHistoryQuotaRefreshToken: 'aigateway:1:1:1',
      }),
    ).toBe(false)
    expect(
      shouldRefreshUsageHistoryFromQuotaToken({
        usageHistoryModalOpen: true,
        usageHistoryLoaded: false,
        usageHistoryQuotaRefreshToken: 'aigateway:1:1:1',
      }),
    ).toBe(false)
    expect(
      shouldRefreshUsageHistoryFromQuotaToken({
        usageHistoryModalOpen: true,
        usageHistoryLoaded: true,
        usageHistoryQuotaRefreshToken: '',
      }),
    ).toBe(false)
    expect(
      shouldRefreshUsageHistoryFromQuotaToken({
        usageHistoryModalOpen: true,
        usageHistoryLoaded: true,
        usageHistoryQuotaRefreshToken: 'aigateway:1:1:1',
      }),
    ).toBe(true)
  })

  it('normalizes usage refresh revision inputs so equivalent selections stay stable', () => {
    const left = buildUsageRefreshRevision({
      usageWindowHours: 24,
      usageFilterNodes: [' wsl2 ', 'windows'],
      usageFilterProviders: ['b', 'a'],
      usageFilterModels: [' gpt-5 ', 'gpt-4'],
      usageFilterOrigins: ['windows'],
    })
    const right = buildUsageRefreshRevision({
      usageWindowHours: 24,
      usageFilterNodes: ['windows', 'wsl2'],
      usageFilterProviders: ['a', 'b'],
      usageFilterModels: ['gpt-4', 'gpt-5'],
      usageFilterOrigins: ['windows'],
    })

    expect(left).toBe(right)
  })
})
