import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  value: string
  explicitValue: string
  onChange: (next: string) => void
  onCancel: () => void
  onClear: () => void
  onSave: () => void
}

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export function UsageBaseModal({
  open,
  provider,
  value,
  explicitValue,
  onChange,
  onCancel,
  onClear,
  onSave,
}: Props) {
  if (!open) return null
  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onCancel}>
      <div className="aoModal !w-[min(560px,92vw)] !rounded-2xl !p-6">
        <div className="aoModalTitle text-lg font-semibold tracking-tight">Usage base URL</div>
        <div className="aoModalSub mt-2 text-sm leading-6">
          Provider: <span style={{ fontFamily: mono }}>{provider}</span>
          <br />
          Usage source URL used for quota/usage fetch.
        </div>
        <input
          className="aoInput mt-3 w-full rounded-xl"
          style={{ width: '100%', height: 36, borderRadius: 12 }}
          placeholder="https://..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="aoModalActions mt-4 flex flex-wrap gap-2">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn" onClick={onClear} disabled={!explicitValue}>
            Clear
          </button>
          <button className="aoBtn aoBtnPrimary" onClick={onSave} disabled={!value.trim()}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
