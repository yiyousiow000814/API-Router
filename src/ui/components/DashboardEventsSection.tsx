import { EventsTable } from './EventsTable'
import type { Status } from '../types'

type Props = {
  visibleEvents: Status['recent_events']
  canClearErrors: boolean
  onClearErrors: () => void
}

export function DashboardEventsSection({ visibleEvents, canClearErrors, onClearErrors }: Props) {
  return (
    <div className="aoSection">
      <div className="aoSectionHeader">
        <div className="aoRow">
          <h3 className="aoH3">Events</h3>
        </div>
      </div>
      <EventsTable events={visibleEvents} canClearErrors={canClearErrors} onClearErrors={onClearErrors} />
    </div>
  )
}
