import { describe, expect, it } from 'vitest'
import { buildCodexSwapBadge, buildSwitchboardProviderCards } from './switchboard'
import type { Config, ProviderSwitchboardStatus, Status, UsageStatistics } from '../types'

describe('buildCodexSwapBadge', () => {
  it('returns Mixed when scoped provider dirs use different providers', () => {
    const status: ProviderSwitchboardStatus = {
      ok: true,
      mode: 'provider',
      model_provider: 'packycode',
      dirs: [
        { cli_home: 'C:\\Users\\u\\.codex', mode: 'provider', model_provider: 'packycode' },
        {
          cli_home: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex',
          mode: 'provider',
          model_provider: 'pumpkinai',
        },
      ],
      provider_options: ['packycode', 'pumpkinai'],
    }
    const badge = buildCodexSwapBadge(null, status)
    expect(badge.badgeText).toBe('Mixed')
  })

  it('keeps DP label when scoped provider dirs agree on provider', () => {
    const status: ProviderSwitchboardStatus = {
      ok: true,
      mode: 'provider',
      model_provider: 'packycode',
      dirs: [
        { cli_home: 'C:\\Users\\u\\.codex', mode: 'provider', model_provider: 'packycode' },
        {
          cli_home: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex',
          mode: 'provider',
          model_provider: 'packycode',
        },
      ],
      provider_options: ['packycode'],
    }
    const badge = buildCodexSwapBadge(null, status)
    expect(badge.badgeText).toBe('DP:packycode')
  })

  it('uses projected ledgers for usage projection when available', () => {
    const config: Config = {
      listen: { host: '127.0.0.1', port: 4000 },
      routing: {
        preferred_provider: 'packycode',
        auto_return_to_preferred: true,
        preferred_stable_seconds: 30,
        failure_threshold: 3,
        cooldown_seconds: 30,
        request_timeout_seconds: 300,
      },
      providers: {
        packycode: {
          display_name: 'Packycode',
          base_url: 'https://example.test',
          has_key: true,
        },
      },
    }
    const status: Status = {
      listen: { host: '127.0.0.1', port: 4000 },
      preferred_provider: 'packycode',
      manual_override: null,
      providers: {},
      metrics: {},
      recent_events: [],
      quota: {
        packycode: {
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
        },
      },
      ledgers: {
        packycode: {
          since_last_quota_refresh_requests: 1,
          since_last_quota_refresh_total_tokens: 100,
          last_reset_unix_ms: 1_000,
        },
      },
      projected_ledgers: {
        packycode: {
          since_last_quota_refresh_requests: 9,
          since_last_quota_refresh_total_tokens: 900,
          last_reset_unix_ms: 1_000,
        },
      },
      last_activity_unix_ms: 1_000,
      codex_account: { ok: false },
    }
    const usageStatistics: UsageStatistics = {
      ok: true,
      generated_at_unix_ms: 1_000,
      window_hours: 24,
      bucket_seconds: 300,
      summary: {
        total_requests: 10,
        total_tokens: 1000,
        input_tokens: 600,
        output_tokens: 400,
        unique_models: 1,
        top_model: null,
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

    const cards = buildSwitchboardProviderCards(['packycode'], config, status, usageStatistics, {
      fmtPct: (value) => `${Math.round((value ?? 0) * 100)}%`,
      fmtAmount: (value) => `${value ?? 0}`,
      fmtUsd: (value) => `${value ?? 0}`,
      pctOf: (value, total) => (value != null && total ? value / total : null),
    })

    expect(cards[0]?.usageDetail).toContain('6.08')
  })
})
