import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  onClose: () => void
  codeText: string
}

export function InstructionModal({ open, onClose, codeText }: Props) {
  if (!open) return null
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div className="aoModalTitle">Codex config</div>
          <button className="aoBtn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="aoModalBody">
          <div className="aoModalSub">Open .codex/config.toml and add:</div>
          <pre className="aoInstructionCode">{codeText}</pre>
        </div>
      </div>
    </ModalBackdrop>
  )
}
