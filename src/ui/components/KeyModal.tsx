import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  value: string
  onChange: (next: string) => void
  onCancel: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function KeyModal({ open, provider, value, onChange, onCancel, onSave }: Props) {
  if (!open) return null
  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onCancel}>
      <div className="aoModal !w-[min(560px,92vw)] !rounded-2xl !p-6">
        <div className="aoModalTitle text-lg font-semibold tracking-tight">Set API key</div>
        <div className="aoModalSub mt-2 text-sm leading-6">
          Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          <br />
          Stored in ./user-data/secrets.json (gitignored).
        </div>
        <input
          className="aoInput mt-3 w-full rounded-xl"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          placeholder="Paste API key..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="aoModalActions mt-4 flex flex-wrap gap-2">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={!value}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
