import { useState } from 'react'
import { fmtWhen } from '../utils/format'
import { GATEWAY_WINDOWS_HOST } from '../constants'
import './SessionsTable.css'

type SessionRow = {
  id: string
  wt_session?: string | null
  codex_session_id?: string | null
  reported_model_provider?: string | null
  reported_model?: string | null
  reported_base_url?: string | null
  last_seen_unix_ms: number
  active: boolean
  preferred_provider?: string | null
  verified?: boolean
  is_agent?: boolean
  is_review?: boolean
}

type Props = {
  sessions: SessionRow[]
  providers: string[]
  globalPreferred: string
  updating: Record<string, boolean>
  onSetPreferred: (sessionId: string, provider: string | null) => void
  allowPreferredChanges?: boolean
}

export function isWslSessionRow(s: Pick<SessionRow, 'wt_session' | 'reported_base_url'>): boolean {
  const wt = (s.wt_session ?? '').trim().toLowerCase()
  if (wt.startsWith('wsl:')) return true

  const base = (s.reported_base_url ?? '').trim().toLowerCase()
  if (!base) return false
  let host = ''
  try {
    host = new URL(base).hostname.toLowerCase()
  } catch {
    host = ''
  }
  if (!host) return false
  if (
    host === GATEWAY_WINDOWS_HOST.toLowerCase() ||
    host === 'localhost' ||
    host === '::1'
  ) {
    return false
  }
  const parts = host.split('.')
  const ipv4 =
    parts.length === 4 &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  return ipv4
}

export function SessionsTable({
  sessions,
  providers,
  globalPreferred,
  updating,
  onSetPreferred,
  allowPreferredChanges = true,
}: Props) {
  function codexSessionIdOnly(raw: string | null | undefined): string | null {
    const v = (raw ?? '').trim()
    if (!v) return null
    // Legacy synthetic ids can be WT_SESSION-derived (e.g. `wsl:<wt-session>`).
    // Keep UI strict: Codex session column only shows real Codex session ids.
    if (v.toLowerCase().startsWith('wsl:')) return null
    return v
  }

  function isWslSession(s: SessionRow): boolean {
    return isWslSessionRow(s)
  }

  function sessionOriginClass(s: SessionRow): string {
    return isWslSession(s) ? 'aoSessionsIdWsl2' : 'aoSessionsIdWindows'
  }

  function codexProviderLabel(s: SessionRow): string {
    const verified = s.verified !== false
    const isAgent = s.is_agent === true
    const isReview = isAgent && s.is_review === true
    if (isReview) return 'review'
    if (isAgent) return 'agents'
    // If session is still unverified and we have no base_url evidence, provider id is often just
    // startup config hint and can be misleading.
    if (!verified && !(s.reported_base_url ?? '').trim()) return '-'
    return s.reported_model_provider ?? '-'
  }

  const verifiedRows = sessions.filter((s) => s.verified !== false)
  const unverifiedRows = sessions.filter((s) => s.verified === false)
  const [showUnverified, setShowUnverified] = useState(false)

  return (
    <table className="aoTable aoTableFixed">
      <thead>
        <tr>
          <th style={{ width: 200 }}>Codex session</th>
          <th className="aoSessionsCellCenter" style={{ width: 110 }}>
            State
          </th>
          <th style={{ width: 150 }}>Last seen</th>
          <th style={{ width: 160 }}>Codex provider</th>
          <th style={{ width: 130 }}>Model</th>
          <th>Routing provider</th>
          <th style={{ width: 260 }}>Preferred provider</th>
        </tr>
      </thead>
      <tbody>
        {sessions.length ? (
          <>
            {verifiedRows.length ? (
              verifiedRows.map((s) => {
                const verified = s.verified !== false
                const routingTarget = s.preferred_provider ?? globalPreferred
                const codexSession = codexSessionIdOnly(s.codex_session_id)
                const wt = s.wt_session ?? '-'
                const isAgent = s.is_agent === true
                const codexProvider = codexProviderLabel(s)
                const modelName = s.reported_model ?? '-'
                const originClass = sessionOriginClass(s)
                const wsl = isWslSession(s)
                const originBadgeClass = wsl
                  ? 'aoSessionOriginBadge aoSessionOriginBadgeWsl'
                  : 'aoSessionOriginBadge aoSessionOriginBadgeWindows'
                const originLabel = wsl ? 'WSL2' : 'WIN'
                const rowClass = isAgent
                  ? wsl
                    ? 'aoSessionRowAgent aoSessionRowAgentWsl'
                    : 'aoSessionRowAgent'
                  : undefined
                return (
                  <tr key={s.id} className={rowClass}>
                    <td className="aoSessionsMono">
                      {codexSession ? (
                        <div className={originClass} title={`WT_SESSION: ${wt}`}>
                          <span className={originBadgeClass}>{originLabel}</span>
                          {codexSession}
                        </div>
                      ) : (
                        <div className={originClass} title={`WT_SESSION: ${wt}`}>-</div>
                      )}
                    </td>
                    <td className="aoSessionsCellCenter">
                      <div className="aoSessionsCellCenterInner">
                        <span className="aoPill">
                          <span className={verified && s.active ? 'aoDot' : 'aoDot aoDotMuted'} />
                          <span className="aoPillText">{verified ? (s.active ? 'active' : 'idle') : 'unverified'}</span>
                        </span>
                      </div>
                    </td>
                    <td>{fmtWhen(s.last_seen_unix_ms)}</td>
                    <td className="aoSessionsMono">{codexProvider}</td>
                    <td className="aoSessionsMono">{modelName}</td>
                    <td className="aoSessionsMono">{routingTarget}</td>
                    <td>
                      <select
                        className="aoSelect"
                        value={s.preferred_provider ?? ''}
                        disabled={!!updating[s.id] || !allowPreferredChanges || !verified || !codexSession || isAgent}
                        onChange={(e) => {
                          const v = e.target.value
                          onSetPreferred(s.id, v ? v : null)
                        }}
                      >
                        <option value="">{`(follow global: ${globalPreferred})`}</option>
                        {providers.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={7} className="aoHint">
                  No verified sessions yet.
                </td>
              </tr>
            )}

            {!!unverifiedRows.length && (
              <tr>
                <td colSpan={7} className="aoHint">
                  <button
                    type="button"
                    className="aoIconGhost"
                    style={{ padding: 0, marginRight: 8 }}
                    onClick={() => setShowUnverified((v) => !v)}
                    aria-label={showUnverified ? 'Hide unverified sessions' : 'Show unverified sessions'}
                    title={showUnverified ? 'Hide unverified sessions' : 'Show unverified sessions'}
                  >
                    {showUnverified ? '[-]' : '[+]'}
                  </button>
                  <button
                    type="button"
                    className="aoHint"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                    onClick={() => setShowUnverified((v) => !v)}
                  >
                    Unverified (no request yet): {unverifiedRows.length}
                  </button>
                </td>
              </tr>
            )}

            {showUnverified && (
              <>
                <tr>
                  <td colSpan={7} className="aoHint">
                    Discovered in Windows Terminal, but API Router can&apos;t confirm their base_url yet. They&apos;ll become verified after the first request goes through the gateway.
                  </td>
                </tr>
                {unverifiedRows.map((s) => {
                  const verified = s.verified !== false
                  const routingTarget = s.preferred_provider ?? globalPreferred
                  const codexSession = codexSessionIdOnly(s.codex_session_id)
                  const wt = s.wt_session ?? '-'
                  const isAgent = s.is_agent === true
                  const codexProvider = codexProviderLabel(s)
                  const modelName = s.reported_model ?? '-'
                  const originClass = sessionOriginClass(s)
                  const wsl = isWslSession(s)
                  const originBadgeClass = wsl
                    ? 'aoSessionOriginBadge aoSessionOriginBadgeWsl'
                    : 'aoSessionOriginBadge aoSessionOriginBadgeWindows'
                  const originLabel = wsl ? 'WSL2' : 'WIN'
                  const rowClass = isAgent
                    ? wsl
                      ? 'aoSessionRowAgent aoSessionRowAgentWsl'
                      : 'aoSessionRowAgent'
                    : undefined
                  return (
                    <tr key={s.id} className={rowClass}>
                      <td className="aoSessionsMono">
                        {codexSession ? (
                          <div className={originClass} title={`WT_SESSION: ${wt}`}>
                            <span className={originBadgeClass}>{originLabel}</span>
                            {codexSession}
                          </div>
                        ) : (
                          <div className={originClass} title={`WT_SESSION: ${wt}`}>-</div>
                        )}
                      </td>
                      <td className="aoSessionsCellCenter">
                        <div className="aoSessionsCellCenterInner">
                          <span className="aoPill">
                            <span className={verified && s.active ? 'aoDot' : 'aoDot aoDotMuted'} />
                            <span className="aoPillText">{verified ? (s.active ? 'active' : 'idle') : 'unverified'}</span>
                          </span>
                        </div>
                      </td>
                      <td>{fmtWhen(s.last_seen_unix_ms)}</td>
                      <td className="aoSessionsMono">{codexProvider}</td>
                      <td className="aoSessionsMono">{modelName}</td>
                      <td className="aoSessionsMono">{routingTarget}</td>
                      <td>
                        <select
                          className="aoSelect"
                          value={s.preferred_provider ?? ''}
                          disabled={!!updating[s.id] || !allowPreferredChanges || !verified || !codexSession || isAgent}
                          onChange={(e) => {
                            const v = e.target.value
                            onSetPreferred(s.id, v ? v : null)
                          }}
                        >
                          <option value="">{`(follow global: ${globalPreferred})`}</option>
                          {providers.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </>
            )}
          </>
        ) : (
          <tr>
            <td colSpan={7} className="aoHint">
              No sessions yet. Start Codex from Windows Terminal. If Codex is configured to use API Router, it should appear here even before the first request.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
