import { useEffect, useMemo, useRef, useState } from 'react'
import type { OfficialAccountProfileSummary } from '../types'
import { officialAccountDisplayName } from '../utils/codexAccountProfiles'
import { OfficialAccountQuotaSummary } from './OfficialAccountQuotaSummary'

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
                ? officialAccountDisplayName(activeOfficialProfile)
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
                        <span className="aoAccountsMenuLabel">
                          {officialAccountDisplayName(profile)}
                        </span>
                        <span className="aoAccountsMenuTags">
                          {profile.plan_label ? (
                            <span className="aoAccountsMenuPlanTag">{profile.plan_label}</span>
                          ) : null}
                          {profile.active ? (
                            <span className="aoAccountsMenuCurrentTag">Current</span>
                          ) : null}
                        </span>
                      </span>
                      <OfficialAccountQuotaSummary profile={profile} />
                      <span className="aoAccountsMenuMeta">
                        Usage updated {new Date(profile.usage_updated_at_unix_ms ?? profile.updated_at_unix_ms).toLocaleString('en-GB', {
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
