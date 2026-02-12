import './AppShared.css'

type TopPage = 'dashboard' | 'usage_statistics' | 'provider_switchboard'

type AppTopNavProps = {
  activePage: TopPage
  onSwitchPage: (next: TopPage) => void
  onOpenGettingStarted: () => void
}

export function AppTopNav({ activePage, onSwitchPage, onOpenGettingStarted }: AppTopNavProps) {
  return (
    <div className="aoBrandRight">
      <div className="aoTopNav" role="tablist" aria-label="Main pages">
        <button
          className={`aoTopNavBtn${activePage === 'dashboard' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={activePage === 'dashboard'}
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
          className={`aoTopNavBtn${activePage === 'usage_statistics' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={activePage === 'usage_statistics'}
          onClick={() => onSwitchPage('usage_statistics')}
        >
          <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 19.5h16" />
            <path d="M7 17.5V9.5" />
            <path d="M12 17.5V5.5" />
            <path d="M17 17.5V12.5" />
            <path d="M5.5 6.5 9 9l4-3.5 4 2.5" />
          </svg>
          <span>Usage Statistics</span>
        </button>
        <button
          className={`aoTopNavBtn${activePage === 'provider_switchboard' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={activePage === 'provider_switchboard'}
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
      </div>
      <button className="aoTinyBtn" aria-label="Getting Started" onClick={onOpenGettingStarted}>
        Getting Started
      </button>
    </div>
  )
}
