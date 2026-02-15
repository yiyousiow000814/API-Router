import type { ProviderSwitchboardStatus } from '../types'
import { SwitchboardProvidersGrid, type SwitchboardProviderCard } from './SwitchboardProvidersGrid'
import { SwitchboardQuickSwitch } from './SwitchboardQuickSwitch'
import { GATEWAY_MODEL_PROVIDER_ID } from '../constants'
import { normalizePathForCompare } from '../utils/path'
import './ProviderSwitchboardPanel.css'

type ProviderSwitchboardPanelProps = {
  providerSwitchStatus: ProviderSwitchboardStatus | null
  providerSwitchBusy: boolean
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  switchboardProviderCards: SwitchboardProviderCard[]
  onSetProviderSwitchTarget: (
    target: 'gateway' | 'official' | 'provider',
    provider?: string,
    cliHomes?: string[],
  ) => Promise<void>
  onOpenConfigureDirs: () => void
  onOpenRawConfig: () => void
}

export function ProviderSwitchboardPanel({
  providerSwitchStatus,
  providerSwitchBusy,
  codexSwapDir1,
  codexSwapDir2,
  codexSwapUseWindows,
  codexSwapUseWsl,
  switchboardProviderCards,
  onSetProviderSwitchTarget,
  onOpenConfigureDirs,
  onOpenRawConfig,
}: ProviderSwitchboardPanelProps) {
  const providerStatusByHome = new Map(
    (providerSwitchStatus?.dirs ?? [])
      .map((item) => [normalizePathForCompare(item.cli_home), item] as const)
      .filter(([k]) => Boolean(k)),
  )
  const windowsHome = codexSwapUseWindows ? codexSwapDir1.trim() : ''
  const wslHome = codexSwapUseWsl ? codexSwapDir2.trim() : ''
  const sectionTargets = [
    { key: 'windows', label: 'Windows', home: windowsHome, enabled: Boolean(windowsHome) },
    { key: 'wsl2', label: 'WSL2', home: wslHome, enabled: Boolean(wslHome) },
  ].filter((item) => item.enabled)
  const compareTargets = [
    { key: 'windows', label: 'Windows', home: codexSwapDir1.trim(), enabled: codexSwapUseWindows },
    { key: 'wsl2', label: 'WSL2', home: codexSwapDir2.trim(), enabled: codexSwapUseWsl },
  ]
  const compareValues = compareTargets.map((target) => {
    const dirStatus =
      target.enabled && target.home ? providerStatusByHome.get(normalizePathForCompare(target.home)) : null
    const mode = target.enabled ? dirStatus?.mode ?? '' : ''
    const provider =
      mode === 'gateway'
        ? GATEWAY_MODEL_PROVIDER_ID
        : mode === 'official'
          ? 'official'
          : target.enabled
            ? dirStatus?.model_provider ?? ''
            : ''
    return {
      ...target,
      mode,
      provider,
      dir: target.enabled ? target.home : '',
    }
  })

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
      </div>
      <div className="aoSwitchThemeBand">
        <div className="aoSwitchThemeBandHead">
          <div className="aoMiniLabel">Current Target</div>
        </div>
        <div className="aoSwitchThemeSummary">
          <div className="aoSwitchThemeCompareCards">
            {compareValues.map((item, idx) => (
              <div
                className={`aoSwitchThemeCompareCard${idx === 1 ? ' is-right' : ''}${item.key === 'windows' ? ' is-windows' : ''}${item.key === 'wsl2' ? ' is-wsl2' : ''}`}
                key={item.key}
              >
                <div className="aoSwitchThemeCompareCardHead">
                  <span className="aoSwitchThemeCompareCardTitle">{item.label}</span>
                  <span className="aoSwitchThemeCompareCardModeWrap">
                    <span className="aoSwitchThemeCompareCardKey">Current Mode</span>
                    {item.mode ? (
                      <span className={`aoSwitchThemeModePill is-${item.mode}`}>{item.mode}</span>
                    ) : null}
                  </span>
                </div>
                <div className="aoSwitchThemeCompareCardRow">
                  <span className="aoSwitchThemeCompareCardKey">Model Provider</span>
                  <span className="aoSwitchThemeCompareCardVal">{item.provider}</span>
                </div>
                <div className="aoSwitchThemeCompareCardRow">
                  <span className="aoSwitchThemeCompareCardKey">Target Dir</span>
                  <span className="aoSwitchThemeCompareCardVal aoSwitchMetaDirs">{item.dir}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="aoSwitchboardGlobalActions">
        <button type="button" className="aoTinyBtn" onClick={onOpenRawConfig}>
          Edit config.toml
        </button>
        <button type="button" className="aoTinyBtn" onClick={onOpenConfigureDirs}>
          Configure Dirs
        </button>
      </div>
      <div className="aoSwitchboardTargetsGrid">
        {sectionTargets.length ? (
          sectionTargets.map((section) => {
            const dirStatus = providerStatusByHome.get(section.home)
            const activeMode = dirStatus?.mode ?? null
            const activeModelProvider = dirStatus?.model_provider ?? null
            return (
              <div className="aoSwitchboardTargetCard" key={section.key}>
                <div className="aoSwitchboardSectionHead">
                  <div className="aoMiniLabel">{section.label}</div>
                  <div className="aoHint aoSwitchboardSectionHint">{section.home}</div>
                </div>
                <div className="aoSwitchboardSectionHead">
                  <div className="aoMiniLabel">Quick Switch</div>
                  <div className="aoHint">
                    Mode: {activeMode ?? '-'}
                    {activeMode === 'provider' && activeModelProvider ? ` (${activeModelProvider})` : ''}
                  </div>
                </div>
                <SwitchboardQuickSwitch
                  activeMode={activeMode}
                  activeModelProvider={activeModelProvider}
                  providerSwitchBusy={providerSwitchBusy}
                  onSetProviderSwitchTarget={(target, provider) =>
                    onSetProviderSwitchTarget(target, provider, [section.home])
                  }
                />
                <div className="aoSwitchboardSectionHead">
                  <div className="aoMiniLabel">Direct Providers</div>
                  <div className="aoHint">Includes remaining quota and progress view.</div>
                </div>
                <SwitchboardProvidersGrid
                  activeMode={activeMode}
                  activeModelProvider={activeModelProvider}
                  providerSwitchBusy={providerSwitchBusy}
                  switchboardProviderCards={switchboardProviderCards}
                  onSetProviderSwitchTarget={(target, provider) =>
                    onSetProviderSwitchTarget(target, provider, [section.home])
                  }
                />
              </div>
            )
          })
        ) : (
          <div className="aoSwitchboardEmpty">
            <span className="aoHint">
              No enabled directories. Use Configure Dirs to enable Windows and/or WSL2 first.
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
