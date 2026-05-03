import { describe, expect, it } from 'vitest'
import type { Config, Status } from '../types'
import { buildProviderCapsMenuData } from './providerCapsMenu'

function buildConfig(): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: 'p1',
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 3,
      cooldown_seconds: 20,
      request_timeout_seconds: 60,
    },
    providers: {
      p1: {
        display_name: 'Provider 1',
        base_url: 'https://example.com',
        has_key: true,
      },
    },
  }
}

function buildStatus(): Status {
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
        kind: 'budget_info',
        updated_at_unix_ms: 1,
        remaining: null,
        today_used: null,
        today_added: null,
        daily_spent_usd: 10,
        daily_budget_usd: 20,
        weekly_spent_usd: null,
        weekly_budget_usd: null,
        monthly_spent_usd: 30,
        monthly_budget_usd: 40,
        last_error: '',
      },
    },
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: { ok: false },
  }
}

describe('buildProviderCapsMenuData', () => {
  it('returns null when the config modal is closed even if menu state remains', () => {
    const data = buildProviderCapsMenuData(false, buildConfig(), buildStatus(), {
      provider: 'p1',
      left: 200,
      top: 100,
    })
    expect(data).toBeNull()
  })

  it('builds visible periods only for detected budget windows', () => {
    const data = buildProviderCapsMenuData(true, buildConfig(), buildStatus(), {
      provider: 'p1',
      left: 200,
      top: 100,
    })
    expect(data).not.toBeNull()
    expect(data?.periods).toEqual(['daily', 'monthly'])
  })

  it('returns null for total-only usage presentation', () => {
    const config = buildConfig()
    config.providers.p1 = {
      ...config.providers.p1,
      usage_presentation: 'total_only',
    }
    const data = buildProviderCapsMenuData(true, config, buildStatus(), {
      provider: 'p1',
      left: 200,
      top: 100,
    })
    expect(data).toBeNull()
  })
})
