import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  loading: boolean
  saving: boolean
  canSave: boolean
  targetHome: string
  homeOptions: string[]
  homeLabels?: Record<string, string>
  onTargetHomeChange: (next: string) => void
  value: string
  onChange: (next: string) => void
  onReload: () => void
  onSave: () => void
  warningText?: string | null
  onClose: () => void
}

export function RawConfigModal({
  open,
  loading,
  saving,
  canSave,
  targetHome,
  homeOptions,
  homeLabels,
  onTargetHomeChange,
  value,
  onChange,
  onReload,
  onSave,
  warningText,
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
                    {homeLabels?.[home] ?? home}
                  </option>
                ))}
              </select>
            ) : null}
            <button className="aoBtn" onClick={onReload} disabled={loading || saving}>
              Reload
            </button>
            <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={loading || saving || !canSave}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button className="aoBtn" onClick={onClose} disabled={saving}>
              Close
            </button>
          </div>
        </div>
        <div className="aoModalBody">
          <div className="aoModalSub">Target: {targetHome || '-'}</div>
          {warningText ? <div className="aoModalSub">{warningText}</div> : null}
          {!loading && !canSave ? (
            <div className="aoModalSub">Save is disabled until config.toml loads successfully for this target.</div>
          ) : null}
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
