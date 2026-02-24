import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  value: string
  loading: boolean
  loadFailed: boolean
  onChange: (next: string) => void
  onCancel: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function KeyModal({ open, provider, value, loading, loadFailed, onChange, onCancel, onSave }: Props) {
  if (!open) return null
  const saveDisabled = loading || (loadFailed && value.trim().length === 0)
  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onCancel}>
      <div className="aoModal">
        <div className="aoModalTitle">Set API key</div>
        <div className="aoModalSub">
          Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          <br />
          Stored in ./user-data/secrets.json.
        </div>
        <input
          className="aoInput"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          placeholder="Paste API key..."
          value={value}
          disabled={loading}
          onChange={(e) => onChange(e.target.value)}
        />
        {loadFailed ? <div className="aoHint aoHintWarning">Failed to load existing key. Enter a new key before saving.</div> : null}
        <div className="aoModalActions">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn" onClick={() => onChange('')} disabled={loading || !value}>
            Clear
          </button>
          <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={saveDisabled}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
