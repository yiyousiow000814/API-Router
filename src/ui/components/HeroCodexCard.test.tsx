import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { buildRemoteAccountRefreshKey, HeroCodexCard } from './HeroCodexCard'
import type { OfficialAccountProfileSummary, Status } from '../types'

function buildStatus(): Status {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    preferred_provider: 'p1',
    manual_override: null,
    providers: {},
    metrics: {},
    recent_events: [],
    quota: {},
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: {
      ok: true,
      signed_in: true,
      checked_at_unix_ms: Date.now(),
      limit_5h_remaining: '87%',
      limit_5h_reset_at: String(Date.now() + 2 * 60 * 60 * 1000),
    },
  }
}

describe('HeroCodexCard', () => {
  const profiles: OfficialAccountProfileSummary[] = [
    {
      id: 'official_1',
      label: 'Official account 1',
      email: 'user@example.com',
      plan_label: 'Plus',
      updated_at_unix_ms: Date.now(),
      active: true,
    },
  ]

  it('shows the 5-hour reset countdown when available', () => {
    const html = renderToStaticMarkup(
      <HeroCodexCard
        status={buildStatus()}
        onLoginLogout={() => {}}
        onRefresh={() => {}}
        refreshing={false}
        onSwapAuthConfig={() => {}}
        onSwapOptions={() => {}}
        swapTarget="both"
        swapTargetWindowsEnabled
        swapTargetWslEnabled
        onChangeSwapTarget={() => {}}
        swapBadgeText=""
        swapBadgeTitle=""
        profiles={profiles}
        profilesLoading={false}
        onActivateProfile={async () => {}}
        onRemoveProfile={async () => {}}
        onAddAccount={async () => {}}
      />,
    )

    expect(html).toContain('5-hour limit')
    expect(html).toContain('Reset in')
    expect(html).toContain('Accounts (1)')
  })

  it('uses the selected profile usage for the codex auth hero cards', () => {
    const html = renderToStaticMarkup(
      <HeroCodexCard
        status={buildStatus()}
        onLoginLogout={() => {}}
        onRefresh={() => {}}
        refreshing={false}
        onSwapAuthConfig={() => {}}
        onSwapOptions={() => {}}
        swapTarget="both"
        swapTargetWindowsEnabled
        swapTargetWslEnabled
        onChangeSwapTarget={() => {}}
        swapBadgeText=""
        swapBadgeTitle=""
        profiles={[
          {
            id: 'official_1',
            label: 'Official account 1',
            updated_at_unix_ms: Date.now(),
            active: true,
            limit_5h_remaining: '64%',
            limit_5h_reset_at: String(Date.now() + 5 * 60 * 60 * 1000),
            limit_weekly_remaining: '41%',
            limit_weekly_reset_at: String(Date.now() + 3 * 24 * 60 * 60 * 1000),
          },
        ]}
        profilesLoading={false}
        onActivateProfile={async () => {}}
        onRemoveProfile={async () => {}}
        onAddAccount={async () => {}}
      />,
    )

    expect(html).toContain('64%')
    expect(html).toContain('41%')
    expect(html).not.toContain('87%')
  })

  it('renders account usage bars and add action inside the official menu', () => {
    const html = renderToStaticMarkup(
      <HeroCodexCard
        status={buildStatus()}
        onLoginLogout={() => {}}
        onRefresh={() => {}}
        refreshing={false}
        onSwapAuthConfig={() => {}}
        onSwapOptions={() => {}}
        swapTarget="both"
        swapTargetWindowsEnabled
        swapTargetWslEnabled
        onChangeSwapTarget={() => {}}
        swapBadgeText=""
        swapBadgeTitle=""
        profiles={[
          {
            id: 'official_1',
            label: 'Official account 1 (signed out)',
            email: 'official.account1@example.com',
            plan_label: 'Pro Lite',
            updated_at_unix_ms: Date.now(),
            active: true,
            limit_5h_remaining: '87%',
            limit_weekly_remaining: '13%',
          },
          {
            id: 'official_2',
            label: 'Official account 2',
            email: 'official.account2@example.com',
            plan_label: 'Plus',
            updated_at_unix_ms: Date.now() - 1000,
            active: false,
            limit_5h_remaining: '64%',
            limit_weekly_remaining: '41%',
          },
        ]}
        profilesLoading={false}
        onActivateProfile={async () => {}}
        onRemoveProfile={async () => {}}
        onAddAccount={async () => {}}
        defaultAccountsMenuOpen
      />,
    )

    expect(html).toContain('aoAccountsMenu')
    expect(html).toContain('aoAccountsMenuRow')
    expect(html).toContain('aoAccountsMenuPrimary')
    expect(html).toContain('aoAccountsMenuRemove')
    expect(html).toContain('aoAccountsMenuAdd')
    expect(html).toContain('official.account1@example.com')
    expect(html).toContain('official.account2@example.com')
    expect(html).toContain('Pro Lite')
    expect(html).toContain('Plus')
    expect(html).toContain('aoAccountsUsageBar')
    expect(html).toContain('5-hour')
    expect(html).toContain('Weekly')
    expect(html).toContain('aoAccountsMenuCurrentTag')
    expect(html).toContain('Current')
    expect(html).not.toContain('>Remove<')
    expect(html).toContain('Add account')
    expect(html.indexOf('official.account1@example.com')).toBeLessThan(
      html.indexOf('official.account2@example.com'),
    )
  })

  it('uses cached-usage fallback text when a profile has no usage snapshot yet', () => {
    const html = renderToStaticMarkup(
      <HeroCodexCard
        status={buildStatus()}
        onLoginLogout={() => {}}
        onRefresh={() => {}}
        refreshing={false}
        onSwapAuthConfig={() => {}}
        onSwapOptions={() => {}}
        swapTarget="both"
        swapTargetWindowsEnabled
        swapTargetWslEnabled
        onChangeSwapTarget={() => {}}
        swapBadgeText=""
        swapBadgeTitle=""
        profiles={[
          {
            id: 'official_1',
            label: 'Official account 1',
            updated_at_unix_ms: Date.now(),
            active: true,
          },
        ]}
        profilesLoading={false}
        onActivateProfile={async () => {}}
        onRemoveProfile={async () => {}}
        onAddAccount={async () => {}}
        defaultAccountsMenuOpen
      />,
    )

    expect(html).toContain('No cached limits yet')
    expect(html).not.toContain('Switch to inspect limits')
  })

  it('renders remote official accounts as blurred use cards above add account', () => {
    const html = renderToStaticMarkup(
      <HeroCodexCard
        status={buildStatus()}
        onLoginLogout={() => {}}
        onRefresh={() => {}}
        refreshing={false}
        onSwapAuthConfig={() => {}}
        onSwapOptions={() => {}}
        swapTarget="both"
        swapTargetWindowsEnabled
        swapTargetWslEnabled
        onChangeSwapTarget={() => {}}
        swapBadgeText=""
        swapBadgeTitle=""
        profiles={profiles}
        profilesLoading={false}
        remoteProfiles={[
          {
            source_node_id: 'node-laptop',
            source_node_name: 'Yiyou-Laptop',
            remote_profile_id: 'official_remote_1',
            summary: {
              id: 'official_remote_1',
              label: 'Remote official account',
              email: 'remote@example.com',
              plan_label: 'Pro Lite',
              updated_at_unix_ms: Date.now(),
              active: false,
              limit_5h_remaining: '92%',
              limit_weekly_remaining: '81%',
            },
          },
        ]}
        remoteProfilesLoading={false}
        remoteProfileFollowBusy={{}}
        onActivateProfile={async () => {}}
        onRemoveProfile={async () => {}}
        onFollowRemoteProfile={async () => {}}
        onAddAccount={async () => {}}
        defaultAccountsMenuOpen
      />,
    )

    expect(html).toContain('aoAccountsMenuRowRemote')
    expect(html).toContain('aoAccountsRemoteFooter')
    expect(html).toContain('Use')
    expect(html).toContain('remote@example.com')
    expect(html).toContain('From Yiyou-Laptop')
    expect(html).toContain('Trusted devices')
    expect(html.indexOf('Use')).toBeLessThan(html.indexOf('Add account'))
  })

  it('changes the remote account refresh key when a trusted account peer appears', () => {
    const offlineStatus = buildStatus()
    offlineStatus.lan_sync = {
      enabled: true,
      discovery_port: 38455,
      heartbeat_interval_ms: 2000,
      peer_stale_after_ms: 20000,
      local_node: {
        node_id: 'node-syb',
        node_name: 'SYB',
        listen_addr: '192.168.3.137:51385',
        capabilities: ['official_accounts_v1'],
        provider_fingerprints: [],
      },
      peers: [],
    }
    const onlineStatus = buildStatus()
    onlineStatus.lan_sync = {
      ...offlineStatus.lan_sync,
      peers: [
        {
          node_id: 'node-desktop',
          node_name: 'DESKTOP-KK6SA2D',
          listen_addr: '192.168.3.210:4000',
          last_heartbeat_unix_ms: 1777572249004,
          capabilities: ['official_accounts_v1'],
          provider_fingerprints: [],
          trusted: true,
          sync_diagnostics: [
            {
              domain: 'official_accounts',
              status: 'ok',
              local_contract_version: 1,
              peer_contract_version: 1,
              blocked_reason: null,
            },
          ],
          http_probe_state: 'ok',
        },
      ],
    }

    expect(buildRemoteAccountRefreshKey(offlineStatus)).toBe('')
    expect(buildRemoteAccountRefreshKey(onlineStatus)).toBe(
      'node-desktop:192.168.3.210:4000:ok:ok:1:1',
    )
  })

  it('keeps the remote account refresh key stable across heartbeat churn', () => {
    const status = buildStatus()
    status.lan_sync = {
      enabled: true,
      discovery_port: 38455,
      heartbeat_interval_ms: 2000,
      peer_stale_after_ms: 20000,
      local_node: {
        node_id: 'node-syb',
        node_name: 'SYB',
        listen_addr: '192.168.3.137:51385',
        capabilities: ['official_accounts_v1'],
        provider_fingerprints: [],
      },
      peers: [
        {
          node_id: 'node-desktop',
          node_name: 'DESKTOP-KK6SA2D',
          listen_addr: '192.168.3.210:4000',
          last_heartbeat_unix_ms: 1,
          capabilities: ['official_accounts_v1'],
          provider_fingerprints: [],
          trusted: true,
          sync_diagnostics: [
            {
              domain: 'official_accounts',
              status: 'ok',
              local_contract_version: 1,
              peer_contract_version: 1,
            },
          ],
          http_probe_state: 'ok',
        },
      ],
    }
    const lanSync = status.lan_sync
    expect(lanSync).toBeDefined()
    const nextStatus: Status = {
      ...status,
      lan_sync: {
        ...lanSync!,
        peers: lanSync!.peers.map((peer) => ({
          ...peer,
          last_heartbeat_unix_ms: 2,
          heartbeat_age_ms: 100,
        })),
      },
    }

    expect(buildRemoteAccountRefreshKey(nextStatus)).toBe(
      buildRemoteAccountRefreshKey(status),
    )
  })
})
