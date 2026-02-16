import { useState } from 'react'
import { fmtWhen } from '../utils/format'
import { GATEWAY_WINDOWS_HOST, GATEWAY_WSL2_HOST } from '../constants'
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

export function SessionsTable({
  sessions,
  providers,
  globalPreferred,
  updating,
  onSetPreferred,
  allowPreferredChanges = true,
}: Props) {
  function sessionOriginClass(s: SessionRow): string {
    const base = (s.reported_base_url ?? '').trim().toLowerCase()
    if (!base) return ''
    if (base.includes(`//${GATEWAY_WSL2_HOST.toLowerCase()}:`)) return 'aoSessionsIdWsl2'
    if (
      base.includes(`//${GATEWAY_WINDOWS_HOST.toLowerCase()}:`) ||
      base.includes('//localhost:')
    ) {
      return 'aoSessionsIdWindows'
    }
    return ''
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
                const codexSession = s.codex_session_id ?? null
                const wt = s.wt_session ?? '-'
                const isAgent = s.is_agent === true
                const isReview = isAgent && s.is_review === true
                const codexProvider = isReview
                  ? 'review'
                  : (isAgent ? 'agents' : (s.reported_model_provider ?? '-'))
                const modelName = s.reported_model ?? '-'
                const originClass = sessionOriginClass(s)
                return (
                  <tr key={s.id} className={isAgent ? 'aoSessionRowAgent' : undefined}>
                    <td className="aoSessionsMono">
                      {codexSession ? (
                        <div className={originClass} title={`WT_SESSION: ${wt}`}>{codexSession}</div>
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
                  const codexSession = s.codex_session_id ?? null
                  const wt = s.wt_session ?? '-'
                  const isAgent = s.is_agent === true
                  const isReview = isAgent && s.is_review === true
                  const codexProvider = isReview
                    ? 'review'
                    : (isAgent ? 'agents' : (s.reported_model_provider ?? '-'))
                  const modelName = s.reported_model ?? '-'
                  const originClass = sessionOriginClass(s)
                  return (
                    <tr key={s.id} className={isAgent ? 'aoSessionRowAgent' : undefined}>
                      <td className="aoSessionsMono">
                        {codexSession ? (
                          <div className={originClass} title={`WT_SESSION: ${wt}`}>{codexSession}</div>
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
