import { useEffect, useMemo, useRef, useState } from 'react'
import type { OfficialAccountProfileSummary } from '../types'

type SwitchboardQuickSwitchProps = {
  activeMode: string | null
  activeModelProvider?: string | null
  providerSwitchBusy: boolean
  codexAccountProfiles: OfficialAccountProfileSummary[]
  codexAccountProfilesLoading: boolean
  onActivateOfficialAccountProfile: (profileId: string) => Promise<void>
  onSetProviderSwitchTarget: (target: 'gateway' | 'official' | 'provider', provider?: string) => Promise<void>
}

export function SwitchboardQuickSwitch({
  activeMode,
  activeModelProvider,
  providerSwitchBusy,
  codexAccountProfiles,
  codexAccountProfilesLoading,
  onActivateOfficialAccountProfile,
  onSetProviderSwitchTarget,
}: SwitchboardQuickSwitchProps) {
  const [officialMenuOpen, setOfficialMenuOpen] = useState(false)
  const officialMenuWrapRef = useRef<HTMLDivElement | null>(null)
  const activeOfficialProfile = useMemo(
    () => codexAccountProfiles.find((profile) => profile.active) ?? codexAccountProfiles[0] ?? null,
    [codexAccountProfiles],
  )
  const parsePct = (value?: string | null): number | null => {
    if (!value) return null
    const match = value.match(/(\d+(?:\.\d+)?)%/)
    if (!match) return null
    const parsed = Number(match[1])
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null
  }
  const renderAccountQuota = (profile: OfficialAccountProfileSummary) => {
    const has5h = Boolean(profile.limit_5h_remaining)
    const hasWeekly = Boolean(profile.limit_weekly_remaining)
    if (!has5h && !hasWeekly) {
      return <span className="aoAccountsQuotaFallback">Switch to inspect limits</span>
    }
    return (
      <div className="aoAccountsUsageStack">
        {has5h ? (
          <div className="aoAccountsUsageMetric">
            <div className="aoAccountsUsageMeta">
              <span className="aoAccountsUsageLabel">5-hour</span>
              <span className="aoAccountsUsageValue">{profile.limit_5h_remaining}</span>
            </div>
            <span className="aoAccountsUsageBar" aria-hidden="true">
              <span
                className="aoAccountsUsageBarFill"
                style={{ width: `${parsePct(profile.limit_5h_remaining) ?? 0}%` }}
              />
            </span>
          </div>
        ) : null}
        {hasWeekly ? (
          <div className="aoAccountsUsageMetric">
            <div className="aoAccountsUsageMeta">
              <span className="aoAccountsUsageLabel">Weekly</span>
              <span className="aoAccountsUsageValue">{profile.limit_weekly_remaining}</span>
            </div>
            <span className="aoAccountsUsageBar" aria-hidden="true">
              <span
                className="aoAccountsUsageBarFill"
                style={{ width: `${parsePct(profile.limit_weekly_remaining) ?? 0}%` }}
              />
            </span>
          </div>
        ) : null}
      </div>
    )
  }

  useEffect(() => {
    if (!officialMenuOpen) return
    function onDocMouseDown(e: MouseEvent) {
      const el = officialMenuWrapRef.current
      if (!el) return
      if (e.target instanceof Node && el.contains(e.target)) return
      setOfficialMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [officialMenuOpen])

  return (
    <div className="aoSwitchQuickGrid">
      <button
        className={`aoSwitchQuickBtn${activeMode === 'gateway' ? ' is-active' : ''}`}
        disabled={providerSwitchBusy}
        onClick={() => void onSetProviderSwitchTarget('gateway')}
      >
        <span className="aoSwitchQuickTitle">Gateway</span>
        <span className="aoSwitchQuickSub">Use local API Router</span>
      </button>
      <div className="aoActionsMenuWrap aoSwitchOfficialMenuWrap" ref={officialMenuWrapRef}>
        <button
          className={`aoSwitchQuickBtn${activeMode === 'official' ? ' is-active' : ''}`}
          disabled={providerSwitchBusy}
          onClick={() => {
            if (codexAccountProfiles.length > 1) {
              setOfficialMenuOpen((value) => !value)
              return
            }
            void onSetProviderSwitchTarget('official')
          }}
        >
          <span className="aoSwitchQuickTitle">Official</span>
          <span className="aoSwitchQuickSub">
            {codexAccountProfilesLoading
              ? 'Loading official accounts'
              : activeOfficialProfile
                ? activeOfficialProfile.label
                : 'Use official Codex auth'}
          </span>
        </button>
        {officialMenuOpen ? (
          <div className="aoMenu aoMenuCompact aoMenuCompactOffset aoAccountsMenu aoSwitchOfficialMenu" role="menu" aria-label="Official account switch menu">
            <div className="aoAccountsMenuHeader">
              <span className="aoAccountsMenuTitle">Official accounts</span>
            </div>
            <div className="aoAccountsMenuList">
              {codexAccountProfiles.map((profile) => (
                <div
                  key={profile.id}
                  className={`aoAccountsMenuRow aoAccountsMenuRowWide${profile.active ? ' aoAccountsMenuRowActive' : ''}`}
                >
                  <button
                    type="button"
                    className="aoAccountsMenuPrimary"
                    onClick={() => {
                      setOfficialMenuOpen(false)
                      void (async () => {
                        await onActivateOfficialAccountProfile(profile.id)
                        await onSetProviderSwitchTarget('official')
                      })()
                    }}
                  >
                    <span className="aoAccountsMenuText">
                      <span className="aoAccountsMenuTopline">
                        <span className="aoAccountsMenuLabel">{profile.label}</span>
                        {profile.active ? (
                          <span className="aoAccountsMenuCurrentTag">Current</span>
                        ) : null}
                      </span>
                      {renderAccountQuota(profile)}
                      <span className="aoAccountsMenuMeta">
                        Updated {new Date(profile.updated_at_unix_ms).toLocaleString('en-GB', {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        }).replace(',', '')}
                      </span>
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <button
        className={
          'aoSwitchQuickBtn aoSwitchQuickBtnHint' +
          (activeMode === 'provider' ? ' is-active' : '')
        }
        disabled
      >
        <span className="aoSwitchQuickTitle">Direct Provider</span>
        <span className="aoSwitchQuickSub">
          {activeMode === 'provider' && activeModelProvider
            ? 'Active: ' + activeModelProvider
            : 'Use selected provider below'}
        </span>
      </button>
    </div>
  )
}
