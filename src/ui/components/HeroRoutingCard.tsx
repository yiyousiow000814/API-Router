import type { Config } from '../types'

type HeroRoutingProps = {
  config: Config | null
  providers: string[]
  override: string
  onOverrideChange: (next: string) => void
  onPreferredChange: (next: string) => void
}

export function HeroRoutingCard({
  config,
  providers,
  override,
  onOverrideChange,
  onPreferredChange,
}: HeroRoutingProps) {
  const preferredProviders = config
    ? Object.entries(config.providers)
        .filter(([, provider]) => !provider.disabled)
        .map(([name]) => name)
    : []

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
            <span className="aoMiniLabel">Mode</span>
            <select className="aoSelect" value={override} onChange={(e) => onOverrideChange(e.target.value)}>
              <option value="">Auto</option>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
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
