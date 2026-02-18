import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ModalBackdrop } from './ModalBackdrop'
import { GATEWAY_WINDOWS_HOST, GATEWAY_WSL2_HOST } from '../constants'
import { buildGatewayBaseUrl, normalizeGatewayPort } from '../utils/gatewayUrl'

type Props = {
  open: boolean
  onClose: () => void
  onOpenConfigureDirs: () => void
  onOpenRawConfig: () => void
  codeText: string
  listenPort: number
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  isDevPreview: boolean
}

type WslGatewayAccessStatus = {
  ok: boolean
  authorized: boolean
  wsl_host?: string
}

type WslGatewayAccessMutation = {
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

export function InstructionModal({
  open,
  onClose,
  onOpenConfigureDirs,
  onOpenRawConfig,
  codeText,
  listenPort,
  flashToast,
  isDevPreview,
}: Props) {
  const [wslBusy, setWslBusy] = useState<boolean>(false)
  const [wslAuthorized, setWslAuthorized] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ao:wsl-gateway-authorized') === '1'
    } catch {
      return false
    }
  })
  const [wslHost, setWslHost] = useState<string>(GATEWAY_WSL2_HOST)
  const gatewayPort = normalizeGatewayPort(listenPort)

  async function refreshWslAccessStatus() {
    if (isDevPreview) {
      try {
        const saved = localStorage.getItem('ao:wsl-gateway-authorized') === '1'
        setWslAuthorized(saved)
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
      try {
        localStorage.setItem('ao:wsl-gateway-authorized', authorized ? '1' : '0')
      } catch {
        // noop
      }
    } catch {
      // keep UI responsive; status can be fetched after user action
    }
  }

  useEffect(() => {
    void refreshWslAccessStatus()
  }, [])

  useEffect(() => {
    if (!open) return
    void refreshWslAccessStatus()
  }, [open])

  async function authorizeWslAccess() {
    if (isDevPreview) {
      setWslAuthorized(true)
      try {
        localStorage.setItem('ao:wsl-gateway-authorized', '1')
      } catch {
        // no-op in environments without storage
      }
      flashToast('WSL2 gateway access authorized [TEST]')
      return
    }
    setWslBusy(true)
    try {
      const res = await invoke<WslGatewayAccessMutation>('wsl_gateway_authorize_access')
      const authorized = Boolean(res.authorized)
      setWslAuthorized(authorized)
      setWslHost(res.wsl_host?.trim() || GATEWAY_WSL2_HOST)
      try {
        localStorage.setItem('ao:wsl-gateway-authorized', authorized ? '1' : '0')
      } catch {
        // noop
      }
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
      try {
        localStorage.setItem('ao:wsl-gateway-authorized', '0')
      } catch {
        // no-op in environments without storage
      }
      flashToast('WSL2 gateway access revoked [TEST]')
      return
    }
    setWslBusy(true)
    try {
      const res = await invoke<WslGatewayAccessMutation>('wsl_gateway_revoke_access')
      const authorized = Boolean(res.authorized)
      setWslAuthorized(authorized)
      setWslHost(res.wsl_host?.trim() || GATEWAY_WSL2_HOST)
      try {
        localStorage.setItem('ao:wsl-gateway-authorized', authorized ? '1' : '0')
      } catch {
        // noop
      }
      flashToast('WSL2 gateway access revoked')
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      setWslBusy(false)
    }
  }

  if (!open) return null
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal aoGsModal" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div className="aoModalTitle">Getting Started</div>
          <button className="aoBtn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="aoModalBody aoGsBody">
          <section className="aoGsHero" role="note" aria-label="getting started overview">
            <div className="aoGsHeroTitle">Connect Codex to API Router</div>
            <div className="aoGsHeroDesc">Follow these steps in order. Most users finish in 3-5 minutes.</div>
          </section>
          <div className="aoGsColumns">
            <section className="aoGsGroup" aria-label="setup steps">
              <div className="aoGsGroupHead">
                <span className="aoGsGroupTitle">Setup</span>
                <span className="aoGsGroupHint">Start here</span>
              </div>
              <div className="aoGsList">
                <section className="aoGsStepCard" role="note" aria-label="step 1 install codex">
                  <div className="aoGsStepHead">
                    <span className="aoGsStepNum">1</span>
                    <span className="aoGsStepTitle">Install Codex in Terminal</span>
                    <span className="aoGsStepTag">Required</span>
                  </div>
                  <pre className="aoInstructionCode aoGsCodeBlock">npm install -g @openai/codex</pre>
                  <div className="aoGsMuted">
                    Or visit{' '}
                    <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer">
                      github.com/openai/codex
                    </a>
                    .
                  </div>
                </section>

                <section className="aoGsStepCard" role="note" aria-label="step 2 configure directories">
                  <div className="aoGsStepHead">
                    <span className="aoGsStepNum">2</span>
                    <span className="aoGsStepTitle">Configure Windows / WSL2 directories</span>
                    <span className="aoGsStepTag">Required</span>
                  </div>
                  <div className="aoGsActionRow">
                    <button className="aoBtn aoBtnPrimary" onClick={onOpenConfigureDirs}>
                      Configure Directories
                    </button>
                  </div>
                </section>

                <section className="aoGsStepCard" role="note" aria-label="step 3 edit config">
                  <div className="aoGsStepHead">
                    <span className="aoGsStepNum">3</span>
                    <span className="aoGsStepTitle">Run Codex once, then edit config.toml</span>
                    <span className="aoGsStepTag">Required</span>
                  </div>
                  <div className="aoGsActionRow">
                    <button className="aoBtn aoBtnPrimary" onClick={onOpenRawConfig}>
                      Edit config.toml
                    </button>
                  </div>
                </section>
              </div>
            </section>

            <section className="aoGsGroup" aria-label="router steps">
              <div className="aoGsGroupHead">
                <span className="aoGsGroupTitle">API Router config</span>
                <span className="aoGsGroupHint">Then finish here</span>
              </div>
              <div className="aoGsList">
                <section className="aoGsStepCard" role="note" aria-label="step 4 config content">
                  <div className="aoGsStepHead">
                    <span className="aoGsStepNum">4</span>
                    <span className="aoGsStepTitle">Paste this into config.toml</span>
                    <span className="aoGsStepTag">Required</span>
                  </div>
                  <div className="aoGsAssist">
                    Before pasting: ensure <code>model_provider = "api_router"</code> is at file top (replace existing or add
                    it), then append <code>[model_providers.api_router]</code> section at file bottom.
                  </div>
                  <div className="aoGsAssist">
                    Windows: <code>base_url = "{buildGatewayBaseUrl(GATEWAY_WINDOWS_HOST, gatewayPort)}"</code>.
                    <br />
                    WSL2: <code>base_url = "{buildGatewayBaseUrl(wslHost, gatewayPort)}"</code>.
                  </div>
                  <pre className="aoInstructionCode aoGsCodeBlock">{codeText}</pre>
                </section>

                <section className="aoGsStepCard" role="note" aria-label="step 5 adjust switchboard">
                  <div className="aoGsStepHead">
                    <span className="aoGsStepNum">5</span>
                    <span className="aoGsStepTitle">WSL2 gateway access</span>
                    <span className="aoGsStepTag">Optional</span>
                  </div>
                  <div className="aoGsAssist">
                    App can apply/remove Windows networking rules for WSL2 access. You can authorize and revoke repeatedly.
                  </div>
                  <div className="aoGsActionRow">
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
                  <div className="aoGsMuted">{wslAccessSummary(wslAuthorized, wslHost, gatewayPort)}</div>
                </section>

                <section className="aoGsStepCard" role="note" aria-label="step 6 auth auto managed">
                  <div className="aoGsStepHead">
                    <span className="aoGsStepNum">6</span>
                    <span className="aoGsStepTitle">No manual auth.json edits needed</span>
                    <span className="aoGsStepTag">Auto</span>
                  </div>
                  <div className="aoGsMuted">API Router handles auth.json automatically.</div>
                </section>
              </div>
            </section>
          </div>
        </div>
      </div>
    </ModalBackdrop>
  )
}
