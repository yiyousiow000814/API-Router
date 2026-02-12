import type { ProviderSwitchboardStatus } from '../types'

type SwitchboardQuickSwitchProps = {
  providerSwitchStatus: ProviderSwitchboardStatus | null
  providerSwitchBusy: boolean
  onSetProviderSwitchTarget: (target: 'gateway' | 'official' | 'provider', provider?: string) => Promise<void>
}

export function SwitchboardQuickSwitch({
  providerSwitchStatus,
  providerSwitchBusy,
  onSetProviderSwitchTarget,
}: SwitchboardQuickSwitchProps) {
  return (
    <div className="aoSwitchQuickGrid">
      <button
        className={`aoSwitchQuickBtn${providerSwitchStatus?.mode === 'gateway' ? ' is-active' : ''}`}
        disabled={providerSwitchBusy}
        onClick={() => void onSetProviderSwitchTarget('gateway')}
      >
        <span className="aoSwitchQuickTitle">Gateway</span>
        <span className="aoSwitchQuickSub">Use local API Router</span>
      </button>
      <button
        className={`aoSwitchQuickBtn${providerSwitchStatus?.mode === 'official' ? ' is-active' : ''}`}
        disabled={providerSwitchBusy}
        onClick={() => void onSetProviderSwitchTarget('official')}
      >
        <span className="aoSwitchQuickTitle">Official</span>
        <span className="aoSwitchQuickSub">Use official Codex auth</span>
      </button>
      <button
        className={
          'aoSwitchQuickBtn aoSwitchQuickBtnHint' +
          (providerSwitchStatus?.mode === 'provider' ? ' is-active' : '')
        }
        disabled
      >
        <span className="aoSwitchQuickTitle">Direct Provider</span>
        <span className="aoSwitchQuickSub">
          {providerSwitchStatus?.mode === 'provider' && providerSwitchStatus?.model_provider
            ? 'Active: ' + providerSwitchStatus.model_provider
            : 'Use selected provider below'}
        </span>
      </button>
    </div>
  )
}
