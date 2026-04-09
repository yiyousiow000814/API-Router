import { describe, expect, it } from 'vitest'
import type { Config, Status } from '../types'
import {
  applyDevPreviewManualOverride,
  applyDevPreviewPreferredProvider,
  applyDevPreviewRouteMode,
  applyDevPreviewSessionPreferred,
} from './useAppActions'

function buildConfig(): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: 'provider_1',
      route_mode: 'follow_preferred_auto',
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 2,
      cooldown_seconds: 30,
      request_timeout_seconds: 60,
    },
    providers: {
      provider_1: {
        display_name: 'provider_1',
        base_url: 'https://example.com/v1',
        has_key: false,
      },
      provider_2: {
        display_name: 'provider_2',
        base_url: 'https://example.net/v1',
        has_key: false,
      },
    },
    provider_order: ['provider_1', 'provider_2'],
  }
}

function buildStatus(): Status {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    preferred_provider: 'provider_1',
    manual_override: null,
    providers: {
      provider_1: {
        status: 'healthy',
        consecutive_failures: 0,
        cooldown_until_unix_ms: 0,
        last_error: '',
        last_ok_at_unix_ms: 0,
        last_fail_at_unix_ms: 0,
      },
      provider_2: {
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
    client_sessions: [
      {
        id: 's1',
        codex_session_id: 's1',
        last_seen_unix_ms: 1,
        active: true,
        preferred_provider: null,
      },
    ],
    quota: {},
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: { ok: false },
  }
}

describe('useAppActions dev preview helpers', () => {
  it('updates route mode locally without backend', () => {
    const next = applyDevPreviewRouteMode(buildConfig(), 'balanced_auto')
    expect(next?.routing.route_mode).toBe('balanced_auto')
  })

  it('updates preferred provider in config and status locally', () => {
    const next = applyDevPreviewPreferredProvider(buildConfig(), buildStatus(), 'provider_2')
    expect(next.config?.routing.preferred_provider).toBe('provider_2')
    expect(next.status?.preferred_provider).toBe('provider_2')
  })

  it('updates session preferred provider locally', () => {
    const next = applyDevPreviewSessionPreferred(buildStatus(), 's1', 'provider_2')
    expect(next?.client_sessions?.[0]?.preferred_provider).toBe('provider_2')
  })

  it('updates manual override locally', () => {
    const next = applyDevPreviewManualOverride(buildStatus(), 'provider_2')
    expect(next?.manual_override).toBe('provider_2')
  })
})
