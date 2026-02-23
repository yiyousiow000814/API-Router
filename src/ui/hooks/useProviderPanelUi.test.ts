import { describe, expect, it } from 'vitest'
import type { Config, Status } from '../types'
import {
  canAutoDisableMissingHardCap,
  canStartMissingHardCapAutoDisable,
  findMissingBudgetHardCapToggleToDisable,
  markMissingHardCapAutoDisableAttempt,
  toMissingHardCapRetryKey,
} from './useProviderPanelUi'

function buildConfig(weeklyEnabled: boolean): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: 'p1',
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 2,
      cooldown_seconds: 20,
      request_timeout_seconds: 60,
    },
    providers: {
      p1: {
        display_name: 'Provider 1',
        base_url: 'https://example.com',
        has_key: true,
        quota_hard_cap: {
          daily: true,
          weekly: weeklyEnabled,
          monthly: true,
        },
      },
    },
  }
}

function buildStatusWithoutWeeklyWindow(kind: 'budget_info' | 'none' = 'budget_info'): Status {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    preferred_provider: 'p1',
    manual_override: null,
    providers: {
      p1: {
        status: 'healthy',
        consecutive_failures: 0,
        cooldown_until_unix_ms: 0,
        last_error: '',
        last_ok_at_unix_ms: 0,
        last_fail_at_unix_ms: 0,
      },
    },
    metrics: {},
    recent_events: [],
    quota: {
      p1: {
        kind,
        updated_at_unix_ms: 1,
        remaining: null,
        today_used: null,
        today_added: null,
        daily_spent_usd: 1,
        daily_budget_usd: 10,
        weekly_spent_usd: null,
        weekly_budget_usd: null,
        monthly_spent_usd: 10,
        monthly_budget_usd: 100,
        last_error: '',
      },
    },
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: { ok: false },
  }
}

describe('findMissingBudgetHardCapToggleToDisable', () => {
  it('returns weekly when weekly budget window is missing but weekly hard cap is enabled', () => {
    const result = findMissingBudgetHardCapToggleToDisable(buildConfig(true), buildStatusWithoutWeeklyWindow())
    expect(result).toEqual({ provider: 'p1', period: 'weekly' })
  })

  it('returns null when weekly hard cap is already disabled', () => {
    const result = findMissingBudgetHardCapToggleToDisable(buildConfig(false), buildStatusWithoutWeeklyWindow())
    expect(result).toBeNull()
  })

  it('returns null when provider quota kind is not budget_info', () => {
    const result = findMissingBudgetHardCapToggleToDisable(buildConfig(true), buildStatusWithoutWeeklyWindow('none'))
    expect(result).toBeNull()
  })
})

describe('missing hard cap auto-disable retry guard', () => {
  it('skips retry for the same provider+period until cooldown expires', () => {
    const retryAtByKey: Record<string, number> = {}
    const target = { provider: 'p1', period: 'weekly' as const }
    const nowMs = 1_000

    expect(canAutoDisableMissingHardCap(retryAtByKey, target, nowMs)).toBe(true)
    markMissingHardCapAutoDisableAttempt(retryAtByKey, target, nowMs, 30_000)
    expect(canAutoDisableMissingHardCap(retryAtByKey, target, nowMs + 29_999)).toBe(false)
    expect(canAutoDisableMissingHardCap(retryAtByKey, target, nowMs + 30_000)).toBe(true)
  })

  it('does not block a different provider+period key', () => {
    const retryAtByKey: Record<string, number> = {}
    const first = { provider: 'p1', period: 'weekly' as const }
    const second = { provider: 'p2', period: 'daily' as const }

    markMissingHardCapAutoDisableAttempt(retryAtByKey, first, 1_000, 30_000)
    expect(canAutoDisableMissingHardCap(retryAtByKey, second, 2_000)).toBe(true)
    expect(toMissingHardCapRetryKey(first)).toBe('p1:weekly')
    expect(toMissingHardCapRetryKey(second)).toBe('p2:daily')
  })

  it('blocks start when another auto-disable is already in flight', () => {
    const retryAtByKey: Record<string, number> = {}
    const inFlightKeys = new Set<string>()
    const target = { provider: 'p1', period: 'weekly' as const }

    expect(canStartMissingHardCapAutoDisable(inFlightKeys, retryAtByKey, target, 1_000, true)).toBe(false)
    expect(canStartMissingHardCapAutoDisable(inFlightKeys, retryAtByKey, target, 1_000, false)).toBe(true)
  })
})
