import { ModalBackdrop } from './ModalBackdrop'

type Props = {
  open: boolean
  provider: string
  supportsWebsockets: boolean
  onToggleSupportsWebsockets: (enabled: boolean) => void
  onCancel: () => void
  onSave: () => void
}

export function ProviderAdvancedModal({
  open,
  provider,
  supportsWebsockets,
  onToggleSupportsWebsockets,
  onCancel,
  onSave,
}: Props) {
  if (!open) return null

  return (
    <ModalBackdrop onClose={onCancel}>
      <div className="aoModal aoProviderAdvancedModal" onClick={(event) => event.stopPropagation()}>
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Provider Advanced</div>
            <div className="aoModalSub">
              {provider || 'Provider'} advanced transport settings.
            </div>
          </div>
        </div>
        <div className="aoModalBody aoProviderAdvancedModalBody">
          <div className="aoProviderAdvancedCard">
            <div className="aoProviderAdvancedCardHead">
              <div>
                <div className="aoProviderAdvancedLabel">Enable WebSocket</div>
                <div className="aoProviderAdvancedHint">
                  Turn this on only for providers that expose a websocket-capable responses API.
                </div>
              </div>
              <button
                type="button"
                className={`aoStatusSwitch aoProviderAdvancedSwitch ${supportsWebsockets ? 'aoStatusSwitchOn' : 'aoStatusSwitchOff'}`}
                aria-label={supportsWebsockets ? 'Disable WebSocket' : 'Enable WebSocket'}
                aria-pressed={supportsWebsockets}
                onClick={() => onToggleSupportsWebsockets(!supportsWebsockets)}
              >
                <span className="aoStatusSwitchThumb" aria-hidden="true" />
              </button>
            </div>
            <div className="aoProviderAdvancedNote">
              Saved as <code>supports_websockets = true</code>. Disabled state removes the field from config.
            </div>
          </div>
        </div>
        <div className="aoModalActions">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn aoBtnPrimary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
