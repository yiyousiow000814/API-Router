import { useCallback, useEffect, useRef, useState } from 'react'

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
  const dashboardBtnRef = useRef<HTMLButtonElement | null>(null)
  const switchboardBtnRef = useRef<HTMLButtonElement | null>(null)
  const eventsBtnRef = useRef<HTMLButtonElement | null>(null)
  const [visualActivePage, setVisualActivePage] = useState<TopPage>(activePage)

  const applyImmediateNavActive = useCallback((next: TopPage) => {
    const refs: Record<TopPage, HTMLButtonElement | null> = {
      dashboard: dashboardBtnRef.current,
      usage_requests: requestsBtnRef.current,
      usage_statistics: usageBtnRef.current,
      provider_switchboard: switchboardBtnRef.current,
      event_log: eventsBtnRef.current,
    }
    for (const [page, btn] of Object.entries(refs)) {
      if (!btn) continue
      const isActive = page === next
      btn.classList.toggle('is-active', isActive)
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false')
    }
  }, [])

  useEffect(() => {
    setVisualActivePage(activePage)
    applyImmediateNavActive(activePage)
  }, [activePage, applyImmediateNavActive])

  const activateAndSwitch = useCallback(
    (next: TopPage) => {
      applyImmediateNavActive(next)
      setVisualActivePage(next)
      onSwitchPage(next)
    },
    [applyImmediateNavActive, onSwitchPage],
  )

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
          ref={dashboardBtnRef}
          className={`aoTopNavBtn${visualActivePage === 'dashboard' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={visualActivePage === 'dashboard'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            activateAndSwitch('dashboard')
          }}
          onClick={() => activateAndSwitch('dashboard')}
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
          className={`aoTopNavBtn${visualActivePage === 'usage_requests' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={visualActivePage === 'usage_requests'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            onUsageRequestsIntent?.()
            activateAndSwitch('usage_requests')
          }}
          onClick={() => activateAndSwitch('usage_requests')}
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
          className={`aoTopNavBtn${visualActivePage === 'usage_statistics' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={visualActivePage === 'usage_statistics'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            activateAndSwitch('usage_statistics')
          }}
          onClick={() => activateAndSwitch('usage_statistics')}
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
          ref={switchboardBtnRef}
          className={`aoTopNavBtn${visualActivePage === 'provider_switchboard' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={visualActivePage === 'provider_switchboard'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            activateAndSwitch('provider_switchboard')
          }}
          onClick={() => activateAndSwitch('provider_switchboard')}
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
          ref={eventsBtnRef}
          className={`aoTopNavBtn${visualActivePage === 'event_log' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={visualActivePage === 'event_log'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            activateAndSwitch('event_log')
          }}
          onClick={() => activateAndSwitch('event_log')}
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
