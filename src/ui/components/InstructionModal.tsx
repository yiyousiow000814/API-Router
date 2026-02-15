import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  onClose: () => void
  onOpenConfigureDirs: () => void
  onOpenRawConfig: () => void
  codeText: string
}

export function InstructionModal({ open, onClose, onOpenConfigureDirs, onOpenRawConfig, codeText }: Props) {
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
                  <pre className="aoInstructionCode aoGsCodeBlock">{codeText}</pre>
                </section>

                <section className="aoGsStepCard" role="note" aria-label="step 5 adjust switchboard">
                  <div className="aoGsStepHead">
                    <span className="aoGsStepNum">5</span>
                    <span className="aoGsStepTitle">Fine-tune in Provider Switchboard if needed</span>
                    <span className="aoGsStepTag">Optional</span>
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
