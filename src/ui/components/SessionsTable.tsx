import { fmtWhen } from '../utils/format'

type SessionRow = {
  id: string
  wt_session?: string | null
  codex_session_id?: string | null
  last_seen_unix_ms: number
  active: boolean
  preferred_provider?: string | null
}

type Props = {
  sessions: SessionRow[]
  providers: string[]
  globalPreferred: string
  updating: Record<string, boolean>
  onSetPreferred: (sessionId: string, provider: string | null) => void
}

export function SessionsTable({ sessions, providers, globalPreferred, updating, onSetPreferred }: Props) {
  return (
    <table className="aoTable aoTableFixed">
      <thead>
        <tr>
          <th style={{ width: 220 }}>Codex session</th>
          <th className="aoCellCenter" style={{ width: 110 }}>
            State
          </th>
          <th style={{ width: 170 }}>Last seen</th>
          <th>Effective provider</th>
          <th style={{ width: 260 }}>Preferred provider</th>
        </tr>
      </thead>
      <tbody>
        {sessions.length ? (
          sessions.map((s) => {
            const effective = s.preferred_provider ?? globalPreferred
            const codexSession = s.codex_session_id ?? null
            const wt = s.wt_session ?? s.id
            return (
              <tr key={s.id}>
                <td style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>
                  {codexSession ? (
                    <div title={`WT_SESSION: ${wt}`}>{codexSession}</div>
                  ) : (
                    <div title={`WT_SESSION: ${wt}`}>-</div>
                  )}
                </td>
                <td className="aoCellCenter">
                  <div className="aoCellCenterInner">
                    <span className="aoPill">
                      <span className={s.active ? 'aoDot' : 'aoDot aoDotMuted'} />
                      <span className="aoPillText">{s.active ? 'active' : 'idle'}</span>
                    </span>
                  </div>
                </td>
                <td>{fmtWhen(s.last_seen_unix_ms)}</td>
                <td style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>{effective}</td>
                <td>
                  <select
                    className="aoSelect"
                    value={s.preferred_provider ?? ''}
                    disabled={!!updating[s.id]}
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
            <td colSpan={5} className="aoHint">
              No sessions yet. Start Codex from Windows Terminal. If Codex is configured to use API Router, it should
              appear here even before the first request.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
