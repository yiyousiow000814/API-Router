type SwitchboardQuickSwitchProps = {
  activeMode: string | null
  activeModelProvider?: string | null
  providerSwitchBusy: boolean
  onSetProviderSwitchTarget: (target: 'gateway' | 'official' | 'provider', provider?: string) => Promise<void>
}

export function SwitchboardQuickSwitch({
  activeMode,
  activeModelProvider,
  providerSwitchBusy,
  onSetProviderSwitchTarget,
}: SwitchboardQuickSwitchProps) {
  return (
    <div className="aoSwitchQuickGrid">
      <button
        className={`aoSwitchQuickBtn${activeMode === 'gateway' ? ' is-active' : ''}`}
        disabled={providerSwitchBusy}
        onClick={() => void onSetProviderSwitchTarget('gateway')}
      >
        <span className="aoSwitchQuickTitle">Gateway</span>
        <span className="aoSwitchQuickSub">Use local API Router</span>
      </button>
      <button
        className={`aoSwitchQuickBtn${activeMode === 'official' ? ' is-active' : ''}`}
        disabled={providerSwitchBusy}
        onClick={() => void onSetProviderSwitchTarget('official')}
      >
        <span className="aoSwitchQuickTitle">Official</span>
        <span className="aoSwitchQuickSub">Use official Codex auth</span>
      </button>
      <button
        className={
          'aoSwitchQuickBtn aoSwitchQuickBtnHint' +
          (activeMode === 'provider' ? ' is-active' : '')
        }
        disabled
      >
        <span className="aoSwitchQuickTitle">Direct Provider</span>
        <span className="aoSwitchQuickSub">
          {activeMode === 'provider' && activeModelProvider
            ? 'Active: ' + activeModelProvider
            : 'Use selected provider below'}
        </span>
      </button>
    </div>
  )
}
