import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  tokenPreview: string
  tokenReveal: string
  onClose: () => void
  onReveal: () => void
  onRotate: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function GatewayTokenModal({ open, tokenPreview, tokenReveal, onClose, onReveal, onRotate }: Props) {
  if (!open) return null
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal">
        <div className="aoModalTitle">Codex gateway token</div>
        <div className="aoModalSub">
          Set <span style={{ fontFamily: mono }}>OPENAI_API_KEY</span> in{' '}
          <span style={{ fontFamily: mono }}>.codex/auth.json</span> to this value.
          <br />
          Stored in <span style={{ fontFamily: mono }}>./user-data/secrets.json</span>.
        </div>
        <input
          className="aoInput"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          readOnly
          value={tokenReveal || tokenPreview}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="aoModalActions">
          <button className="aoBtn" onClick={onClose}>
            Close
          </button>
          <button className="aoBtn" onClick={onReveal}>
            Reveal
          </button>
          <button className="aoBtn aoBtnDanger" onClick={onRotate}>
            Rotate
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
