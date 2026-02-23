import type * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Config, Status } from '../types'
import { createProviderCardRenderer } from './providerCardRenderer'

function buildConfig(quotaHardCap: Config['providers'][string]['quota_hard_cap']): Config {
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
        quota_hard_cap: quotaHardCap,
      },
    },
  }
}

function buildStatusWithoutWeeklyWindow(): Status {
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
        daily_spent_usd: 100,
        daily_budget_usd: 100,
        weekly_spent_usd: null,
        weekly_budget_usd: null,
        monthly_spent_usd: 1000,
        monthly_budget_usd: 1000,
        last_error: '',
      },
    },
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: { ok: false },
  }
}

function renderCardHtml(config: Config, status: Status): string {
  const setProviderNameDrafts = (() => undefined) as React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >
  const setEditingProviderName = (() => undefined) as React.Dispatch<
    React.SetStateAction<string | null>
  >
  const setConfig = (() => undefined) as React.Dispatch<React.SetStateAction<Config | null>>
  const renderer = createProviderCardRenderer({
    config,
    status,
    baselineBaseUrls: { p1: 'https://example.com' },
    dragOverProvider: null,
    dragBaseTop: 0,
    dragOffsetY: 0,
    isProviderOpen: () => true,
    registerProviderCardRef: () => () => undefined,
    onProviderHandlePointerDown: () => undefined,
    editingProviderName: null,
    providerNameDrafts: {},
    setProviderNameDrafts,
    setEditingProviderName,
    beginRenameProvider: () => undefined,
    commitRenameProvider: async () => undefined,
    saveProvider: async () => undefined,
    setProviderDisabled: async () => undefined,
    openKeyModal: async () => undefined,
    clearKey: async () => undefined,
    deleteProvider: async () => undefined,
    setConfig,
    toggleProviderOpen: () => undefined,
    openUsageBaseModal: async () => undefined,
    clearUsageBaseUrl: async () => undefined,
    setProviderQuotaHardCap: async () => undefined,
  })

  const card = renderer('p1')
  expect(card).not.toBeNull()
  return renderToStaticMarkup(card)
}

describe('provider hard cap rendering', () => {
  it('keeps weekly hard cap toggle visible when weekly budget data is missing', () => {
    const html = renderCardHtml(
      buildConfig({
        daily: false,
        weekly: true,
        monthly: false,
      }),
      buildStatusWithoutWeeklyWindow(),
    )

    expect(html).toContain('weekly hard cap')
    expect(html).not.toContain('Visible hard caps are off.')
  })

  it('shows absolute warning only when every hard cap is disabled', () => {
    const html = renderCardHtml(
      buildConfig({
        daily: false,
        weekly: false,
        monthly: false,
      }),
      buildStatusWithoutWeeklyWindow(),
    )

    expect(html).toContain('All hard caps are off, so this provider will not auto-close on budget exhaustion.')
  })
})
