import { ModalBackdrop } from './ModalBackdrop'
import type { Config } from '../types'

type Props = {
  open: boolean
  config: Config | null
  newProviderName: string
  newProviderBaseUrl: string
  newProviderKey: string
  nextProviderPlaceholder: string
  setNewProviderName: (next: string) => void
  setNewProviderBaseUrl: (next: string) => void
  setNewProviderKey: (next: string) => void
  onAddProvider: () => void
  onOpenGroupManager: () => void
  onClose: () => void
  providerListRef: React.RefObject<HTMLDivElement | null>
  orderedConfigProviders: string[]
  dragPreviewOrder: string[] | null
  draggingProvider: string | null
  dragCardHeight: number
  renderProviderCard: (name: string, forceDrag?: boolean) => React.ReactNode
}

export function ConfigModal({
  open,
  config,
  newProviderName,
  newProviderBaseUrl,
  newProviderKey,
  nextProviderPlaceholder,
  setNewProviderName,
  setNewProviderBaseUrl,
  setNewProviderKey,
  onAddProvider,
  onOpenGroupManager,
  onClose,
  providerListRef,
  orderedConfigProviders,
  dragPreviewOrder,
  draggingProvider,
  dragCardHeight,
  renderProviderCard,
}: Props) {
  if (!open || !config) return null
  const dragPlaceholderHeight = dragCardHeight > 0 ? dragCardHeight : 56
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal aoModalWide" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div className="aoConfigHeaderMeta">
            <div className="aoModalTitle">Config</div>
            <div className="aoModalSub aoConfigHeaderSub">keys are stored in ./user-data/secrets.json</div>
          </div>
          <div className="aoRow aoConfigHeaderActions">
            <button className="aoBtn aoBtnPrimary aoConfigHeaderBtn" onClick={onOpenGroupManager}>
              Group Manager
            </button>
            <span className="aoConfigHeaderDivider" aria-hidden="true" />
            <button className="aoBtn aoConfigHeaderBtn aoConfigHeaderBtnClose" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="aoModalBody aoConfigModalBody">
          <div className="aoConfigStickyAddProvider">
            <div className="aoCard aoConfigCard">
              <div className="aoConfigDeck">
                <div className="aoConfigPanel">
                  <div className="aoMiniTitle">Add provider</div>
                  <div className="aoAddProviderRow">
                    <input
                      className="aoInput"
                      placeholder={nextProviderPlaceholder}
                      value={newProviderName}
                      onChange={(e) => setNewProviderName(e.target.value)}
                    />
                    <input
                      className="aoInput"
                      placeholder="Base URL (e.g. https://api.openai.com/v1)"
                      value={newProviderBaseUrl}
                      onChange={(e) => setNewProviderBaseUrl(e.target.value)}
                    />
                    <input
                      className="aoInput"
                      type="password"
                      placeholder="Key"
                      value={newProviderKey}
                      onChange={(e) => setNewProviderKey(e.target.value)}
                    />
                    <button className="aoBtn aoBtnPrimary" onClick={onAddProvider}>
                      Add
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="aoProviderConfigList" ref={providerListRef}>
            {(dragPreviewOrder ?? orderedConfigProviders).map((name) => {
              if (draggingProvider === name) {
                return (
                  <div
                    className="aoProviderConfigPlaceholder"
                    key={`${name}-placeholder`}
                    style={{ height: dragPlaceholderHeight, minHeight: dragPlaceholderHeight }}
                  />
                )
              }
              return renderProviderCard(name)
            })}
            {draggingProvider ? renderProviderCard(draggingProvider, true) : null}
          </div>
        </div>
      </div>
    </ModalBackdrop>
  )
}
