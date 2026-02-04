import type { Status } from '../types'
import { fmtWhen } from '../utils/format'

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

type Props = {
  events: Status['recent_events']
}

export function EventsTable({ events }: Props) {
  if (!events?.length) {
    return <div className="aoHint">-</div>
  }

  const errors = events.filter((e) => e.level === 'error').slice(0, 5)
  const infos = events.filter((e) => e.level !== 'error').slice(0, 5)

  const renderTable = (rows: Status['recent_events']) => (
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
        {rows.map((e, idx) => (
          <tr key={`${e.unix_ms}-${idx}`} className={e.level === 'error' ? 'aoEventRowError' : ''}>
            <td>{fmtWhen(e.unix_ms)}</td>
            <td style={{ fontFamily: mono }}>{e.provider}</td>
            <td>{e.level}</td>
            <td className="aoCellWrap">{e.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <div className="aoEventsSplit">
      <div className="aoEventsBlock">
        <div className="aoEventsBlockTitle">
          <span>Errors</span>
          <span className="aoHint">({errors.length})</span>
        </div>
        {errors.length ? renderTable(errors) : <div className="aoHint">-</div>}
      </div>

      <div className="aoEventsBlock">
        <div className="aoEventsBlockTitle">
          <span>Info</span>
          <span className="aoHint">({infos.length})</span>
        </div>
        {infos.length ? renderTable(infos) : <div className="aoHint">-</div>}
      </div>
    </div>
  )
}

