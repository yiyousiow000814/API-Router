import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProvidersTable } from './ProvidersTable'
import type { Config, Status, UsageStatistics } from '../types'
import { fmtWhen } from '../utils/format'

function buildStatus(): Status {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    preferred_provider: 'packycode',
    manual_override: null,
    providers: {
      packycode: {
        status: 'closed',
        consecutive_failures: 5,
        cooldown_until_unix_ms: 0,
        last_error: 'request error: boom',
        last_ok_at_unix_ms: 0,
        last_fail_at_unix_ms: 1234,
      },
    },
    metrics: {},
    recent_events: [
      {
        provider: 'packycode',
        level: 'error',
        unix_ms: 1234,
        code: 'gateway.request_failed',
        message: 'request error: boom',
        fields: null,
      },
    ],
    active_provider: null,
    active_reason: null,
    active_provider_counts: {},
    quota: {
      packycode: {
        kind: 'budget_info',
        updated_at_unix_ms: 1234,
        remaining: null,
        today_used: null,
        today_added: null,
        daily_spent_usd: 120,
        daily_budget_usd: 120,
        weekly_spent_usd: 200,
        weekly_budget_usd: 300,
        monthly_spent_usd: null,
        monthly_budget_usd: null,
        package_expires_at_unix_ms: 1_900_000_000_000,
        last_error: '',
      },
    },
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: { ok: false },
  }
}

describe('ProvidersTable', () => {
  it('keeps Last Error jump button visible when provider is closed', () => {
    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['packycode']}
        status={buildStatus()}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )

    expect(html).toContain('aoLastErrorViewBtn')
  })

  it('shows package expiry when budget response includes subscription end', () => {
    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['packycode']}
        status={buildStatus()}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )

    expect(html).toContain('ends:')
  })

  it('shows each provider last error even when recent_events preview omits it', () => {
    const status = buildStatus()
    status.providers = {
      packycode: {
        status: 'unhealthy',
        consecutive_failures: 2,
        cooldown_until_unix_ms: 0,
        last_error: 'usage refresh failed: unexpected response',
        last_ok_at_unix_ms: 1_000,
        last_fail_at_unix_ms: 2_000,
      },
      packycode2: {
        status: 'unhealthy',
        consecutive_failures: 1,
        cooldown_until_unix_ms: 0,
        last_error: 'upstream returned 502',
        last_ok_at_unix_ms: 1_100,
        last_fail_at_unix_ms: 2_100,
      },
    }
    // Keep only one unrelated preview row: this reproduces the dashboard compact snapshot shape.
    status.recent_events = [
      {
        provider: 'packycode3',
        level: 'error',
        unix_ms: 2_200,
        code: 'gateway.request_failed',
        message: 'boom',
        fields: null,
      },
    ]

    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['packycode', 'packycode2']}
        status={status}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )
    const jumpButtons = html.match(/aoLastErrorViewBtn/g) ?? []
    expect(jumpButtons).toHaveLength(2)
  })

  it('hides stale last error once a newer healthy check succeeded', () => {
    const status = buildStatus()
    status.providers = {
      packycode: {
        status: 'healthy',
        consecutive_failures: 0,
        cooldown_until_unix_ms: 0,
        last_error: 'old refresh failure',
        last_ok_at_unix_ms: 3_000,
        last_fail_at_unix_ms: 2_000,
      },
    }

    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['packycode']}
        status={status}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )

    expect(html).not.toContain('aoLastErrorViewBtn')
    expect(html).toContain('<td>-</td>')
  })

  it('shows retry when unhealthy cooldown has already expired', () => {
    const status = buildStatus()
    status.providers = {
      packycode: {
        status: 'unhealthy',
        consecutive_failures: 3,
        cooldown_until_unix_ms: Date.now() - 1_000,
        last_error: 'stream failed',
        last_ok_at_unix_ms: 1_000,
        last_fail_at_unix_ms: 2_000,
      },
    }

    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['packycode']}
        status={status}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )

    expect(html).toContain('retry')
    expect(html).not.toContain('>no<')
  })

  it('shows offline immediately when browser reports offline', () => {
    const status = buildStatus()
    status.providers = {
      packycode: {
        status: 'healthy',
        consecutive_failures: 0,
        cooldown_until_unix_ms: 0,
        last_error: '',
        last_ok_at_unix_ms: 1_000,
        last_fail_at_unix_ms: 0,
      },
    }

    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: false },
    })

    try {
      const html = renderToStaticMarkup(
        <ProvidersTable
          providers={['packycode']}
          status={status}
          refreshingProviders={{}}
          onRefreshQuota={() => {}}
          onOpenLastErrorInEventLog={() => {}}
        />,
      )

      expect(html).toContain('offline')
      expect(html).not.toContain('>yes<')
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator)
      } else {
        delete (globalThis as { navigator?: Navigator }).navigator
      }
    }
  })

  it('hides unticked hard-cap usage rows from dashboard usage preview', () => {
    const config: Config = {
      listen: { host: '127.0.0.1', port: 4000 },
      routing: {
        preferred_provider: 'packycode',
        auto_return_to_preferred: true,
        preferred_stable_seconds: 30,
        failure_threshold: 2,
        cooldown_seconds: 20,
        request_timeout_seconds: 60,
      },
      providers: {
        packycode: {
          display_name: 'Packy Code',
          base_url: 'https://example.com',
          has_key: true,
          quota_hard_cap: {
            daily: true,
            weekly: false,
            monthly: true,
          },
        },
      },
    }

    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['packycode']}
        status={buildStatus()}
        config={config}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )

    expect(html).toContain('daily:')
    expect(html).not.toContain('weekly:')
  })

  it('shows simulated budget spend between real quota refreshes', () => {
    const status = buildStatus()
    status.ledgers = {
      packycode: {
        since_last_quota_refresh_requests: 3,
        since_last_quota_refresh_total_tokens: 300,
        last_reset_unix_ms: 1_000,
      },
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

    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['packycode']}
        status={status}
        usageStatistics={usageStatistics}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )

    expect(html).toContain('daily: $120.36 / $120')
  })

  it('shows codex-for dashboard daily and monthly values', () => {
    const status = buildStatus()
    status.providers = {
      'codex-for.me': {
        status: 'healthy',
        consecutive_failures: 0,
        cooldown_until_unix_ms: 0,
        last_error: '',
        last_ok_at_unix_ms: 0,
        last_fail_at_unix_ms: 0,
      },
    }
    status.quota = {
      'codex-for.me': {
        kind: 'budget_info',
        updated_at_unix_ms: 1234,
        remaining: 5959.08,
        today_used: null,
        today_added: null,
        daily_spent_usd: 26.03,
        daily_budget_usd: 200,
        weekly_spent_usd: null,
        weekly_budget_usd: null,
        monthly_spent_usd: 40.92,
        monthly_budget_usd: 6000.304,
        package_expires_at_unix_ms: 1_900_000_000_000,
        last_error: '',
      },
    }

    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['codex-for.me']}
        status={status}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )

    expect(html).toContain('daily: $26.03 / $200')
    expect(html).toContain('monthly: $40.92 / $6,000.304')
    expect(html).not.toContain('balance: $5,959.08')
    expect(html).not.toContain('account summary')
  })

  it('shows aigateway daily usage and date-only expiry', () => {
    const packageExpiresAtUnixMs = Date.parse('2026-04-02T14:02:27.679+08:00')
    const expectedDateOnly = fmtWhen(packageExpiresAtUnixMs).split(' ')[0]
    const status = buildStatus()
    status.providers = {
      aigateway: {
        status: 'healthy',
        consecutive_failures: 0,
        cooldown_until_unix_ms: 0,
        last_error: '',
        last_ok_at_unix_ms: 0,
        last_fail_at_unix_ms: 0,
      },
    }
    status.quota = {
      aigateway: {
        kind: 'budget_info',
        updated_at_unix_ms: 1234,
        remaining: 200,
        today_used: null,
        today_added: null,
        daily_spent_usd: 0,
        daily_budget_usd: 200,
        weekly_spent_usd: null,
        weekly_budget_usd: null,
        monthly_spent_usd: null,
        monthly_budget_usd: null,
        package_expires_at_unix_ms: packageExpiresAtUnixMs,
        last_error: '',
      },
    }

    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['aigateway']}
        status={status}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )

    expect(html).toContain('daily: $0 / $200')
    expect(html).toContain(`title="package ends: ${fmtWhen(packageExpiresAtUnixMs)}"`)
    expect(html).toContain(`ends: ${expectedDateOnly}`)
    expect(html).toContain(`>${`ends: ${expectedDateOnly}`}<`)
  })

  it('hides balance-only snapshots from the usage preview', () => {
    const status = buildStatus()
    status.providers = {
      'codex-for.me': {
        status: 'healthy',
        consecutive_failures: 0,
        cooldown_until_unix_ms: 0,
        last_error: '',
        last_ok_at_unix_ms: 0,
        last_fail_at_unix_ms: 0,
      },
    }
    status.quota = {
      'codex-for.me': {
        kind: 'balance_info',
        updated_at_unix_ms: 1234,
        remaining: 3402.19,
        today_used: null,
        today_added: null,
        daily_spent_usd: null,
        daily_budget_usd: null,
        weekly_spent_usd: null,
        weekly_budget_usd: null,
        monthly_spent_usd: null,
        monthly_budget_usd: null,
        package_expires_at_unix_ms: 1_900_000_000_000,
        last_error: '',
      },
    }

    const html = renderToStaticMarkup(
      <ProvidersTable
        providers={['codex-for.me']}
        status={status}
        refreshingProviders={{}}
        onRefreshQuota={() => {}}
        onOpenLastErrorInEventLog={() => {}}
      />,
    )

    expect(html).not.toContain('balance: $3,402.19')
    expect(html).not.toContain('account summary')
    expect(html).toContain('<span class="aoHint">-</span>')
  })
})
