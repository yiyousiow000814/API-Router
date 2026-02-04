import type { Status } from '../types'
import { fmtAgo, fmtWhen } from '../utils/format'

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

type Props = {
  events: Status['recent_events']
  canClearErrors?: boolean
  onClearErrors?: () => void
}

export function EventsTable({ events, canClearErrors, onClearErrors }: Props) {
  if (!events?.length) {
    return <div className="aoHint">-</div>
  }

  const errors = events.filter((e) => e.level === 'error').slice(0, 5)
  const infos = events.filter((e) => e.level !== 'error').slice(0, 5)

  const renderRow = (e: Status['recent_events'][number], key: string, isError: boolean) => (
    <tr key={key} className={isError ? 'aoEventRowError' : undefined}>
      <td title={fmtWhen(e.unix_ms)}>{fmtAgo(e.unix_ms)}</td>
      <td style={{ fontFamily: mono }}>{e.provider}</td>
      <td>
        <span className={`aoLevelBadge ${isError ? 'aoLevelBadgeError' : 'aoLevelBadgeInfo'}`}>
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

  return (
    <table className="aoTable aoTableFixed">
      <thead>
        <tr>
          <th style={{ width: 170 }}>When</th>
          <th style={{ width: 140 }}>Provider</th>
          <th style={{ width: 90 }}>Level</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        <tr className="aoEventsSection">
          <td colSpan={4}>
            <span>Info</span>
          </td>
        </tr>
        {infos.length ? (
          infos.map((e, idx) => renderRow(e, `${e.unix_ms}-info-${idx}`, false))
        ) : (
          <tr>
            <td colSpan={4} className="aoHint">
              No info events
            </td>
          </tr>
        )}

        {infos.length ? (
          <tr className="aoEventsGap" aria-hidden="true">
            <td colSpan={4} />
          </tr>
        ) : null}

        <tr className="aoEventsSection">
          <td colSpan={4}>
            <div className="aoEventsSectionRow">
              <div>
                <span>Errors</span>
              </div>
              {errors.length && onClearErrors ? (
                <button
                  className="aoEventsClearBtn"
                  onClick={onClearErrors}
                  disabled={!canClearErrors}
                  title="Clear visible errors (UI only)"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </td>
        </tr>
        {errors.length ? (
          errors.map((e, idx) => renderRow(e, `${e.unix_ms}-err-${idx}`, true))
        ) : (
          <tr>
            <td colSpan={4} className="aoHint">
              No errors
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

