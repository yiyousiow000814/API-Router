import { fmtWhen } from '../utils/format'

type SessionRow = {
  id: string
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
          <th style={{ width: 160 }}>Session</th>
          <th style={{ width: 110 }}>State</th>
          <th style={{ width: 260 }}>Preferred provider</th>
          <th style={{ width: 170 }}>Last seen</th>
          <th>Effective</th>
        </tr>
      </thead>
      <tbody>
        {sessions.length ? (
          sessions.map((s) => {
            const effective = s.preferred_provider ?? globalPreferred
            return (
              <tr key={s.id}>
                <td style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>{s.id}</td>
                <td>
                  <span className="aoPill">
                    <span className={s.active ? 'aoDot' : 'aoDot aoDotMuted'} />
                    <span className="aoPillText">{s.active ? 'active' : 'inactive'}</span>
                  </span>
                </td>
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
                <td>{fmtWhen(s.last_seen_unix_ms)}</td>
                <td style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>{effective}</td>
              </tr>
            )
          })
        ) : (
          <tr>
            <td colSpan={5} className="aoHint">
              No sessions yet. Start Codex with a tagged token like{' '}
              <span style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>
                token|wt_session=...
              </span>
              .
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

