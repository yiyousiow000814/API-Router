import { useEffect, useRef, useState } from 'react'
import type { OfficialAccountProfileSummary, RemoteOfficialAccountProfile, Status } from '../types'
import { fmtResetIn, fmtWhen } from '../utils/format'
import { officialAccountDisplayName } from '../utils/codexAccountProfiles'
import { OfficialAccountQuotaSummary } from './OfficialAccountQuotaSummary'

type HeroCodexProps = {
  status: Status
  onLoginLogout: () => void
  onRefresh: () => void
  refreshing: boolean
  onSwapAuthConfig: () => void
  onSwapOptions: () => void
  swapTarget: 'windows' | 'wsl2' | 'both'
  swapTargetWindowsEnabled: boolean
  swapTargetWslEnabled: boolean
  onChangeSwapTarget: (target: 'windows' | 'wsl2' | 'both') => void
  swapBadgeText: string
  swapBadgeTitle: string
  profiles: OfficialAccountProfileSummary[]
  profilesLoading: boolean
  remoteProfiles?: RemoteOfficialAccountProfile[]
  remoteProfilesLoading?: boolean
  remoteProfileFollowBusy?: Record<string, boolean>
  onActivateProfile: (profileId: string) => Promise<void>
  onRemoveProfile: (profileId: string) => Promise<void>
  onFollowRemoteProfile?: (sourceNodeId: string, remoteProfileId: string) => Promise<void>
  onRefreshRemoteProfiles?: () => Promise<void>
  onAddAccount: () => Promise<void>
  defaultAccountsMenuOpen?: boolean
}

export function HeroCodexCard({
  status,
  onLoginLogout,
  onRefresh,
  refreshing,
  onSwapAuthConfig,
  onSwapOptions,
  swapTarget,
  swapTargetWindowsEnabled,
  swapTargetWslEnabled,
  onChangeSwapTarget,
  swapBadgeText,
  swapBadgeTitle,
  profiles,
  profilesLoading,
  remoteProfiles = [],
  remoteProfilesLoading = false,
  remoteProfileFollowBusy = {},
  onActivateProfile,
  onRemoveProfile,
  onFollowRemoteProfile = async () => {},
  onRefreshRemoteProfiles = async () => {},
  onAddAccount,
  defaultAccountsMenuOpen = false,
}: HeroCodexProps) {
  const [menuOpen, setMenuOpen] = useState<boolean>(false)
  const [accountsMenuOpen, setAccountsMenuOpen] = useState<boolean>(defaultAccountsMenuOpen)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  const accountsMenuWrapRef = useRef<HTMLDivElement | null>(null)
  const swapTargetLabel = swapTarget === 'windows' ? 'Windows' : swapTarget === 'wsl2' ? 'WSL2' : 'Both'
  const availableTargets: Array<'windows' | 'wsl2' | 'both'> = []
  const selectedProfile = profiles.find((profile) => profile.active) ?? null
  const displayedCheckedAt =
    selectedProfile?.updated_at_unix_ms ?? status.codex_account?.checked_at_unix_ms
  const displayed5hRemaining =
    selectedProfile?.limit_5h_remaining ?? status.codex_account?.limit_5h_remaining ?? '-'
  const displayed5hResetAt =
    selectedProfile?.limit_5h_reset_at ?? status.codex_account?.limit_5h_reset_at
  const displayedWeeklyRemaining =
    selectedProfile?.limit_weekly_remaining ??
    status.codex_account?.limit_weekly_remaining ??
    '-'
  const displayedWeeklyResetAt =
    selectedProfile?.limit_weekly_reset_at ?? status.codex_account?.limit_weekly_reset_at
  if (swapTargetWindowsEnabled && swapTargetWslEnabled) availableTargets.push('both')
  if (swapTargetWindowsEnabled) availableTargets.push('windows')
  if (swapTargetWslEnabled) availableTargets.push('wsl2')
  const canChooseTarget = availableTargets.length > 1

  useEffect(() => {
    if (!menuOpen) return
    function onDocMouseDown(e: MouseEvent) {
      const el = menuWrapRef.current
      if (!el) return
      if (e.target instanceof Node && el.contains(e.target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [menuOpen])

  useEffect(() => {
    if (!accountsMenuOpen) return
    function onDocMouseDown(e: MouseEvent) {
      const el = accountsMenuWrapRef.current
      if (!el) return
      if (e.target instanceof Node && el.contains(e.target)) return
      setAccountsMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [accountsMenuOpen])

  return (
    <div className="aoCard aoHeroCard aoHeroCodex">
      <div className="aoCardHeader">
        <div className="aoCardTitle">Codex (Auth)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="aoPill">
            <span className={status.codex_account?.signed_in ? 'aoDot' : 'aoDot aoDotBad'} />
            <span className="aoPillText">{status.codex_account?.signed_in ? 'signed in' : 'signed out'}</span>
          </span>
          <button
            className={`aoUsageRefreshBtn aoUsageRefreshBtnMini${refreshing ? ' aoUsageRefreshBtnSpin' : ''}`}
            title="Refresh"
            aria-label="Refresh"
            onClick={onRefresh}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
              <path d="M1 14l5.3 5.3A9 9 0 0 0 20.5 15" />
            </svg>
          </button>
          {status.codex_account?.signed_in ? (
            <button
              className="aoIconBtn aoIconBtnMini aoIconBtnDangerSoft"
              title="Log out"
              aria-label="Log out"
              onClick={onLoginLogout}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10 17l5-5-5-5" />
                <path d="M15 12H3" />
                <path d="M21 3v18" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
      <div className="aoKvp">
        <div className="aoKey">Checked</div>
        <div className="aoKvpRight">
          <div className="aoVal">
            {displayedCheckedAt ? fmtWhen(displayedCheckedAt) : '-'}
          </div>
        </div>
      </div>
      <div className="aoDivider" />
      <div className="aoLimitGrid">
        <div className="aoLimitCard">
          <div className="aoMiniLabel">5-hour limit</div>
          <div className="aoLimitValue">{displayed5hRemaining}</div>
          {displayed5hRemaining &&
          displayed5hRemaining !== '100%' &&
          displayed5hResetAt ? (
            <div className="aoHint aoResetHint" style={{ marginTop: 0 }}>
              {fmtResetIn(displayed5hResetAt) ?? 'Reset soon'}
            </div>
          ) : null}
        </div>
        <div className="aoLimitCard">
          <div className="aoMiniLabel">Weekly limit</div>
          <div className="aoLimitValue">{displayedWeeklyRemaining}</div>
          {displayedWeeklyRemaining &&
          displayedWeeklyRemaining !== '100%' &&
          displayedWeeklyResetAt ? (
            <div className="aoHint aoResetHint" style={{ marginTop: 0 }}>
              {fmtResetIn(displayedWeeklyResetAt) ?? 'Reset soon'}
            </div>
          ) : null}
        </div>
        <div className="aoLimitCard">
          <div className="aoMiniLabel">Code review</div>
          <div className="aoLimitValue">{status.codex_account?.code_review_remaining ?? '-'}</div>
          {status.codex_account?.code_review_remaining &&
          status.codex_account.code_review_remaining !== '100%' &&
          status.codex_account?.code_review_reset_at ? (
            <div className="aoHint aoResetHint" style={{ marginTop: 0 }}>
              {fmtResetIn(status.codex_account.code_review_reset_at) ?? 'Reset soon'}
            </div>
          ) : null}
        </div>
      </div>
      <div
        className="aoHeroActions"
        style={{
          marginTop: 15,
          width: '100%',
          justifyContent: status.codex_account?.signed_in ? 'flex-end' : 'space-between',
        }}
      >
        {!status.codex_account?.signed_in ? (
          <button className="aoBtn" onClick={onLoginLogout}>
            Log in
          </button>
        ) : null}
        <div className="aoHeroCodexActionsRow">
          {profiles.length ? (
            <div className="aoActionsMenuWrap aoHeroCodexAccountsWrap" ref={accountsMenuWrapRef}>
              <button
                className="aoBtn aoHeroCodexAccountsBtn"
                type="button"
                onClick={() => {
                  setAccountsMenuOpen((value) => {
                    const next = !value
                    if (next) {
                      void onRefreshRemoteProfiles()
                    }
                    return next
                  })
                }}
                title={profilesLoading ? 'Loading accounts...' : 'Official accounts'}
              >
                {`Accounts (${profiles.length})`}
              </button>
              {accountsMenuOpen ? (
                <div className="aoMenu aoMenuCompact aoMenuCompactOffset aoAccountsMenu" role="menu" aria-label="Official accounts menu">
                  <div className="aoAccountsMenuHeader">
                    <span className="aoAccountsMenuTitle">Official accounts</span>
                  </div>
                  <div className="aoAccountsMenuList">
                    {profiles.map((profile) => (
                      <div
                        key={profile.id}
                        className={`aoAccountsMenuRow${profile.active ? ' aoAccountsMenuRowActive' : ''}`}
                      >
                        <button
                          type="button"
                          className="aoAccountsMenuPrimary"
                          onClick={() => {
                            setAccountsMenuOpen(false)
                            void onActivateProfile(profile.id)
                          }}
                        >
                          <span className="aoAccountsMenuText">
                              <span className="aoAccountsMenuTopline">
                              <span
                                className="aoAccountsMenuLabel"
                                title={officialAccountDisplayName(profile)}
                              >
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
                              Usage updated {fmtWhen(profile.usage_updated_at_unix_ms ?? profile.updated_at_unix_ms)}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="aoAccountsMenuRemove"
                          onClick={() => void onRemoveProfile(profile.id)}
                          title={`Remove ${profile.label}`}
                          aria-label={`Remove ${profile.label}`}
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M4 4l8 8" />
                            <path d="M12 4l-8 8" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    {remoteProfiles.length || remoteProfilesLoading ? (
                      <div className="aoAccountsRemoteDivider" aria-hidden="true">
                        <span />
                        <strong>Trusted devices</strong>
                        <span />
                      </div>
                    ) : null}
                    {remoteProfiles.map((remote) => {
                      const followKey = `${remote.source_node_id}:${remote.remote_profile_id}`
                      const followBusy = Boolean(remoteProfileFollowBusy[followKey])
                      return (
                        <div
                          key={followKey}
                          className="aoAccountsMenuRow aoAccountsMenuRowRemote"
                        >
                          <span className="aoAccountsMenuText">
                            <span className="aoAccountsMenuTopline aoAccountsRemoteTopline">
                              <span
                                className="aoAccountsMenuLabel"
                                title={officialAccountDisplayName(remote.summary)}
                              >
                                {officialAccountDisplayName(remote.summary)}
                              </span>
                              <span className="aoAccountsMenuTags">
                                {remote.summary.plan_label ? (
                                  <span className="aoAccountsMenuPlanTag">
                                    {remote.summary.plan_label}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                            <span className="aoAccountsRemoteCardContent" aria-hidden="true">
                              <OfficialAccountQuotaSummary profile={remote.summary} />
                            </span>
                          </span>
                          <div className="aoAccountsRemoteFooter">
                            <span className="aoAccountsMenuMeta aoAccountsRemoteMeta">
                              From {remote.source_node_name || remote.source_node_id}
                            </span>
                            <button
                              type="button"
                              className="aoTinyBtn aoAccountsRemoteFollow"
                              disabled={followBusy}
                              onClick={() =>
                                void onFollowRemoteProfile(
                                  remote.source_node_id,
                                  remote.remote_profile_id,
                                )
                              }
                            >
                              {followBusy ? 'Using' : 'Use'}
                            </button>
                            <span aria-hidden="true" />
                          </div>
                        </div>
                      )
                    })}
                    {remoteProfilesLoading ? (
                      <div className="aoAccountsMenuRemoteLoading">Checking trusted devices...</div>
                    ) : null}
                  </div>
                  <div className="aoAccountsMenuFooter">
                    <div className="aoAccountsMenuDivider" />
                    <button
                      type="button"
                      className="aoAccountsMenuAdd"
                      onClick={() => {
                        setAccountsMenuOpen(false)
                        void onAddAccount()
                      }}
                    >
                      <span className="aoMenuIcon" aria-hidden="true">+</span>
                      Add account
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="aoActionsMenuWrap" ref={menuWrapRef} style={{ justifyContent: 'flex-start' }}>
            <div className="aoSplitBtn aoSplitBtnPrimary" title={swapBadgeTitle}>
              <button className="aoSplitBtnBtn" onClick={onSwapAuthConfig}>
                Swap
                {swapBadgeText ? (
                  <span className="aoBtnTag" aria-label={`Swap status: ${swapBadgeText}`}>
                    <span
                      className={[
                        'aoBtnTagDot',
                        swapBadgeText === 'Auth'
                          ? 'aoBtnTagDotApp'
                          : swapBadgeText === 'Error'
                            ? 'aoBtnTagDotError'
                          : swapBadgeText === 'Mixed'
                            ? 'aoBtnTagDotMixed'
                            : 'aoBtnTagDotUser',
                      ].join(' ')}
                      aria-hidden="true"
                    />
                    {swapBadgeText}
                  </span>
                ) : null}
              </button>
              <span className="aoSplitBtnDivider" aria-hidden="true" />
              <button
                className="aoSplitBtnBtn aoSplitBtnArrow aoSplitBtnArrowLabel"
                aria-label="Swap options"
                title={`Swap target: ${swapTargetLabel}`}
                onClick={() => setMenuOpen((v) => !v)}
              >
                {swapTargetLabel} ▼
              </button>
            </div>
            {menuOpen ? (
              <div className="aoMenu aoMenuCompact aoMenuCompactOffset" role="menu" aria-label="Swap options menu">
                {canChooseTarget && availableTargets.includes('both') ? (
                  <button
                    className="aoMenuItem"
                    role="menuitemradio"
                    aria-checked={swapTarget === 'both'}
                    onClick={() => {
                      setMenuOpen(false)
                      onChangeSwapTarget('both')
                    }}
                  >
                    <span className="aoMenuIcon" aria-hidden="true">{swapTarget === 'both' ? '•' : ''}</span>
                    Swap target: Both
                  </button>
                ) : null}
                {canChooseTarget && availableTargets.includes('windows') ? (
                  <button
                    className="aoMenuItem"
                    role="menuitemradio"
                    aria-checked={swapTarget === 'windows'}
                    onClick={() => {
                      setMenuOpen(false)
                      onChangeSwapTarget('windows')
                    }}
                  >
                    <span className="aoMenuIcon" aria-hidden="true">{swapTarget === 'windows' ? '•' : ''}</span>
                    Swap target: Windows
                  </button>
                ) : null}
                {canChooseTarget && availableTargets.includes('wsl2') ? (
                  <button
                    className="aoMenuItem"
                    role="menuitemradio"
                    aria-checked={swapTarget === 'wsl2'}
                    onClick={() => {
                      setMenuOpen(false)
                      onChangeSwapTarget('wsl2')
                    }}
                  >
                    <span className="aoMenuIcon" aria-hidden="true">{swapTarget === 'wsl2' ? '•' : ''}</span>
                    Swap target: WSL2
                  </button>
                ) : null}
                <button
                  className="aoMenuItem"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onSwapOptions()
                  }}
                >
                  <span className="aoMenuIcon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                    </svg>
                  </span>
                  Configure directories
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {status.codex_account?.error ? (
        <div className="aoHint" style={{ marginTop: 8, color: 'rgba(145, 12, 43, 0.92)' }}>
          {status.codex_account.error}
        </div>
      ) : null}
    </div>
  )
}
