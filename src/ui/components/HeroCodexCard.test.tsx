import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HeroCodexCard } from './HeroCodexCard'
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
            email: 'yiyousiow1@gmail.com',
            plan_label: 'Pro Lite',
            updated_at_unix_ms: Date.now(),
            active: true,
            limit_5h_remaining: '87%',
            limit_weekly_remaining: '13%',
          },
          {
            id: 'official_2',
            label: 'Official account 2',
            email: 'yiyousiow1234@gmail.com',
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
    expect(html).toContain('yiyousiow1@gmail.com')
    expect(html).toContain('yiyousiow1234@gmail.com')
    expect(html).toContain('Pro Lite')
    expect(html).toContain('Plus')
    expect(html).toContain('aoAccountsUsageBar')
    expect(html).toContain('5-hour')
    expect(html).toContain('Weekly')
    expect(html).toContain('aoAccountsMenuCurrentTag')
    expect(html).toContain('Current')
    expect(html).not.toContain('>Remove<')
    expect(html).toContain('Add account')
    expect(html.indexOf('yiyousiow1@gmail.com')).toBeLessThan(html.indexOf('yiyousiow1234@gmail.com'))
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
})
