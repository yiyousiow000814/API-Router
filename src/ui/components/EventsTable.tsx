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
        {events.map((e, idx) => (
          <tr key={`${e.unix_ms}-${idx}`}>
            <td>{fmtWhen(e.unix_ms)}</td>
            <td style={{ fontFamily: mono }}>{e.provider}</td>
            <td>{e.level}</td>
            <td className="aoCellWrap">{e.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

