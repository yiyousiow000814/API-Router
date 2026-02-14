export type SwitchboardProviderCard = {
  name: string
  baseUrl: string
  hasKey: boolean
  usageHeadline: string
  usageDetail: string
  usageSub: string | null
  usagePct: number | null
}

type SwitchboardProvidersGridProps = {
  activeMode: string | null
  activeModelProvider?: string | null
  providerSwitchBusy: boolean
  switchboardProviderCards: SwitchboardProviderCard[]
  onSetProviderSwitchTarget: (target: 'gateway' | 'official' | 'provider', provider?: string) => Promise<void>
}

export function SwitchboardProvidersGrid({
  activeMode,
  activeModelProvider,
  providerSwitchBusy,
  switchboardProviderCards,
  onSetProviderSwitchTarget,
}: SwitchboardProvidersGridProps) {
  return (
    <div className="aoSwitchProviderGrid">
      {switchboardProviderCards.length ? (
        switchboardProviderCards.map((providerItem) => (
          <button
            key={providerItem.name}
            className={`aoSwitchProviderBtn${activeMode === 'provider' && activeModelProvider === providerItem.name ? ' is-active' : ''}`}
            disabled={providerSwitchBusy || !providerItem.hasKey}
            onClick={() => void onSetProviderSwitchTarget('provider', providerItem.name)}
          >
            <span className="aoSwitchProviderHead">
              <span>{providerItem.name}</span>
              <span className={`aoSwitchProviderKey${providerItem.hasKey ? ' is-ready' : ' is-missing'}`}>
                {providerItem.hasKey ? 'key ready' : 'missing key'}
              </span>
            </span>
            <span className="aoSwitchProviderBase">{providerItem.baseUrl || 'base_url missing'}</span>
            <span className="aoSwitchProviderUsageBody">
              <span className="aoSwitchProviderUsageHeadline">{providerItem.usageHeadline}</span>
              <span className="aoSwitchProviderUsageDetail">{providerItem.usageDetail}</span>
              {providerItem.usageSub ? (
                <span className="aoSwitchProviderUsageSub">{providerItem.usageSub}</span>
              ) : (
                <span className="aoSwitchProviderUsageSub aoSwitchProviderUsageSubMuted">
                  No extra usage info
                </span>
              )}
            </span>
            <span className="aoSwitchProviderProgress">
              <span
                className={`aoSwitchProviderProgressFill${providerItem.usagePct == null ? ' is-empty' : ''}`}
                style={
                  providerItem.usagePct == null
                    ? undefined
                    : { width: `${Math.max(4, Math.min(100, providerItem.usagePct))}%` }
                }
              />
            </span>
          </button>
        ))
      ) : (
        <span className="aoHint">No configured providers.</span>
      )}
    </div>
  )
}
