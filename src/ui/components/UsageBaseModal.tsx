import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  value: string
  effectiveValue?: string
  username: string
  password: string
  showAuthFields?: boolean
  loadFailed?: boolean
  onChange: (next: string) => void
  onChangeUsername: (next: string) => void
  onChangePassword: (next: string) => void
  onCancel: () => void
  onClear: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function UsageBaseModal({
  open,
  provider,
  value,
  effectiveValue = '',
  username,
  password,
  showAuthFields = false,
  loadFailed = false,
  onChange,
  onChangeUsername,
  onChangePassword,
  onCancel,
  onClear,
  onSave,
}: Props) {
  if (!open) return null
  const canClear = Boolean(value)
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
        {showAuthFields ? (
          <>
            <div className="aoMiniLabel" style={{ marginTop: 10 }}>
              Username
            </div>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12, padding: '0 12px' }}
              placeholder="username"
              value={username}
              onChange={(e) => onChangeUsername(e.target.value)}
            />
            <div className="aoMiniLabel" style={{ marginTop: 10 }}>
              Password
            </div>
            <input
              className="aoInput"
              type="password"
              style={{ width: '100%', height: 36, borderRadius: 12, padding: '0 12px' }}
              placeholder="password"
              value={password}
              onChange={(e) => onChangePassword(e.target.value)}
            />
          </>
        ) : null}
        {loadFailed ? (
          <div className="aoHint" style={{ marginTop: 8, color: 'rgba(145, 12, 43, 0.92)' }}>
            Failed to load saved usage auth.
          </div>
        ) : null}
        {effectiveValue ? (
          <div className="aoHint" style={{ marginTop: 8 }}>
            Current derived endpoint: <span style={{ fontFamily: mono }}>{effectiveValue}</span>
          </div>
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
