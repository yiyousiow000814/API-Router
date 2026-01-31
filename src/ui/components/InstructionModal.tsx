type Props = {
  open: boolean
  onClose: () => void
  onBackdropMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  onBackdropMouseUp: (e: React.MouseEvent<HTMLDivElement>) => void
  codeText: string
}

export function InstructionModal({ open, onClose, onBackdropMouseDown, onBackdropMouseUp, codeText }: Props) {
  if (!open) return null
  return (
    <div
      className="aoModalBackdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={onBackdropMouseDown}
      onMouseUp={onBackdropMouseUp}
    >
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
    </div>
  )
}
