import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { Config, Status } from '../types'
import { ProviderGroupManagerModal } from './ProviderGroupManagerModal'

function buildConfig(mode: 'local' | 'follow'): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: 'packycode',
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 3,
      cooldown_seconds: 20,
      request_timeout_seconds: 60,
    },
    providers: {
      packycode: {
        display_name: 'packycode',
        base_url: 'https://codex.packycode.com/v1',
        group: 'PACKYCODE',
        has_key: true,
        account_email: 'a@example.com',
        has_usage_login: true,
      },
      packycode4: {
        display_name: 'packycode4',
        base_url: 'https://codex.packycode.com/v1',
        group: 'PACKYCODE',
        has_key: true,
        account_email: 'b@example.com',
        has_usage_login: true,
      },
    },
    provider_order: ['packycode', 'packycode4'],
    config_source: {
      mode,
      followed_node_id: mode === 'follow' ? 'node-owner' : null,
      sources: [
        {
          kind: 'local',
          node_id: 'node-local',
          node_name: 'Local',
          active: mode === 'local',
          follow_allowed: false,
          follow_blocked_reason: null,
          using_count: 0,
        },
      ],
    },
  }
}

function buildStatus(): Status {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    preferred_provider: 'packycode',
    manual_override: null,
    providers: {
      packycode: {
        status: 'healthy',
        consecutive_failures: 0,
        cooldown_until_unix_ms: 0,
        last_error: '',
        last_ok_at_unix_ms: 0,
        last_fail_at_unix_ms: 0,
      },
      packycode4: {
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
      packycode: {
        kind: 'budget_info',
        updated_at_unix_ms: 1,
        remaining: null,
        today_used: null,
        today_added: null,
        daily_spent_usd: 1,
        daily_budget_usd: 10,
        weekly_spent_usd: 2,
        weekly_budget_usd: 20,
        monthly_spent_usd: 3,
        monthly_budget_usd: 30,
        last_error: '',
      },
      packycode4: {
        kind: 'budget_info',
        updated_at_unix_ms: 1,
        remaining: null,
        today_used: null,
        today_added: null,
        daily_spent_usd: 1,
        daily_budget_usd: 10,
        weekly_spent_usd: 2,
        weekly_budget_usd: 20,
        monthly_spent_usd: 3,
        monthly_budget_usd: 30,
        last_error: '',
      },
    },
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: { ok: false },
  }
}

describe('ProviderGroupManagerModal', () => {
  it('keeps group controls readonly while following a remote config source', () => {
    const html = renderToStaticMarkup(
      <ProviderGroupManagerModal
        open
        config={buildConfig('follow')}
        status={buildStatus()}
        orderedConfigProviders={['packycode', 'packycode4']}
        onClose={() => undefined}
        onAssignGroup={async () => undefined}
        onSetUsageBase={async () => undefined}
        onClearUsageBase={async () => undefined}
        onClearUsageAuth={async () => undefined}
        onSetHardCap={async () => undefined}
        onOpenProviderEmailModal={() => undefined}
        onOpenUsageAuthModal={async () => undefined}
      />,
    )

    expect(html).toContain('disabled=""')
    expect(html).toContain('Group Manager')
  })
})
