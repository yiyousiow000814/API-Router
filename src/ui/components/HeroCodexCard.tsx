import { useEffect, useRef, useState } from 'react'
import type { Status } from '../types'
import { fmtResetIn, fmtWhen } from '../utils/format'

type HeroCodexProps = {
  status: Status
  onLoginLogout: () => void
  onRefresh: () => void
  refreshing: boolean
  onSwapAuthConfig: () => void
  onSwapOptions: () => void
  swapBadgeText: string
  swapBadgeTitle: string
}

export function HeroCodexCard({
  status,
  onLoginLogout,
  onRefresh,
  refreshing,
  onSwapAuthConfig,
  onSwapOptions,
  swapBadgeText,
  swapBadgeTitle,
}: HeroCodexProps) {
  const [menuOpen, setMenuOpen] = useState<boolean>(false)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)

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
            {status.codex_account?.checked_at_unix_ms ? fmtWhen(status.codex_account.checked_at_unix_ms) : '-'}
          </div>
        </div>
      </div>
      <div className="aoDivider" />
      <div className="aoLimitGrid">
        <div className="aoLimitCard">
          <div className="aoMiniLabel">5-hour limit</div>
          <div className="aoLimitValue">{status.codex_account?.limit_5h_remaining ?? '-'}</div>
        </div>
        <div className="aoLimitCard">
          <div className="aoMiniLabel">Weekly limit</div>
          <div className="aoLimitValue">{status.codex_account?.limit_weekly_remaining ?? '-'}</div>
          {status.codex_account?.limit_weekly_remaining &&
          status.codex_account.limit_weekly_remaining !== '100%' &&
          status.codex_account?.limit_weekly_reset_at ? (
            <div className="aoHint aoResetHint" style={{ marginTop: 0 }}>
              {fmtResetIn(status.codex_account.limit_weekly_reset_at) ?? 'Reset soon'}
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
                className="aoSplitBtnBtn aoSplitBtnArrow"
                aria-label="Swap options"
                title="Swap options"
                onClick={() => setMenuOpen((v) => !v)}
              >
                ▼
              </button>
            </div>
            {menuOpen ? (
              <div className="aoMenu aoMenuCompact" role="menu" aria-label="Swap options menu">
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
                  Configure dirs
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