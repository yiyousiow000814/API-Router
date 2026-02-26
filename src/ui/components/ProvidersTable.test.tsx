import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProvidersTable } from './ProvidersTable'
import type { Status } from '../types'

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
})
