type Props = {
  open: boolean
  provider: string
  value: string
  explicitValue: string
  onChange: (next: string) => void
  onCancel: () => void
  onClear: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function UsageBaseModal({
  open,
  provider,
  value,
  explicitValue,
  onChange,
  onCancel,
  onClear,
  onSave,
}: Props) {
  if (!open) return null
  return (
    <div className="aoModalBackdrop aoModalBackdropTop" role="dialog" aria-modal="true">
      <div className="aoModal">
        <div className="aoModalTitle">Usage base URL</div>
        <div className="aoModalSub">
          Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          <br />
          Usage source URL used for quota/usage fetch.
        </div>
        <input
          className="aoInput"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          placeholder="https://..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="aoModalActions">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn" onClick={onClear} disabled={!explicitValue}>
            Clear
          </button>
          <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={!value.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
