import type { Config } from '../types'

type HeroRoutingProps = {
  config: Config | null
  providers: string[]
  routeMode: 'follow_preferred_auto' | 'balanced_auto'
  onRouteModeChange: (next: 'follow_preferred_auto' | 'balanced_auto') => void
  override: string
  onOverrideChange: (next: string) => void
  onPreferredChange: (next: string) => void
}

export function HeroRoutingCard({
  config,
  providers,
  routeMode,
  onRouteModeChange,
  override,
  onOverrideChange,
  onPreferredChange,
}: HeroRoutingProps) {
  const preferredProviders = config
    ? Object.entries(config.providers)
        .filter(([, provider]) => !provider.disabled)
        .map(([name]) => name)
    : []
  const routeSelection = override === '' ? routeMode : `lock:${override}`
  const lockOptions = providers.map((provider) => ({
    value: `lock:${provider}`,
    label: `Lock to ${provider}`,
  }))
  const hasCurrentLockOption = override !== '' && lockOptions.some((option) => option.value === routeSelection)
  const onRouteSelectionChange = (value: string) => {
    if (value === 'follow_preferred_auto' || value === 'balanced_auto') {
      if (override !== '') onOverrideChange('')
      onRouteModeChange(value)
      return
    }
    if (value.startsWith('lock:')) {
      onOverrideChange(value.slice('lock:'.length))
    }
  }

  return (
    <div className="aoCard aoHeroCard aoHeroRouting">
      <div className="aoCardHeader">
        <div className="aoCardTitle">Routing</div>
        <span className="aoPill">
          <span className={override === '' ? 'aoDot' : 'aoDot aoDotBad'} />
          <span className="aoPillText">{override === '' ? 'auto' : 'locked'}</span>
        </span>
      </div>
      {config ? (
        <div className="aoRoutingGrid">
          <label className="aoRoutingRow">
            <span className="aoMiniLabel">Route mode</span>
            <select className="aoSelect" value={routeSelection} onChange={(e) => onRouteSelectionChange(e.target.value)}>
              <option value="follow_preferred_auto">Follow Preferred (Auto)</option>
              <option value="balanced_auto">Balanced Mode (Auto)</option>
              {hasCurrentLockOption ? null : override !== '' ? (
                <option value={routeSelection}>{`Lock to ${override}`}</option>
              ) : null}
              {lockOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="aoRoutingRow">
            <span className="aoMiniLabel">Preferred</span>
            <select
              className="aoSelect"
              value={config.routing.preferred_provider}
              onChange={(e) => onPreferredChange(e.target.value)}
            >
              {preferredProviders.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div className="aoHint" style={{ marginTop: 8 }}>
          Loading…
        </div>
      )}
      <div className="aoHint" style={{ marginTop: 8 }}>
        Tip: closing the window hides to tray. Use tray menu to show/quit.
      </div>
    </div>
  )
}
