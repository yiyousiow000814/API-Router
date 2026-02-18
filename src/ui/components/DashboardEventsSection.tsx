import { EventsTable } from './EventsTable'
import type { Status } from '../types'

type Props = {
  visibleEvents: Status['recent_events']
  canClearErrors: boolean
  onClearErrors: () => void
  title?: string
  splitByLevel?: boolean
  scrollInside?: boolean
  showHeader?: boolean
  scrollPersistKey?: string
}

export function DashboardEventsSection({
  visibleEvents,
  canClearErrors,
  onClearErrors,
  title = 'Events',
  splitByLevel = true,
  scrollInside = false,
  showHeader = true,
  scrollPersistKey,
}: Props) {
  return (
    <div className="aoSection">
      {showHeader ? (
        <div className="aoSectionHeader">
          <div className="aoRow">
            <h3 className="aoH3">{title}</h3>
          </div>
        </div>
      ) : null}
      <EventsTable
        events={visibleEvents}
        canClearErrors={canClearErrors}
        onClearErrors={onClearErrors}
        splitByLevel={splitByLevel}
        scrollInside={scrollInside}
        scrollPersistKey={scrollPersistKey}
      />
    </div>
  )
}
