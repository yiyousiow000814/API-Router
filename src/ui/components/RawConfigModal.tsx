import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  loading: boolean
  saving: boolean
  targetHome: string
  homeOptions: string[]
  onTargetHomeChange: (next: string) => void
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
  targetHome,
  homeOptions,
  onTargetHomeChange,
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
            <div className="aoModalTitle">Raw Codex config.toml</div>
            <div className="aoModalSub">Edits are validated and saved to selected Codex CLI home.</div>
          </div>
          <div className="aoRow">
            {homeOptions.length > 1 ? (
              <select
                className="aoSelect"
                value={targetHome}
                onChange={(e) => onTargetHomeChange(e.target.value)}
                disabled={loading || saving}
                style={{ maxWidth: 360 }}
              >
                {homeOptions.map((home) => (
                  <option key={home} value={home}>
                    {home}
                  </option>
                ))}
              </select>
            ) : null}
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
          <div className="aoModalSub">Target: {targetHome || '-'}</div>
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
