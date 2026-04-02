import { describe, expect, it } from 'vitest'
import { simulateQuotaForDisplay } from './quotaSimulation'
import type { Status, UsageStatistics } from '../types'

function buildUsageStatistics(): UsageStatistics {
  return {
    ok: true,
    generated_at_unix_ms: 1_000,
    window_hours: 24,
    bucket_seconds: 300,
    summary: {
      total_requests: 10,
      total_tokens: 1000,
      unique_models: 1,
      estimated_total_cost_usd: 1.2,
      by_model: [],
      by_provider: [
        {
          provider: 'packycode',
          requests: 10,
          total_tokens: 1000,
          estimated_total_cost_usd: 1.2,
          estimated_avg_request_cost_usd: 0.12,
          estimated_cost_request_count: 10,
        },
      ],
      timeline: [],
    },
  }
}

describe('simulateQuotaForDisplay', () => {
  it('adds temporary spent delta from requests since last refresh', () => {
    const quota: Status['quota'][string] = {
      kind: 'budget_info',
      updated_at_unix_ms: 1_000,
      remaining: null,
      today_used: null,
      today_added: null,
      daily_spent_usd: 5,
      daily_budget_usd: 20,
      weekly_spent_usd: 10,
      weekly_budget_usd: 50,
      monthly_spent_usd: 15,
      monthly_budget_usd: 100,
      package_expires_at_unix_ms: null,
      last_error: '',
      effective_usage_base: 'https://codex.packycode.com',
    }

    const simulated = simulateQuotaForDisplay(
      'packycode',
      quota,
      {
        since_last_quota_refresh_requests: 3,
        since_last_quota_refresh_total_tokens: 300,
        last_reset_unix_ms: 1_000,
      },
      buildUsageStatistics(),
    )

    expect(simulated?.daily_spent_usd).toBeCloseTo(5.36, 6)
    expect(simulated?.weekly_spent_usd).toBeCloseTo(10.36, 6)
    expect(simulated?.monthly_spent_usd).toBeCloseTo(15.36, 6)
  })

  it('leaves balance snapshots unchanged', () => {
    const quota: Status['quota'][string] = {
      kind: 'balance_info',
      updated_at_unix_ms: 1_000,
      remaining: 42.5,
      today_used: null,
      today_added: null,
      daily_spent_usd: null,
      daily_budget_usd: null,
      weekly_spent_usd: null,
      weekly_budget_usd: null,
      monthly_spent_usd: null,
      monthly_budget_usd: null,
      package_expires_at_unix_ms: 2_000,
      last_error: '',
      effective_usage_base: 'https://codex-for.me',
    }

    expect(
      simulateQuotaForDisplay(
        'codex-for.me',
        quota,
        {
          since_last_quota_refresh_requests: 9,
          since_last_quota_refresh_total_tokens: 900,
          last_reset_unix_ms: 1_000,
        },
        buildUsageStatistics(),
      ),
    ).toEqual(quota)
  })

})
