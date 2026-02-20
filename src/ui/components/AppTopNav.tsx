import { useCallback, useRef } from 'react'

type TopPage = 'dashboard' | 'usage_statistics' | 'usage_requests' | 'provider_switchboard' | 'event_log'

type AppTopNavProps = {
  activePage: TopPage
  onSwitchPage: (next: TopPage) => void
  onOpenGettingStarted: () => void
  onUsageStatisticsIntent?: () => void
  onUsageRequestsIntent?: () => void
}

const PREFETCH_PROXIMITY_RADIUS_PX = 54

function isPointerNearButton(event: React.MouseEvent<HTMLDivElement>, button: HTMLButtonElement | null): boolean {
  if (!button) return false
  const rect = button.getBoundingClientRect()
  return (
    event.clientX >= rect.left - PREFETCH_PROXIMITY_RADIUS_PX &&
    event.clientX <= rect.right + PREFETCH_PROXIMITY_RADIUS_PX &&
    event.clientY >= rect.top - PREFETCH_PROXIMITY_RADIUS_PX &&
    event.clientY <= rect.bottom + PREFETCH_PROXIMITY_RADIUS_PX
  )
}

export function AppTopNav({
  activePage,
  onSwitchPage,
  onOpenGettingStarted,
  onUsageStatisticsIntent,
  onUsageRequestsIntent,
}: AppTopNavProps) {
  const usageBtnRef = useRef<HTMLButtonElement | null>(null)
  const requestsBtnRef = useRef<HTMLButtonElement | null>(null)

  const handleTopNavPointerIntent = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (isPointerNearButton(event, usageBtnRef.current)) onUsageStatisticsIntent?.()
      if (isPointerNearButton(event, requestsBtnRef.current)) onUsageRequestsIntent?.()
    },
    [onUsageRequestsIntent, onUsageStatisticsIntent],
  )

  return (
    <div className="aoBrandRight">
      <div className="aoTopNav" role="tablist" aria-label="Main pages" onMouseMove={handleTopNavPointerIntent}>
        <button
          className={`aoTopNavBtn${activePage === 'dashboard' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={activePage === 'dashboard'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            onSwitchPage('dashboard')
          }}
          onClick={() => onSwitchPage('dashboard')}
        >
          <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" />
            <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" />
            <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" />
            <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" />
          </svg>
          <span>Dashboard</span>
        </button>
        <button
          ref={requestsBtnRef}
          className={`aoTopNavBtn${activePage === 'usage_requests' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={activePage === 'usage_requests'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            onSwitchPage('usage_requests')
          }}
          onClick={() => onSwitchPage('usage_requests')}
          onFocus={() => onUsageRequestsIntent?.()}
        >
          <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4.5" y="4.5" width="10.5" height="15" rx="1.8" />
            <path d="M7.5 8h4.5" />
            <path d="M7.5 12h4.5" />
            <path d="M17 9.5h3" />
            <path d="M20 9.5 18.6 8.1" />
            <path d="M20 9.5 18.6 10.9" />
            <path d="M17 14.5h3" />
            <path d="M20 14.5 18.6 13.1" />
            <path d="M20 14.5 18.6 15.9" />
          </svg>
          <span>Requests</span>
        </button>
        <button
          ref={usageBtnRef}
          className={`aoTopNavBtn${activePage === 'usage_statistics' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={activePage === 'usage_statistics'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            onSwitchPage('usage_statistics')
          }}
          onClick={() => onSwitchPage('usage_statistics')}
          onFocus={() => onUsageStatisticsIntent?.()}
        >
          <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 19.5h16" />
            <path d="M7 17.5V9.5" />
            <path d="M12 17.5V5.5" />
            <path d="M17 17.5V12.5" />
            <path d="M5.5 6.5 9 9l4-3.5 4 2.5" />
          </svg>
          <span>Analytics</span>
        </button>
        <button
          className={`aoTopNavBtn${activePage === 'provider_switchboard' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={activePage === 'provider_switchboard'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            onSwitchPage('provider_switchboard')
          }}
          onClick={() => onSwitchPage('provider_switchboard')}
        >
          <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h11" />
            <path d="M4 17h16" />
            <circle cx="17" cy="7" r="3" />
            <circle cx="9" cy="17" r="3" />
          </svg>
          <span>Provider Switchboard</span>
        </button>
        <button
          className={`aoTopNavBtn${activePage === 'event_log' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={activePage === 'event_log'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            onSwitchPage('event_log')
          }}
          onClick={() => onSwitchPage('event_log')}
        >
          <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 4.5h14" />
            <path d="M5 9.5h14" />
            <path d="M5 14.5h14" />
            <path d="M5 19.5h10" />
          </svg>
          <span>Events</span>
        </button>
      </div>
      <button className="aoTinyBtn" aria-label="Getting Started" onClick={onOpenGettingStarted}>
        Getting Started
      </button>
    </div>
  )
}
