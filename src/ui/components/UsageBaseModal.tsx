import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  value: string
  effectiveValue?: string
  showPackycodeLogin?: boolean
  hasUsageLogin?: boolean
  onChange: (next: string) => void
  onCancel: () => void
  onClear: () => void
  onSave: () => void
  onAuthAction?: (() => void) | null
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function UsageBaseModal({
  open,
  provider,
  value,
  effectiveValue = '',
  showPackycodeLogin = false,
  hasUsageLogin = false,
  onChange,
  onCancel,
  onClear,
  onSave,
  onAuthAction,
}: Props) {
  if (!open) return null
  const canClear = Boolean(value)
  const authButtonLabel = hasUsageLogin ? 'Logout' : 'Packycode Login'
  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onCancel}>
      <div className="aoModal">
        <div className="aoModalTitle">Usage URL</div>
        <div className="aoModalSub">
          Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          <br />
          Usage endpoint URL. Leave empty to use built-in provider mappings only.
        </div>
        <input
          className="aoInput"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          placeholder="https://..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {effectiveValue ? (
          <div className="aoHint" style={{ marginTop: 8 }}>
            Current derived endpoint: <span style={{ fontFamily: mono }}>{effectiveValue}</span>
          </div>
        ) : null}
        {showPackycodeLogin && onAuthAction ? (
          <>
            <div className="aoHint" style={{ marginTop: 10 }}>
              Usage URL sets the endpoint. Packycode Login is a fallback when the endpoint alone cannot return usage.
            </div>
            <div className="aoModalActions" style={{ justifyContent: 'flex-start', marginTop: 10 }}>
              <button className={`aoBtn${hasUsageLogin ? ' aoBtnDangerSoft' : ''}`} onClick={onAuthAction}>
                {authButtonLabel}
              </button>
            </div>
          </>
        ) : null}
        <div className="aoModalActions">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn" onClick={onClear} disabled={!canClear}>
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
