import type { Status } from '../types'
import { fmtAgo, fmtWhen } from '../utils/format'

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

type Props = {
  events: Status['recent_events']
  canClearErrors?: boolean
  onClearErrors?: () => void
}

export function EventsTable({ events, canClearErrors, onClearErrors }: Props) {
  const allEvents = events ?? []

  const errors = allEvents.filter((e) => e.level === 'error').slice(0, 5)
  const warnings = allEvents.filter((e) => e.level === 'warning').slice(0, 5)
  const infos = allEvents.filter((e) => e.level !== 'error' && e.level !== 'warning').slice(0, 5)

  const renderRow = (e: Status['recent_events'][number], key: string) => {
    const isError = e.level === 'error'
    const isWarning = e.level === 'warning'
    const f: Record<string, unknown> = e.fields ?? {}
    const isSessionPref =
      e.code === 'config.session_preferred_provider_updated' || e.code === 'config.session_preferred_provider_cleared'

    const wtSessionVal = f['wt_session']
    const legacySessionIdVal = f['session_id']
    const wt =
      typeof wtSessionVal === 'string'
        ? wtSessionVal
        : typeof legacySessionIdVal === 'string'
          ? legacySessionIdVal
          : null

    const codexSessionVal = f['codex_session_id']
    const codex = typeof codexSessionVal === 'string' ? codexSessionVal : null

    const pidVal = f['pid']
    const pid = typeof pidVal === 'number' ? pidVal : null

    const showSession = isSessionPref || !!codex || !!wt || pid !== null
    const sessionCell = showSession ? codex ?? wt ?? '-' : '-'
    const sessionTitle = showSession
      ? [codex ? `Codex session: ${codex}` : null, wt ? `WT_SESSION: ${wt}` : null, pid ? `pid: ${pid}` : null]
          .filter(Boolean)
          .join('\n')
      : ''

    return (
      <tr key={key} className={isError ? 'aoEventRowError' : isWarning ? 'aoEventRowWarning' : undefined}>
        <td title={fmtWhen(e.unix_ms)}>{fmtAgo(e.unix_ms)}</td>
        <td style={{ fontFamily: mono }} title={sessionTitle}>
          {sessionCell}
        </td>
        <td style={{ fontFamily: mono }}>{e.provider}</td>
        <td>
          <span
            className={`aoLevelBadge ${
              isError ? 'aoLevelBadgeError' : isWarning ? 'aoLevelBadgeWarning' : 'aoLevelBadgeInfo'
            }`}
          >
            {e.level}
          </span>
        </td>
        <td className="aoCellWrap">
          <span className="aoEventMessage" title={e.code ? `${e.code}: ${e.message}` : e.message}>
            {e.message}
          </span>
        </td>
      </tr>
    )
  }

  return (
    <table className="aoTable aoTableFixed">
      <thead>
        <tr>
          <th style={{ width: 140 }}>When</th>
          <th style={{ width: 200 }}>Session</th>
          <th style={{ width: 120 }}>Provider</th>
          <th style={{ width: 80 }}>Level</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        <tr className="aoEventsSection">
          <td colSpan={5}>
            <span>Info</span>
          </td>
        </tr>
        {infos.length ? (
          infos.map((e, idx) => renderRow(e, `${e.unix_ms}-info-${idx}`))
        ) : (
          <tr>
            <td colSpan={5} className="aoHint">
              No info events
            </td>
          </tr>
        )}

        {infos.length ? (
          <tr className="aoEventsGap" aria-hidden="true">
            <td colSpan={5} />
          </tr>
        ) : null}

        <tr className="aoEventsSection">
          <td colSpan={5}>
            <div className="aoEventsSectionRow">
              <div>
                <span>Errors / Warning</span>
              </div>
              {(errors.length || warnings.length) && onClearErrors ? (
                <button
                  className="aoEventsClearBtn"
                  onClick={onClearErrors}
                  disabled={!canClearErrors}
                  title="Clear visible errors/warnings (UI only)"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </td>
        </tr>
        {errors.length || warnings.length ? (
          [...warnings, ...errors]
            .sort((a, b) => b.unix_ms - a.unix_ms)
            .slice(0, 5)
            .map((e, idx) => renderRow(e, `${e.unix_ms}-issue-${idx}`))
        ) : (
          <tr>
            <td colSpan={5} className="aoHint">
              No errors or warnings
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

