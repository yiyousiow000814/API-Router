import { ModalBackdrop } from './ModalBackdrop'
import type { Config } from '../types'

type Props = {
  open: boolean
  config: Config | null
  newProviderName: string
  newProviderBaseUrl: string
  newProviderKey: string
  newProviderKeyStorage: 'auth_json' | 'config_toml_experimental_bearer_token'
  nextProviderPlaceholder: string
  setNewProviderName: (next: string) => void
  setNewProviderBaseUrl: (next: string) => void
  setNewProviderKey: (next: string) => void
  setNewProviderKeyStorage: (next: 'auth_json' | 'config_toml_experimental_bearer_token') => void
  onAddProvider: () => void
  onFollowSource: (nodeId: string) => void
  onClearFollowSource: () => void
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
  newProviderKeyStorage,
  nextProviderPlaceholder,
  setNewProviderName,
  setNewProviderBaseUrl,
  setNewProviderKey,
  setNewProviderKeyStorage,
  onAddProvider,
  onFollowSource,
  onClearFollowSource,
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
          <div className="aoCard aoConfigCard">
            <div className="aoConfigPanel">
              <div className="aoMiniTitle">Config source</div>
              <div className="aoMuted">
                {config.config_source?.mode === 'follow'
                  ? 'Borrowing provider definitions from a LAN peer. Local provider edits are locked until you switch back.'
                  : 'Using this device\'s local provider definitions.'}
              </div>
              <div className="aoProviderConfigList">
                {(config.config_source?.sources ?? []).map((source) => (
                  <div className="aoProviderConfigCard" key={source.node_id}>
                    <div className="aoProviderConfigBody">
                      <div className="aoProviderField aoProviderLeft">
                        <div className="aoProviderNameRow">
                          <span className="aoProviderName">{source.node_name}</span>
                          <span className="aoProviderGroupTag">{source.kind}</span>
                          {source.active ? <span className="aoProviderGroupTag">Active</span> : null}
                        </div>
                        <div className="aoModalSub">
                          using count: {source.using_count}
                          {source.follow_blocked_reason ? ` | ${source.follow_blocked_reason}` : ''}
                        </div>
                      </div>
                      <div className="aoProviderField aoProviderRight">
                        <div className="aoUsageBtns">
                          {source.kind === 'local' ? (
                            <button className="aoTinyBtn" disabled={source.active} onClick={onClearFollowSource}>
                              Use Local
                            </button>
                          ) : (
                            <button
                              className="aoTinyBtn"
                              disabled={!source.follow_allowed || source.active}
                              onClick={() => onFollowSource(source.node_id)}
                            >
                              Follow
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
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
                      disabled={config.config_source?.mode === 'follow'}
                      onChange={(e) => setNewProviderName(e.target.value)}
                    />
                    <input
                      className="aoInput"
                      placeholder="Base URL (e.g. https://api.openai.com/v1)"
                      value={newProviderBaseUrl}
                      disabled={config.config_source?.mode === 'follow'}
                      onChange={(e) => setNewProviderBaseUrl(e.target.value)}
                    />
                    <input
                      className="aoInput"
                      type="password"
                      placeholder="Key"
                      value={newProviderKey}
                      disabled={config.config_source?.mode === 'follow'}
                      onChange={(e) => setNewProviderKey(e.target.value)}
                    />
                    <select
                      className="aoSelect aoAddProviderStorageSelect"
                      value={newProviderKeyStorage}
                      disabled={config.config_source?.mode === 'follow'}
                      onChange={(e) =>
                        setNewProviderKeyStorage(
                          e.target.value as 'auth_json' | 'config_toml_experimental_bearer_token',
                        )
                      }
                    >
                      <option value="auth_json">auth.json</option>
                      <option value="config_toml_experimental_bearer_token">experimental_bearer_token</option>
                    </select>
                    <button
                      className="aoBtn aoBtnPrimary aoAddProviderSubmit"
                      disabled={config.config_source?.mode === 'follow'}
                      onClick={onAddProvider}
                    >
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
