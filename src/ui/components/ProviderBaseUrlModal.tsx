import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  value: string
  onChange: (next: string) => void
  onCancel: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function ProviderBaseUrlModal({
  open,
  provider,
  value,
  onChange,
  onCancel,
  onSave,
}: Props) {
  if (!open) return null
  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onCancel}>
      <div className="aoModal">
        <div className="aoModalTitle">Base URL</div>
        <div className="aoModalSub">
          Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          <br />
          Set the upstream API base URL for this provider.
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
          <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={!value.trim()}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
