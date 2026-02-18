import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ModalBackdrop } from './ModalBackdrop'
import { normalizePathForCompare } from '../utils/path'
import { isValidWindowsCodexPath, isValidWslCodexPath } from '../utils/codexPathValidation'
import { GATEWAY_WSL2_HOST } from '../constants'
import { buildGatewayBaseUrl, normalizeGatewayPort } from '../utils/gatewayUrl'

const WSL_AUTH_STORAGE_KEY = 'ao:wsl-gateway-authorized'
const WSL_AUTH_EVENT = 'ao:wsl-gateway-authorized-changed'

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
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  isDevPreview: boolean
  listenPort: number
}

type WslGatewayTest = {
  ok: boolean
  authorized: boolean
  wsl_host?: string
}

type WslGatewayAccessStatus = {
  ok: boolean
  authorized: boolean
  wsl_host?: string
}

function wslAccessSummary(authorized: boolean, wslHost: string, listenPort: number): string {
  const baseUrl = buildGatewayBaseUrl(wslHost, listenPort)
  if (authorized) {
    return `Enabled: use WSL2 base_url ${baseUrl}.`
  }
  return `Disabled: WSL2 access to ${baseUrl} is blocked (expected after Revoke).`
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
  flashToast,
  isDevPreview,
  listenPort,
}: Props) {
  const [wslBusy, setWslBusy] = useState(false)
  const [wslAuthorized, setWslAuthorized] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WSL_AUTH_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [wslHost, setWslHost] = useState<string>(GATEWAY_WSL2_HOST)
  const gatewayPort = normalizeGatewayPort(listenPort)

  function persistWslAuthorized(authorized: boolean) {
    try {
      localStorage.setItem(WSL_AUTH_STORAGE_KEY, authorized ? '1' : '0')
      window.dispatchEvent(new CustomEvent<boolean>(WSL_AUTH_EVENT, { detail: authorized }))
    } catch {
      // noop
    }
  }

  async function refreshWslAccessStatus() {
    if (isDevPreview) {
      try {
        setWslAuthorized(localStorage.getItem(WSL_AUTH_STORAGE_KEY) === '1')
      } catch {
        setWslAuthorized(false)
      }
      return
    }
    try {
      const res = await invoke<WslGatewayAccessStatus>('wsl_gateway_access_status')
      const authorized = Boolean(res.authorized)
      setWslAuthorized(authorized)
      setWslHost(res.wsl_host?.trim() || GATEWAY_WSL2_HOST)
      persistWslAuthorized(authorized)
    } catch {
      // noop
    }
  }

  async function authorizeWslAccess() {
    if (isDevPreview) {
      setWslAuthorized(true)
      persistWslAuthorized(true)
      flashToast('WSL2 gateway access authorized [TEST]')
      return
    }
    setWslBusy(true)
    try {
      const res = await invoke<WslGatewayTest>('wsl_gateway_authorize_access')
      const authorized = Boolean(res.authorized)
      setWslAuthorized(authorized)
      setWslHost(res.wsl_host?.trim() || GATEWAY_WSL2_HOST)
      persistWslAuthorized(authorized)
      flashToast('WSL2 gateway access authorized')
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      setWslBusy(false)
    }
  }

  async function revokeWslAccess() {
    if (isDevPreview) {
      setWslAuthorized(false)
      persistWslAuthorized(false)
      flashToast('WSL2 gateway access revoked [TEST]')
      return
    }
    setWslBusy(true)
    try {
      const res = await invoke<WslGatewayTest>('wsl_gateway_revoke_access')
      const authorized = Boolean(res.authorized)
      setWslAuthorized(authorized)
      setWslHost(res.wsl_host?.trim() || GATEWAY_WSL2_HOST)
      persistWslAuthorized(authorized)
      flashToast('WSL2 gateway access revoked')
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      setWslBusy(false)
    }
  }

  useEffect(() => {
    if (!open || !useWsl) return
    void refreshWslAccessStatus()
  }, [open, useWsl, isDevPreview])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== WSL_AUTH_STORAGE_KEY) return
      setWslAuthorized(event.newValue === '1')
    }
    const onCustom = (event: Event) => {
      const customEvent = event as CustomEvent<boolean>
      if (typeof customEvent.detail === 'boolean') setWslAuthorized(customEvent.detail)
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(WSL_AUTH_EVENT, onCustom as EventListener)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(WSL_AUTH_EVENT, onCustom as EventListener)
    }
  }, [])

  if (!open) return null

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
          Windows-only (Windows + WSL2 UNC). Windows defaults to %USERPROFILE%\\.codex. WSL2 defaults to WSL2
          home (if available).
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
            />
            {hasWslDir && !wslPathValid ? (
              <div className="aoHint" style={{ marginTop: 6 }}>
                Use a WSL2 UNC path like `\\\\wsl.localhost\\Distro\\home\\user\\.codex`.
              </div>
            ) : null}
            {useWsl ? (
              <div
                className="aoCardInset"
                style={{
                  marginTop: 10,
                  border: '1px solid rgba(13, 18, 32, 0.1)',
                  borderRadius: 12,
                  padding: 10,
                  display: 'grid',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="aoMiniLabel">WSL2 gateway access</span>
                </div>
                <div className="aoHint">
                  App can apply/remove Windows networking rules for WSL2 access. You can authorize and revoke repeatedly.
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    className="aoBtn aoBtnPrimary"
                    onClick={() => void authorizeWslAccess()}
                    disabled={wslBusy || wslAuthorized}
                  >
                    {wslAuthorized ? 'Authorized' : 'Authorize (Admin)'}
                  </button>
                  <button
                    className={`aoBtn${wslAuthorized ? ' aoBtnDanger' : ''}`}
                    onClick={() => void revokeWslAccess()}
                    disabled={wslBusy || !wslAuthorized}
                  >
                    Revoke
                  </button>
                </div>
                <div className="aoHint">{wslAccessSummary(wslAuthorized, wslHost, gatewayPort)}</div>
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
