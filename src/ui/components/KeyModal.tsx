import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  value: string
  storage: 'auth_json' | 'config_toml_experimental_bearer_token'
  loading: boolean
  loadFailed: boolean
  onChange: (next: string) => void
  onChangeStorage: (next: 'auth_json' | 'config_toml_experimental_bearer_token') => void
  onCancel: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function KeyModal({
  open,
  provider,
  value,
  storage,
  loading,
  loadFailed,
  onChange,
  onChangeStorage,
  onCancel,
  onSave,
}: Props) {
  if (!open) return null
  const saveDisabled = loading || (loadFailed && value.trim().length === 0)
  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onCancel}>
      <div className="aoModal">
        <div className="aoModalTitle">Set API key</div>
        <div className="aoModalSub aoKeyModalSub">
          <div>
            Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          </div>
          <div>Router copy stays in ./user-data/secrets.json. Choose how Codex target sync stores the key.</div>
        </div>
        <input
          className="aoInput"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          placeholder="Paste API key..."
          value={value}
          disabled={loading}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="aoKeyStorageOptions">
          <label className="aoKeyStorageOption">
            <input
              type="radio"
              checked={storage === 'auth_json'}
              disabled={loading}
              onChange={() => onChangeStorage('auth_json')}
            />
            <span>auth.json</span>
          </label>
          <label className="aoKeyStorageOption">
            <input
              type="radio"
              checked={storage === 'config_toml_experimental_bearer_token'}
              disabled={loading}
              onChange={() => onChangeStorage('config_toml_experimental_bearer_token')}
            />
            <span>experimental_bearer_token</span>
          </label>
        </div>
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
