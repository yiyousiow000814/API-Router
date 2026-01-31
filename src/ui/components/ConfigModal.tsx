import type { Config } from '../types'

type Props = {
  open: boolean
  config: Config | null
  allProviderPanelsOpen: boolean
  setAllProviderPanels: (next: boolean) => void
  newProviderName: string
  newProviderBaseUrl: string
  nextProviderPlaceholder: string
  setNewProviderName: (next: string) => void
  setNewProviderBaseUrl: (next: string) => void
  onAddProvider: () => void
  onClose: () => void
  providerListRef: React.RefObject<HTMLDivElement | null>
  orderedConfigProviders: string[]
  dragPreviewOrder: string[] | null
  draggingProvider: string | null
  dragCardHeight: number
  renderProviderCard: (name: string, forceDrag?: boolean) => React.ReactNode
  onBackdropMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  onBackdropMouseUp: (e: React.MouseEvent<HTMLDivElement>) => void
}

export function ConfigModal({
  open,
  config,
  allProviderPanelsOpen,
  setAllProviderPanels,
  newProviderName,
  newProviderBaseUrl,
  nextProviderPlaceholder,
  setNewProviderName,
  setNewProviderBaseUrl,
  onAddProvider,
  onClose,
  providerListRef,
  orderedConfigProviders,
  dragPreviewOrder,
  draggingProvider,
  dragCardHeight,
  renderProviderCard,
  onBackdropMouseDown,
  onBackdropMouseUp,
}: Props) {
  if (!open || !config) return null
  return (
    <div
      className="aoModalBackdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={onBackdropMouseDown}
      onMouseUp={onBackdropMouseUp}
    >
      <div className="aoModal aoModalWide" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div className="aoModalTitle">Config</div>
          <div className="aoRow">
            <button className="aoBtn" onClick={() => setAllProviderPanels(!allProviderPanelsOpen)}>
              {allProviderPanelsOpen ? 'Hide all' : 'Show all'}
            </button>
            <button className="aoBtn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="aoModalBody">
          <div className="aoModalSub">keys are stored in ./user-data/secrets.json (gitignored)</div>
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
                    placeholder="Base URL (e.g. http://127.0.0.1:4001)"
                    value={newProviderBaseUrl}
                    onChange={(e) => setNewProviderBaseUrl(e.target.value)}
                  />
                  <button className="aoBtn aoBtnPrimary" onClick={onAddProvider}>
                    Add
                  </button>
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
                    style={{ height: dragCardHeight || 0 }}
                  />
                )
              }
              return renderProviderCard(name)
            })}
            {draggingProvider ? renderProviderCard(draggingProvider, true) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
