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

export function InstructionModal({
  open,
  onClose,
  onOpenConfigureDirs,
  onOpenRawConfig,
  codeText,
  listenPort,
  flashToast: _flashToast,
  isDevPreview: _isDevPreview,
}: Props) {
  const wslHost = GATEWAY_WSL2_HOST
  const gatewayPort = normalizeGatewayPort(listenPort)

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
          <section className="aoGsHero" role="note" aria-label="getting started summary">
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

                <section className="aoGsStepCard" role="note" aria-label="step 5 wsl2 native base url">
                  <div className="aoGsStepHead">
                    <span className="aoGsStepNum">5</span>
                    <span className="aoGsStepTitle">WSL2 uses native gateway access</span>
                    <span className="aoGsStepTag">Info</span>
                  </div>
                  <div className="aoGsAssist">
                    Use <code>base_url = "{buildGatewayBaseUrl(wslHost, gatewayPort)}"</code> in WSL2. No extra Windows
                    authorization is required.
                  </div>
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
