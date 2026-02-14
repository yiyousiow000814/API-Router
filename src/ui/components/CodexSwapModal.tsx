import { ModalBackdrop } from './ModalBackdrop'
import { normalizePathForCompare } from '../utils/path'

type Props = {
  open: boolean
  windowsDir: string
  wslDir: string
  useWindows: boolean
  useWsl: boolean
  onChangeWindowsDir: (v: string) => void
  onChangeWslDir: (v: string) => void
  onChangeUseWindows: (v: boolean) => void
  onChangeUseWsl: (v: boolean) => void
  onCancel: () => void
  onApply: () => void
}

export function CodexSwapModal({
  open,
  windowsDir,
  wslDir,
  useWindows,
  useWsl,
  onChangeWindowsDir,
  onChangeWslDir,
  onChangeUseWindows,
  onChangeUseWsl,
  onCancel,
  onApply,
}: Props) {
  if (!open) return null

  const normalize = (v: string) => v.trim().replace(/\//g, '\\')
  const isWslPrefix = (v: string) => {
    const lower = normalize(v).toLowerCase()
    return lower.startsWith('\\\\wsl.localhost\\') || lower.startsWith('\\\\wsl$\\')
  }
  const isValidWindowsCodexPath = (v: string) => {
    const n = normalize(v)
    return /^[a-zA-Z]:\\/.test(n) && !isWslPrefix(n) && n.toLowerCase().endsWith('\\.codex')
  }
  const isValidWslCodexPath = (v: string) => {
    const n = normalize(v)
    return isWslPrefix(n) && n.toLowerCase().endsWith('\\.codex')
  }

  const hasWindowsDir = windowsDir.trim().length > 0
  const hasWslDir = wslDir.trim().length > 0
  const windowsPathValid = isValidWindowsCodexPath(windowsDir)
  const wslPathValid = isValidWslCodexPath(wslDir)
  const duplicateDirs =
    hasWindowsDir && hasWslDir && normalizePathForCompare(windowsDir) === normalizePathForCompare(wslDir)
  const applyDisabled =
    (!useWindows && !useWsl) ||
    (useWindows && !windowsPathValid) ||
    (useWsl && !wslPathValid) ||
    (useWindows && useWsl && duplicateDirs)

  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onCancel}>
      <div className="aoModal" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalTitle">Codex CLI directories</div>
        <div className="aoModalSub">
          Windows defaults to %USERPROFILE%\\.codex. WSL2 defaults to WSL2 home (if available).
        </div>
        <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
          <div className="aoCardInset" style={{ border: '1px solid rgba(13, 18, 32, 0.1)', borderRadius: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="aoMiniLabel">Windows</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={useWindows}
                  disabled={!useWindows && !windowsPathValid}
                  onChange={(e) => onChangeUseWindows(e.target.checked)}
                />
                <span style={{ color: 'rgba(13, 18, 32, 0.82)', fontWeight: 500, fontSize: 13 }}>Enable</span>
              </label>
            </div>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12 }}
              value={windowsDir}
              placeholder="C:\\Users\\<user>\\.codex"
              onChange={(e) => onChangeWindowsDir(e.target.value)}
              disabled={!useWindows}
            />
            {hasWindowsDir && !windowsPathValid ? (
              <div className="aoHint" style={{ marginTop: 6 }}>Use a Windows path ending with `\\.codex`.</div>
            ) : null}
          </div>

          <div className="aoCardInset" style={{ border: '1px solid rgba(13, 18, 32, 0.1)', borderRadius: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="aoMiniLabel">WSL2</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={useWsl}
                  disabled={!useWsl && !wslPathValid}
                  onChange={(e) => onChangeUseWsl(e.target.checked)}
                />
                <span style={{ color: 'rgba(13, 18, 32, 0.82)', fontWeight: 500, fontSize: 13 }}>Enable</span>
              </label>
            </div>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12 }}
              value={wslDir}
              placeholder="\\\\wsl.localhost\\Ubuntu\\home\\<user>\\.codex"
              onChange={(e) => onChangeWslDir(e.target.value)}
              disabled={!useWsl}
            />
            {hasWslDir && !wslPathValid ? (
              <div className="aoHint" style={{ marginTop: 6 }}>
                Use a WSL2 UNC path like `\\\\wsl.localhost\\Distro\\home\\user\\.codex`.
              </div>
            ) : null}
          </div>

          <div className="aoHint">
            {duplicateDirs
              ? 'Windows and WSL2 paths are the same. Use different paths.'
              : 'Enable at least one target. Each enabled path must contain auth.json and config.toml.'}
          </div>
        </div>

        <div className="aoModalActions">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn aoBtnPrimary" disabled={applyDisabled} onClick={onApply}>
            Apply
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
