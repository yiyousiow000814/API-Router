import { useEffect, useRef, useState } from 'react'
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
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const sourceMenuRef = useRef<HTMLDivElement | null>(null)
  const dragPlaceholderHeight = dragCardHeight > 0 ? dragCardHeight : 56
  const configSources =
    config.config_source?.sources && config.config_source.sources.length > 0
      ? config.config_source.sources
      : [
          {
            kind: 'local' as const,
            node_id: 'local-fallback',
            node_name: 'Local',
            active: true,
            follow_allowed: false,
            follow_blocked_reason: null,
            using_count: 1,
          },
        ]
  const selectedConfigSourceValue =
    configSources.find((source) => source.active)?.node_id ??
    config.config_source?.followed_node_id ??
    configSources[0]?.node_id ??
    'local-fallback'
  const selectedConfigSource =
    configSources.find((source) => source.node_id === selectedConfigSourceValue) ?? configSources[0]
  const selectedUsingCount = selectedConfigSource?.using_count ?? 0
  const selectedUsingLabel =
    selectedConfigSource?.kind === 'local'
      ? `${selectedUsingCount} using`
      : `${selectedUsingCount} follow`

  useEffect(() => {
    if (!sourceMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (sourceMenuRef.current?.contains(target)) return
      setSourceMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSourceMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [sourceMenuOpen])
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal aoModalWide aoConfigModalShell" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div className="aoConfigHeaderMeta">
            <div className="aoModalTitle">Config</div>
            <div className="aoModalSub aoConfigHeaderSub">keys are stored in ./user-data/secrets.json</div>
          </div>
          <div className="aoConfigHeaderSource" aria-label="Config source">
            <div className="aoActionsMenuWrap aoConfigSourceMenuWrap" ref={sourceMenuRef}>
              <button
                type="button"
                className={`aoSelect aoConfigSourceSelect aoConfigSourceTrigger${sourceMenuOpen ? ' is-open' : ''}`}
                aria-label="Config source"
                aria-haspopup="menu"
                aria-expanded={sourceMenuOpen}
                onClick={() => setSourceMenuOpen((openValue) => !openValue)}
              >
                <span className="aoConfigSourceTriggerIcon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <rect x="4" y="5" width="16" height="10" rx="2" />
                    <path d="M9 19h6" />
                    <path d="M12 15v4" />
                  </svg>
                </span>
                <span className="aoConfigSourceTriggerLabel">
                  {selectedConfigSource?.kind === 'local' ? 'Local' : selectedConfigSource?.node_name}
                </span>
                <span className="aoConfigSourceTriggerMeta">{selectedUsingLabel}</span>
                <span className="aoConfigSourceChevron" aria-hidden="true">
                  ▾
                </span>
              </button>
              {sourceMenuOpen ? (
                <div className="aoMenu aoMenuCompact aoConfigSourceMenu" role="menu" aria-label="Config source options">
                  {configSources.map((source) => {
                    const label = source.kind === 'local' ? 'Local' : source.node_name
                    const blockedReason = source.follow_blocked_reason?.trim() || ''
                    const disabled = source.kind === 'peer' && !source.follow_allowed
                    const actionLabel =
                      source.kind === 'local'
                        ? source.active
                          ? 'Current'
                          : 'Use local'
                        : source.active
                          ? 'Following'
                          : disabled
                            ? 'Unavailable'
                            : 'Follow'
                    return (
                      <button
                        key={source.node_id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={source.node_id === selectedConfigSourceValue}
                        className={`aoMenuItem aoConfigSourceMenuItem${
                          source.node_id === selectedConfigSourceValue ? ' is-current' : ''
                        }`}
                        disabled={disabled}
                        title={blockedReason || label}
                        onClick={() => {
                          setSourceMenuOpen(false)
                          if (source.kind === 'local') {
                            onClearFollowSource()
                            return
                          }
                          if (disabled || source.active) return
                          onFollowSource(source.node_id)
                        }}
                      >
                        <span className="aoConfigSourceMenuCheck" aria-hidden="true">
                          {source.node_id === selectedConfigSourceValue ? '✓' : ''}
                        </span>
                        <span className="aoConfigSourceMenuText">
                          <span className="aoConfigSourceMenuLabel">{label}</span>
                          {source.kind === 'peer' ? (
                            <span className="aoConfigSourceMenuSub">
                              {source.using_count > 0
                                ? `${source.using_count} device${source.using_count === 1 ? '' : 's'}`
                                : 'LAN peer'}
                            </span>
                          ) : null}
                        </span>
                        <span className="aoConfigSourceMenuMeta">
                          {actionLabel}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
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
