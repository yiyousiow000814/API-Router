import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  value: string
  onChange: (next: string) => void
  onCancel: () => void
  onClear: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function ProviderEmailModal({
  open,
  provider,
  value,
  onChange,
  onCancel,
  onClear,
  onSave,
}: Props) {
  if (!open) return null
  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onCancel}>
      <div className="aoModal">
        <div className="aoModalTitle">Provider email</div>
        <div className="aoModalSub">
          Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          <br />
          Stored only as a local note so you can remember which account this provider uses.
        </div>
        <input
          className="aoInput"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          placeholder="name@example.com"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="aoModalActions">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn" onClick={onClear} disabled={!value}>
            Clear
          </button>
          <button className="aoBtn aoBtnPrimary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
