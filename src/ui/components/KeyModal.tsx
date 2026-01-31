type Props = {
  open: boolean
  provider: string
  value: string
  onChange: (next: string) => void
  onCancel: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function KeyModal({ open, provider, value, onChange, onCancel, onSave }: Props) {
  if (!open) return null
  return (
    <div className="aoModalBackdrop aoModalBackdropTop" role="dialog" aria-modal="true">
      <div className="aoModal">
        <div className="aoModalTitle">Set API key</div>
        <div className="aoModalSub">
          Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          <br />
          Stored in ./user-data/secrets.json (gitignored).
        </div>
        <input
          className="aoInput"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          placeholder="Paste API key..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="aoModalActions">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={!value}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
