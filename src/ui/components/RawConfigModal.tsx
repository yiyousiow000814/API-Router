import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  loading: boolean
  saving: boolean
  value: string
  onChange: (next: string) => void
  onReload: () => void
  onSave: () => void
  onClose: () => void
}

export function RawConfigModal({
  open,
  loading,
  saving,
  value,
  onChange,
  onReload,
  onSave,
  onClose,
}: Props) {
  if (!open) return null
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal aoModalWide" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Raw config.toml</div>
            <div className="aoModalSub">Edits are validated, then hot-applied and persisted to disk.</div>
          </div>
          <div className="aoRow">
            <button className="aoBtn" onClick={onReload} disabled={loading || saving}>
              Reload
            </button>
            <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={loading || saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button className="aoBtn" onClick={onClose} disabled={saving}>
              Close
            </button>
          </div>
        </div>
        <div className="aoModalBody">
          <textarea
            className="aoRawConfigEditor"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            placeholder={loading ? 'Loading config.toml...' : 'config.toml is empty'}
            disabled={loading}
          />
        </div>
      </div>
    </ModalBackdrop>
  )
}
