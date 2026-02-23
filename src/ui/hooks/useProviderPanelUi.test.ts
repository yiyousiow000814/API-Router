import { describe, expect, it } from 'vitest'
import type { Config, Status } from '../types'
import { findMissingBudgetHardCapToggleToDisable } from './useProviderPanelUi'

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
