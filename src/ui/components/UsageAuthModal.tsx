import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  baseUrl: string
  token: string
  username: string
  password: string
  loading: boolean
  loadFailed: boolean
  onChangeUsername: (next: string) => void
  onChangePassword: (next: string) => void
  onCancel: () => void
  onClear: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function UsageAuthModal({
  open,
  provider,
  baseUrl,
  token,
  username,
  password,
  loading,
  loadFailed,
  onChangeUsername,
  onChangePassword,
  onCancel,
  onClear,
  onSave,
}: Props) {
  if (!open) return null

  const normalizedBaseUrl = baseUrl.trim().toLowerCase()
  const isCodexForHost = normalizedBaseUrl.includes('codex-for')
  if (!isCodexForHost) return null

  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onCancel}>
      <div className="aoModal">
        <div className="aoModalTitle">Usage auth</div>
        <div className="aoModalSub">
          Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          <br />
          Use your account username and password to fetch balance and expiry.
        </div>
        <div className="aoMiniLabel" style={{ marginTop: 10 }}>
          Username
        </div>
        <input
          className="aoInput"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
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
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          placeholder="password"
          value={password}
          onChange={(e) => onChangePassword(e.target.value)}
        />
        {loading ? <div className="aoHint" style={{ marginTop: 8 }}>Loading...</div> : null}
        {loadFailed ? (
          <div className="aoHint" style={{ marginTop: 8, color: 'rgba(145, 12, 43, 0.92)' }}>
            Failed to load saved usage auth.
          </div>
        ) : null}
        <div className="aoModalActions">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn" onClick={onClear} disabled={!token && !username && !password}>
            Clear
          </button>
          <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={loading}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
