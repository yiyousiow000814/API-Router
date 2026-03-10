import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Config, Status } from '../types'
import { ProviderGroupManagerModal } from './ProviderGroupManagerModal'

function buildConfig(): Config {
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
        base_url: 'https://example.com/p1',
        group: 'G1',
        has_key: true,
      },
      p2: {
        display_name: 'Provider 2',
        base_url: 'https://example.com/p2',
        group: 'G1',
        has_key: true,
      },
    },
    provider_order: ['p1', 'p2'],
  }
}

function buildStatusWithMixedWindows(): Status {
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
      p2: {
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
        monthly_spent_usd: null,
        monthly_budget_usd: null,
        last_error: '',
      },
      p2: {
        kind: 'budget_info',
        updated_at_unix_ms: 1,
        remaining: null,
        today_used: null,
        today_added: null,
        daily_spent_usd: null,
        daily_budget_usd: null,
        weekly_spent_usd: 30,
        weekly_budget_usd: 60,
        monthly_spent_usd: null,
        monthly_budget_usd: null,
        last_error: '',
      },
    },
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: { ok: false },
  }
}

describe('ProviderGroupManagerModal', () => {
  it('shows email actions and only visible cap periods for group members', () => {
    const html = renderToStaticMarkup(
      <ProviderGroupManagerModal
        open
        config={buildConfig()}
        status={buildStatusWithMixedWindows()}
        orderedConfigProviders={['p1', 'p2']}
        onClose={() => {}}
        onAssignGroup={async () => {}}
        onSetUsageBase={async () => {}}
        onClearUsageBase={async () => {}}
        onSetHardCap={async () => {}}
        onOpenProviderEmailModal={() => {}}
      />,
    )

    expect(html).toContain('Email')
    expect(html).toContain('daily cap')
    expect(html).toContain('weekly cap')
    expect(html).not.toContain('monthly cap')
  })
})
