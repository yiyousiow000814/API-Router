import type { ProviderSwitchboardStatus } from '../types'
import { SwitchboardProvidersGrid, type SwitchboardProviderCard } from './SwitchboardProvidersGrid'
import { SwitchboardQuickSwitch } from './SwitchboardQuickSwitch'
import './ProviderSwitchboardPanel.css'

type ProviderSwitchboardPanelProps = {
  providerSwitchStatus: ProviderSwitchboardStatus | null
  providerSwitchBusy: boolean
  switchboardModeLabel: string
  switchboardModelProviderLabel: string
  switchboardTargetDirsLabel: string
  switchboardProviderCards: SwitchboardProviderCard[]
  onSetProviderSwitchTarget: (target: 'gateway' | 'official' | 'provider', provider?: string) => Promise<void>
  onOpenConfigureDirs: () => void
  onOpenRawConfig: () => void
}

export function ProviderSwitchboardPanel({
  providerSwitchStatus,
  providerSwitchBusy,
  switchboardModeLabel,
  switchboardModelProviderLabel,
  switchboardTargetDirsLabel,
  switchboardProviderCards,
  onSetProviderSwitchTarget,
  onOpenConfigureDirs,
  onOpenRawConfig,
}: ProviderSwitchboardPanelProps) {
  return (
    <div className="aoCard aoProviderSwitchboardCard">
      <div className="aoProviderSwitchboardHeader">
        <div>
          <div className="aoPagePlaceholderTitle">Provider Switchboard</div>
          <div className="aoHint">
            One-click switch for Codex auth/config target (gateway, official, or direct provider).
          </div>
          <div className="aoHint">
            Runtime failover routing stays in Dashboard Routing. This page does not do seamless live routing.
          </div>
        </div>
        <div className="aoPill">
          <span className="aoDot" />
          <span className="aoPillText">{switchboardModeLabel}</span>
        </div>
      </div>
      <div className="aoSwitchThemeBand">
        <div className="aoSwitchThemeBandHead">
          <div className="aoMiniLabel">Current Target</div>
        </div>
        <div className="aoSwitchThemeSummary">
          <div className="aoSwitchThemeRow">
            <span className="aoSwitchThemeKey">Current Mode</span>
            <span className="aoSwitchThemeVal">{switchboardModeLabel}</span>
            <span className="aoSwitchThemeSep">|</span>
            <span className="aoSwitchThemeKey">Model Provider</span>
            <span className="aoSwitchThemeVal">{switchboardModelProviderLabel}</span>
          </div>
          <div className="aoSwitchThemeRow">
            <span className="aoSwitchThemeKey">Target Dirs</span>
            <span className="aoSwitchThemeVal aoSwitchMetaDirs">{switchboardTargetDirsLabel}</span>
          </div>
        </div>
      </div>
      <div className="aoSwitchboardBlock">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Quick Switch</div>
        </div>
        <SwitchboardQuickSwitch
          providerSwitchStatus={providerSwitchStatus}
          providerSwitchBusy={providerSwitchBusy}
          onSetProviderSwitchTarget={onSetProviderSwitchTarget}
        />
        <div className="aoSwitchSubOptions">
          <div className="aoSwitchboardSectionHead">
            <div className="aoMiniLabel">Switch Options</div>
            <div className="aoRow">
              <button type="button" className="aoTinyBtn" onClick={onOpenRawConfig}>
                Edit config.toml
              </button>
              <button type="button" className="aoTinyBtn" onClick={onOpenConfigureDirs}>
                Configure Dirs
              </button>
            </div>
          </div>
          <div className="aoHint">
            Shared with Dashboard Swap settings. Gateway, Official, and Direct Provider switches all use
            the same directory targets.
          </div>
        </div>
      </div>
      <div className="aoSwitchboardBlock">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Direct Providers</div>
          <div className="aoHint">Includes remaining quota and progress view.</div>
        </div>
        <SwitchboardProvidersGrid
          providerSwitchStatus={providerSwitchStatus}
          providerSwitchBusy={providerSwitchBusy}
          switchboardProviderCards={switchboardProviderCards}
          onSetProviderSwitchTarget={onSetProviderSwitchTarget}
        />
      </div>
    </div>
  )
}
