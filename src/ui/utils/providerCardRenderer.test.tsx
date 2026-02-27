import type * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Config, Status } from '../types'
import { createProviderCardRenderer } from './providerCardRenderer'

function buildConfig(group: string | null): Config {
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
        group,
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
        monthly_spent_usd: 100,
        monthly_budget_usd: 200,
        last_error: '',
      },
    },
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: { ok: false },
  }
}

function buildStatusWithoutDetectedWindows(): Status {
  const status = buildStatus()
  status.quota.p1 = {
    ...status.quota.p1,
    daily_spent_usd: null,
    daily_budget_usd: null,
    weekly_spent_usd: null,
    weekly_budget_usd: null,
    monthly_spent_usd: null,
    monthly_budget_usd: null,
  }
  return status
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
    openProviderGroupManager: () => undefined,
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

describe('provider usage controls rendering', () => {
  it('shows direct usage controls when provider is not grouped', () => {
    const html = renderCardHtml(buildConfig(null), buildStatus())
    expect(html).toContain('Usage Base')
    expect(html).toContain('daily hard cap')
    expect(html).toContain('monthly hard cap')
    expect(html).toContain('Usage base sets the usage endpoint.')
  })

  it('shows current group when provider has a group', () => {
    const html = renderCardHtml(buildConfig('alpha'), buildStatus())
    expect(html).toContain('Usage controls are managed in Group Manager.')
    expect(html).toContain('Open Group Manager')
    expect(html).toContain('Current group: alpha')
  })

  it('hides hard-cap checkboxes when budget windows are not detected yet', () => {
    const html = renderCardHtml(buildConfig(null), buildStatusWithoutDetectedWindows())
    expect(html).toContain('Budget windows not detected yet. Hard cap options are hidden until usage windows appear.')
    expect(html).not.toContain('daily hard cap')
    expect(html).not.toContain('weekly hard cap')
    expect(html).not.toContain('monthly hard cap')
  })
})
