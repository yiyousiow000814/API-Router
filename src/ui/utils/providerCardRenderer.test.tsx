import type * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Config, Status } from '../types'
import { createProviderCardRenderer } from './providerCardRenderer'

function buildConfig(
  group: string | null,
  baseUrl = 'https://example.com',
  accountEmail: string | null = null,
  hasUsageToken = false,
): Config {
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
        base_url: baseUrl,
        group,
        has_key: true,
        account_email: accountEmail,
        has_usage_token: hasUsageToken,
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

function renderCardHtml(config: Config, status: Status, openProviderCapsMenu: string | null = null): string {
  const setProviderNameDrafts = (() => undefined) as React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >
  const setEditingProviderName = (() => undefined) as React.Dispatch<
    React.SetStateAction<string | null>
  >
  const renderer = createProviderCardRenderer({
    config,
    status,
    dragOverProvider: null,
    dragBaseTop: 0,
    dragOffsetY: 0,
    registerProviderCardRef: () => () => undefined,
    onProviderHandlePointerDown: () => undefined,
    editingProviderName: null,
    providerNameDrafts: {},
    setProviderNameDrafts,
    setEditingProviderName,
    beginRenameProvider: () => undefined,
    commitRenameProvider: async () => undefined,
    setProviderDisabled: async () => undefined,
    openProviderGroupManager: () => undefined,
    openProviderBaseUrlModal: () => undefined,
    setProviderSupportsWebsockets: async () => undefined,
    openKeyModal: async () => undefined,
    clearKey: async () => undefined,
    deleteProvider: async () => undefined,
    copyProviderFromConfigSource: async () => undefined,
    openUsageBaseModal: async () => undefined,
    openUsageAuthModal: async () => undefined,
    openProviderEmailModal: () => undefined,
    clearUsageBaseUrl: async () => undefined,
    setProviderQuotaHardCap: async () => undefined,
    showProviderWsTooltip: () => undefined,
    hideProviderWsTooltip: () => undefined,
    openProviderCapsMenu,
    toggleProviderCapsMenu: () => undefined,
  })

  const card = renderer('p1')
  expect(card).not.toBeNull()
  return renderToStaticMarkup(card)
}

describe('provider usage controls rendering', () => {
  it('shows direct usage controls when provider is not grouped', () => {
    const html = renderCardHtml(buildConfig(null), buildStatus())
    expect(html).toContain('Email')
    expect(html).not.toContain('Usage Auth')
    expect(html).toContain('Base URL')
    expect(html).toContain('Usage URL')
    expect(html).toContain('Caps')
    expect(html).toContain('2/2')
    expect(html).not.toContain('Usage controls')
    expect(html).not.toContain('Show')
    expect(html).not.toContain('Hide')
    expect(html).not.toContain('updated:')
    expect(html).not.toContain('Usage URL sets the usage endpoint.')
  })

  it('keeps the email action visible when an account email exists', () => {
    const html = renderCardHtml(buildConfig(null, 'https://example.com', 'user@example.com'), buildStatus())
    expect(html).toContain('Email')
    expect(html).not.toContain('email: user@example.com')
  })

  it('shows current group when provider has a group', () => {
    const html = renderCardHtml(buildConfig('alpha'), buildStatus())
    expect(html).toContain('Email')
    expect(html).toContain('Open Group Manager')
    expect(html).not.toContain('Current group: alpha')
  })

  it('shows websocket badge when provider supports websockets', () => {
    const config = buildConfig(null)
    config.providers.p1 = {
      ...config.providers.p1,
      supports_websockets: true,
    }
    const html = renderCardHtml(config, buildStatus())
    expect(html).toContain('WS')
    expect(html).toContain('Disable WebSocket')
  })

  it('disables grouped controls on borrowed providers', () => {
    const config = buildConfig('alpha')
    config.providers.p1 = {
      ...config.providers.p1,
      borrowed: true,
      editable: false,
    }
    const html = renderCardHtml(config, buildStatus())
    expect(html).toContain('Open Group Manager')
    expect(html).toContain('disabled=""')
  })

  it('hides hard-cap checkboxes when budget windows are not detected yet', () => {
    const html = renderCardHtml(buildConfig(null), buildStatusWithoutDetectedWindows())
    expect(html).not.toContain('daily cap')
    expect(html).not.toContain('weekly cap')
    expect(html).not.toContain('monthly cap')
  })

  it('uses usage url for codex-for login settings', () => {
    const html = renderCardHtml(buildConfig(null, 'https://api-vip.codex-for.vip/v1'), buildStatus())
    expect(html).toContain('Email')
    expect(html).not.toContain('Usage Auth')
    expect(html).toContain('Usage URL')
    expect(html).not.toContain('Usage URL sets the usage endpoint.')
  })

  it('uses only usage url for yfy host login settings', () => {
    const html = renderCardHtml(buildConfig(null, 'https://yfy.zhouyang168.top/v1'), buildStatus())
    expect(html).toContain('Email')
    expect(html).not.toContain('Usage Auth')
    expect(html).toContain('Usage URL')
  })

  it('keeps caps menu content out of the inline provider card markup', () => {
    const html = renderCardHtml(buildConfig(null), buildStatus(), 'p1')
    expect(html).toContain('Caps')
    expect(html).not.toContain('Quota hard caps')
    expect(html).not.toContain('daily cap')
  })

  it('hides caps controls for total-only usage presentation', () => {
    const config = buildConfig(null)
    config.providers.p1 = {
      ...config.providers.p1,
      usage_presentation: 'total_only',
    }
    const html = renderCardHtml(config, buildStatus())
    expect(html).not.toContain('Caps')
    expect(html).not.toContain('aoProviderCapsSummary')
  })

  it('keeps only usage url for packycode hosts', () => {
    const html = renderCardHtml(buildConfig(null, 'https://codex.packycode.com/v1'), buildStatus())
    expect(html).toContain('Email')
    expect(html).toContain('Usage URL')
    expect(html).not.toContain('Login')
    expect(html).not.toContain('Logout')
  })

  it('does not show auth button even when usage auth exists', () => {
    const html = renderCardHtml(buildConfig(null, 'https://codex.packycode.com/v1', null, true), buildStatus())
    expect(html).not.toContain('Logout')
    expect(html).not.toContain('Logged in')
  })

  it('does not show auth status pill on grouped cards', () => {
    const html = renderCardHtml(buildConfig('alpha', 'https://codex.packycode.com/v1', null, true), buildStatus())
    expect(html).not.toContain('Logged in')
    expect(html).not.toContain('Logout')
  })

  it('shows copied state for borrowed providers already copied locally', () => {
    const config = buildConfig(null)
    config.providers.p1 = {
      ...config.providers.p1,
      borrowed: true,
      editable: false,
      source_node_id: 'node-b',
      shared_provider_id: 'node-b:p1',
      local_copy_state: 'copied',
    }
    const html = renderCardHtml(config, buildStatus())
    expect(html).toContain('Copied')
    expect(html).not.toContain('>Copy<')
  })

  it('shows linked state when an equivalent local provider already exists', () => {
    const config = buildConfig(null)
    config.providers.p1 = {
      ...config.providers.p1,
      borrowed: true,
      editable: false,
      source_node_id: 'node-b',
      shared_provider_id: 'node-b:p1',
      local_copy_state: 'linked',
    }
    const html = renderCardHtml(config, buildStatus())
    expect(html).toContain('Linked')
    expect(html).not.toContain('>Copy<')
  })
})
