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
  const dualMode = homeOptions.length > 1
  const primaryHome = homeOptions[0] ?? ''
  const secondaryHome = homeOptions[1] ?? ''
  const parseHomeLabel = (home: string) => {
    const raw = homeLabels?.[home] ?? home
    const idx = raw.indexOf(': ')
    if (idx <= 0) return { kind: 'Target', path: raw }
    return { kind: raw.slice(0, idx), path: raw.slice(idx + 2) }
  }
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal aoModalWide" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Raw Codex config.toml</div>
            <div className="aoModalSub">Edits are validated and saved to selected Codex CLI home.</div>
          </div>
          <div className="aoRow">
            {!dualMode ? (
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
            {!dualMode ? (
              <button className="aoBtn" onClick={onReload} disabled={loading || saving}>
                Reload
              </button>
            ) : null}
            {!dualMode ? (
              <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={loading || saving || !canSave}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            ) : null}
            <button className="aoBtn" onClick={onClose} disabled={saving}>
              Close
            </button>
          </div>
        </div>
        <div className="aoModalBody aoRawConfigModalBody">
          {!dualMode ? <div className="aoModalSub">Target: {targetHome || '-'}</div> : null}
          {warningText ? <div className="aoModalSub">{warningText}</div> : null}
          {!loading && !canSave ? (
            <div className="aoModalSub">Save is disabled until config.toml loads successfully for this target.</div>
          ) : null}
          {dualMode ? (
            <div className="aoRawConfigDual">
              {[primaryHome, secondaryHome].map((home) => {
                const selected = home === targetHome
                const parsed = parseHomeLabel(home)
                return (
                  <section key={home} className="aoRawConfigPane">
                    <div className="aoRawConfigPaneHead">
                      <div className="aoRawConfigPaneMeta">
                        <span className="aoRawConfigPaneKind">{parsed.kind}</span>
                        <span className="aoRawConfigPanePath" title={parsed.path}>
                          {parsed.path}
                        </span>
                      </div>
                      <div className="aoRow aoRawConfigPaneActions">
                        <button className="aoBtn" disabled={loading || saving} onClick={() => onTargetHomeChange(home)}>
                          Reload
                        </button>
                        <button
                          className="aoBtn aoBtnPrimary"
                          disabled={!selected || loading || saving || !canSave}
                          onClick={onSave}
                        >
                          {saving && selected ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    </div>
                    {selected ? (
                      <textarea
                        className="aoRawConfigEditor"
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        spellCheck={false}
                        placeholder={loading ? 'Loading config.toml...' : 'config.toml is empty'}
                        disabled={loading}
                      />
                    ) : (
                      <div className="aoRawConfigPlaceholder">Select Reload on this side to switch target.</div>
                    )}
                  </section>
                )
              })}
            </div>
          ) : (
            <textarea
              className="aoRawConfigEditor"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
              placeholder={loading ? 'Loading config.toml...' : 'config.toml is empty'}
              disabled={loading}
            />
          )}
        </div>
      </div>
    </ModalBackdrop>
  )
}
