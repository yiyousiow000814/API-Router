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
  onFollowSource: (nodeId: string) => Promise<void> | void
  onClearFollowSource: () => Promise<void> | void
  onRequestPair: (nodeId: string) => Promise<string | null | void> | string | null | void
  onApprovePair: (requestId: string) => Promise<string | null | void> | string | null | void
  onSubmitPairPin: (nodeId: string, requestId: string, pinCode: string) => Promise<void> | void
  onSyncPeerVersion: (nodeId: string) => Promise<void> | void
  onOpenGroupManager: () => void
  onClose: () => void
  providerListRef: React.RefObject<HTMLDivElement | null>
  orderedConfigProviders: string[]
  dragPreviewOrder: string[] | null
  draggingProvider: string | null
  dragCardHeight: number
  renderProviderCard: (name: string, forceDrag?: boolean) => React.ReactNode
}

type PairDialogState =
  | { mode: 'waiting_approval'; nodeId: string; nodeName: string; requestId: string }
  | { mode: 'enter_pin'; nodeId: string; nodeName: string; requestId: string }
  | { mode: 'show_pin'; nodeId: string; nodeName: string; pinCode: string }
  | { mode: 'paired'; nodeId: string; nodeName: string }

function normalizePinInput(value: string): string {
  return value.replace(/\D+/g, '').slice(0, 6)
}

function emptyPairPinDigits(): string[] {
  return Array.from({ length: 6 }, () => '')
}

function formatPairDialogError(error: unknown): string {
  const text = String(error ?? '').trim()
  if (text.includes('pair approval is not ready yet')) {
    return 'Waiting for the other device to approve this pairing request.'
  }
  if (text.includes('Pairing PIN was not accepted.')) {
    return 'PIN was not accepted. Check the code and try again.'
  }
  return text || 'Pairing failed.'
}

function compactPeerStateLabel(
  source: NonNullable<Config['config_source']>['sources'][number],
): string {
  if (source.trusted) return 'Trusted'
  if (source.pair_state === 'incoming_request') return 'Needs approval'
  if (source.pair_state === 'pin_required') return 'PIN required'
  if (source.pair_state === 'requested') return 'Pending'
  return 'Unpaired'
}

function compactFollowStatusLabel(
  source: NonNullable<Config['config_source']>['sources'][number],
): string {
  if (source.active) return 'Following'
  if (source.follow_allowed) return 'Ready to follow'
  if (!source.trusted) return 'Pair required'
  if ((source.sync_blocked_domains?.length ?? 0) > 0) return 'Blocked by sync contract'
  return 'Unavailable'
}

function compactUpdateStatusLabel(
  source: NonNullable<Config['config_source']>['sources'][number],
): string {
  if (!source.version_sync_required) return 'No update needed'
  return source.same_version_update_allowed ? 'Update required' : 'Update blocked'
}

export function syncDomainLabel(domain: string): string {
  return domain.replace(/_/g, ' ')
}

function isGenericVersionSyncReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase()
  return (
    normalized.includes('sync paused for') &&
    normalized.includes('until both devices run compatible builds')
  )
}

export function diagnosticsWhyText(
  source: NonNullable<Config['config_source']>['sources'][number],
): string {
  if (source.version_sync_required) {
    const updateBlockedReason = source.same_version_update_blocked_reason?.trim()
    if (updateBlockedReason && !source.same_version_update_allowed) {
      return updateBlockedReason
    }
    const versionReason = source.version_sync_reason?.trim()
    if (versionReason && !isGenericVersionSyncReason(versionReason)) return versionReason
  } else {
    const followReason = source.follow_blocked_reason?.trim()
    if (followReason) return followReason
  }
  return ''
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
  onRequestPair,
  onApprovePair,
  onSubmitPairPin,
  onSyncPeerVersion,
  onOpenGroupManager,
  onClose,
  providerListRef,
  orderedConfigProviders,
  dragPreviewOrder,
  draggingProvider,
  dragCardHeight,
  renderProviderCard,
}: Props) {
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [pairDialog, setPairDialog] = useState<PairDialogState | null>(null)
  const [pairPinDigits, setPairPinDigits] = useState<string[]>(() => emptyPairPinDigits())
  const [pairDialogBusy, setPairDialogBusy] = useState(false)
  const [pairDialogError, setPairDialogError] = useState('')
  const sourceMenuRef = useRef<HTMLDivElement | null>(null)
  const pairPinInputRefs = useRef<Array<HTMLInputElement | null>>([])
  if (!open || !config) return null
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
            using_count: 0,
            version_sync_required: false,
            version_sync_reason: null,
            same_version_update_allowed: false,
            same_version_update_blocked_reason: null,
          },
        ]
  const showConfigSourceChooser = configSources.length > 1
  const selectedConfigSourceValue =
    configSources.find((source) => source.active)?.node_id ??
    config.config_source?.followed_node_id ??
    configSources[0]?.node_id ??
    'local-fallback'
  const selectedConfigSource =
    configSources.find((source) => source.node_id === selectedConfigSourceValue) ?? configSources[0]
  const selectedUsingCount = selectedConfigSource?.using_count ?? 0
  const selectedUsingLabel =
    selectedUsingCount > 0
      ? selectedConfigSource?.kind === 'local'
        ? `${selectedUsingCount} using`
        : `${selectedUsingCount} follow`
      : ''
  const updateRequiredSources = configSources.filter(
    (source) => source.kind === 'peer' && source.version_sync_required,
  )
  const peerSources = configSources.filter((source) => source.kind === 'peer')

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
  useEffect(() => {
    if (pairDialog?.mode !== 'enter_pin') return
    pairPinInputRefs.current[0]?.focus()
  }, [pairDialog])
  useEffect(() => {
    if (!open || !config) return
    if (pairDialog?.mode === 'waiting_approval') {
      const source = config.config_source?.sources.find((entry) => entry.node_id === pairDialog.nodeId)
      if (!source) return
      if (source.trusted) {
        setPairDialog({
          mode: 'paired',
          nodeId: pairDialog.nodeId,
          nodeName: pairDialog.nodeName,
        })
        return
      }
      if (source.pair_state === 'pin_required') {
        setPairDialog({
          mode: 'enter_pin',
          nodeId: pairDialog.nodeId,
          nodeName: pairDialog.nodeName,
          requestId: pairDialog.requestId,
        })
        setPairDialogError('')
      }
      return
    }
    if (pairDialog?.mode !== 'show_pin') return
    const source = config.config_source?.sources.find((entry) => entry.node_id === pairDialog.nodeId)
    if (!source?.trusted) return
    setPairDialog({
      mode: 'paired',
      nodeId: pairDialog.nodeId,
      nodeName: pairDialog.nodeName,
    })
  }, [config, pairDialog])
  useEffect(() => {
    if (pairDialog?.mode !== 'paired') return
    const timer = window.setTimeout(() => {
      setPairDialog(null)
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [pairDialog])

  async function submitPairPinFromDialog() {
    if (pairDialog?.mode !== 'enter_pin') return
    const pinCode = normalizePinInput(pairPinDigits.join(''))
    if (pinCode.length !== 6) return
    setPairDialogBusy(true)
    setPairDialogError('')
    try {
      await onSubmitPairPin(pairDialog.nodeId, pairDialog.requestId, pinCode)
      setPairDialog({
        mode: 'paired',
        nodeId: pairDialog.nodeId,
        nodeName: pairDialog.nodeName,
      })
      setPairPinDigits(emptyPairPinDigits())
    } catch (error) {
      setPairDialogError(formatPairDialogError(error))
    } finally {
      setPairDialogBusy(false)
    }
  }

  function updatePairPinAt(index: number, nextValue: string) {
    const digit = nextValue.replace(/\D+/g, '').slice(-1)
    const nextDigits = [...pairPinDigits]
    nextDigits[index] = digit
    setPairPinDigits(nextDigits)
    if (digit && index < 5) {
      queueMicrotask(() => pairPinInputRefs.current[index + 1]?.focus())
    }
  }

  function clearPairPinAt(index: number) {
    const nextDigits = [...pairPinDigits]
    nextDigits[index] = ''
    setPairPinDigits(nextDigits)
  }
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal aoModalWide aoConfigModalShell" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div className="aoConfigHeaderMeta">
            <div className="aoModalTitle">Config</div>
            <div className="aoModalSub aoConfigHeaderSub">keys are stored in ./user-data/secrets.json</div>
          </div>
          <div className="aoConfigHeaderSource" aria-label="Config source">
            {showConfigSourceChooser ? (
              <div className="aoConfigSourceControls">
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
                    {selectedUsingLabel ? (
                      <span className="aoConfigSourceTriggerMeta">{selectedUsingLabel}</span>
                    ) : null}
                    <span className="aoConfigSourceChevron" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                  {sourceMenuOpen ? (
                    <div className="aoMenu aoMenuCompact aoConfigSourceMenu" role="menu" aria-label="Config source options">
                      {configSources.map((source) => {
                        const label = source.kind === 'local' ? 'Local' : source.node_name
                        const blockedReason = source.follow_blocked_reason?.trim() || ''
                        const pairState = source.pair_state ?? null
                        const versionSyncRequired =
                          source.kind === 'peer' && Boolean(source.version_sync_required)
                        const versionSyncBlockedReason =
                          source.same_version_update_blocked_reason?.trim() || ''
                        const versionSyncActionAvailable =
                          versionSyncRequired && Boolean(source.same_version_update_allowed)
                        const pairActionAvailable =
                          source.kind === 'peer' &&
                          (!source.trusted ||
                            (source.trusted && source.follow_allowed && !source.active))
                        const disabled =
                          source.kind === 'peer' && !pairActionAvailable && !versionSyncActionAvailable
                        const actionLabel =
                          source.kind === 'local'
                            ? source.active
                              ? 'Current'
                              : 'Use local'
                            : versionSyncRequired
                              ? source.same_version_update_allowed
                                ? 'Update required'
                                : 'Update blocked'
                              : source.active
                              ? 'Following'
                              : !source.trusted && pairState === 'incoming_request'
                                ? 'Approve'
                              : !source.trusted && pairState === 'pin_required'
                                ? 'Enter PIN'
                              : !source.trusted && pairState === 'requested'
                                ? 'Requested'
                              : !source.trusted
                                ? 'Pair'
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
                            title={
                              versionSyncBlockedReason ||
                              source.version_sync_reason?.trim() ||
                              blockedReason ||
                              label
                            }
                            onClick={async () => {
                              setSourceMenuOpen(false)
                              if (source.kind === 'local') {
                                await onClearFollowSource()
                                return
                              }
                              if (!source.trusted && pairState === 'incoming_request' && source.pair_request_id) {
                                const pinCode = await onApprovePair(source.pair_request_id)
                                if (pinCode) {
                                  setPairDialogError('')
                                  setPairDialog({
                                    mode: 'show_pin',
                                    nodeId: source.node_id,
                                    nodeName: label,
                                    pinCode,
                                  })
                                }
                                return
                              }
                              if (!source.trusted && pairState === 'pin_required' && source.pair_request_id) {
                                setPairPinDigits(emptyPairPinDigits())
                                setPairDialogError('')
                                setPairDialog({
                                  mode: 'enter_pin',
                                  nodeId: source.node_id,
                                  nodeName: label,
                                  requestId: source.pair_request_id,
                                })
                                return
                              }
                              if (!source.trusted) {
                                const requestId = await onRequestPair(source.node_id)
                                if (requestId) {
                                  setPairDialogError('')
                                  setPairDialog({
                                    mode: 'waiting_approval',
                                    nodeId: source.node_id,
                                    nodeName: label,
                                    requestId,
                                  })
                                }
                                return
                              }
                              if (versionSyncRequired) {
                                if (!source.same_version_update_allowed) return
                                await onSyncPeerVersion(source.node_id)
                                return
                              }
                              if (disabled || source.active) return
                              await onFollowSource(source.node_id)
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
                {peerSources.length > 0 ? (
                  <button
                    type="button"
                    className={`aoConfigDiagPill${updateRequiredSources.length > 0 ? ' is-alert' : ''}`}
                    onClick={() => setDiagnosticsOpen(true)}
                  >
                    <span>LAN</span>
                    <span>{updateRequiredSources.length > 0 ? `${updateRequiredSources.length} issue${updateRequiredSources.length === 1 ? '' : 's'}` : 'healthy'}</span>
                  </button>
                ) : null}
              </div>
            ) : null}
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
                  {selectedConfigSource?.kind === 'peer' && selectedConfigSource.version_sync_required ? (
                    <div
                      className="aoHint aoHintWarning"
                      style={{ marginBottom: 10, color: 'rgba(145, 12, 43, 0.92)' }}
                    >
                      {selectedConfigSource.version_sync_reason}
                      {selectedConfigSource.same_version_update_blocked_reason
                        ? ` ${selectedConfigSource.same_version_update_blocked_reason}`
                        : ' Use Update required to sync this peer to the current machine build.'}
                    </div>
                  ) : null}
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
      {diagnosticsOpen ? (
        <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={() => setDiagnosticsOpen(false)}>
          <div
            className="aoModal"
            style={{ width: 'min(860px, calc(100vw - 40px))' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="aoModalHeader">
              <div>
                <div className="aoModalTitle">LAN / Sync Diagnostics</div>
                <div className="aoModalSub">
                  Per-peer pairing, build, and sync contract diagnostics. Use this when follow/update behavior looks wrong.
                </div>
              </div>
              <button className="aoBtn" onClick={() => setDiagnosticsOpen(false)}>
                Close
              </button>
            </div>
            <div className="aoModalBody" style={{ display: 'grid', gap: 12 }}>
              {peerSources.length === 0 ? (
                <div className="aoHint">No LAN peers detected.</div>
              ) : (
                peerSources.map((source) => {
                  const syncDomains = source.sync_blocked_domains?.map(syncDomainLabel).join(', ') || 'none'
                  const buildLabel = source.build_identity
                    ? `v${source.build_identity.app_version} · ${source.build_identity.build_git_short_sha}`
                    : 'unknown'
                  const pausedDomains = source.sync_blocked_domains?.map(syncDomainLabel) ?? []
                  const whyText = diagnosticsWhyText(source)
                  return (
                    <div key={source.node_id} className="aoCard aoConfigDiagCard">
                      <div className="aoConfigDiagCardHead">
                        <div className="aoConfigDiagPeerBlock">
                          <div className="aoConfigDiagPeerName">{source.node_name}</div>
                          <div className="aoConfigDiagPeerMeta">
                            <span>{compactPeerStateLabel(source)}</span>
                            <span>·</span>
                            <span>{source.build_matches_local ? 'Same build' : 'Different build'}</span>
                          </div>
                        </div>
                        <div className="aoConfigDiagBadgeRow">
                          <span className="aoConfigDiagBadge">
                            {compactFollowStatusLabel(source)}
                          </span>
                          <span
                            className={`aoConfigDiagBadge${
                              source.version_sync_required ? ' is-alert' : ''
                            }`}
                          >
                            {compactUpdateStatusLabel(source)}
                          </span>
                        </div>
                      </div>
                      <div className="aoConfigDiagBody">
                        <div className="aoConfigDiagSection">
                          <div className="aoConfigDiagSectionLabel">Build</div>
                          <div className="aoConfigDiagBuildValue">{buildLabel}</div>
                        </div>
                        {whyText ? (
                          <div className="aoConfigDiagSection">
                            <div className="aoConfigDiagSectionLabel">Why</div>
                            <div className="aoConfigDiagWhyText">{whyText}</div>
                          </div>
                        ) : null}
                        {pausedDomains.length > 0 ? (
                          <div className="aoConfigDiagSection">
                            <div className="aoConfigDiagSectionLabel">Paused</div>
                            <div className="aoConfigDiagPausedWrap">
                              {pausedDomains.length > 1 ? (
                                <div className="aoConfigDiagPausedList">
                                  {pausedDomains.map((domain) => (
                                    <div key={domain} className="aoConfigDiagPausedItem">
                                      {domain}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="aoConfigDiagPausedSingle">{syncDomains}</div>
                              )}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </ModalBackdrop>
      ) : null}
      {pairDialog ? (
        <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={() => setPairDialog(null)}>
          <div className="aoModal aoPairModal" onClick={(event) => event.stopPropagation()}>
            <div className="aoModalHeader">
              <div>
                <div className="aoModalTitle">
                  {pairDialog.mode === 'show_pin'
                    ? 'Pairing PIN'
                    : pairDialog.mode === 'paired'
                      ? 'Paired'
                      : pairDialog.mode === 'waiting_approval'
                        ? 'Waiting for Approval'
                      : 'Enter Pairing PIN'}
                </div>
                <div className="aoModalSub">
                  {pairDialog.mode === 'show_pin'
                    ? `Share this code with ${pairDialog.nodeName}.`
                    : pairDialog.mode === 'paired'
                      ? `${pairDialog.nodeName} is now trusted.`
                      : pairDialog.mode === 'waiting_approval'
                        ? `Waiting for ${pairDialog.nodeName} to approve this pairing request.`
                      : `Enter the 6-digit code shown on ${pairDialog.nodeName}.`}
                </div>
              </div>
            </div>
            <div className="aoModalBody aoPairModalBody">
              {pairDialog.mode === 'show_pin' ? (
                <div className="aoPairPinDisplay" aria-label="pairing pin">
                  {pairDialog.pinCode.padEnd(6, ' ').slice(0, 6).split('').map((char, index) => (
                    <span key={`${char}-${index}`} className="aoPairPinCell is-filled">
                      {char.trim() || ' '}
                    </span>
                  ))}
                </div>
              ) : pairDialog.mode === 'paired' ? (
                <div className="aoPairSuccessBadge" aria-label="pairing success">
                  Paired
                </div>
              ) : pairDialog.mode === 'waiting_approval' ? (
                <div className="aoPairWaitingState" aria-label="waiting for pairing approval">
                  <span className="aoPairWaitingSpinner" aria-hidden="true" />
                  <span>Waiting for approval on {pairDialog.nodeName}...</span>
                </div>
              ) : (
                <div className="aoPairEntryBlock">
                  <div className="aoPairPinInputWrap" aria-label="Pairing PIN input">
                    {Array.from({ length: 6 }).map((_, index) => (
                      <input
                        key={index}
                        ref={(node) => {
                          pairPinInputRefs.current[index] = node
                        }}
                        className="aoPairPinInput"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        value={pairPinDigits[index] ?? ''}
                        onChange={(event) => updatePairPinAt(index, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Backspace') {
                            if (pairPinDigits[index]) {
                              clearPairPinAt(index)
                              return
                            }
                            if (index > 0) {
                              clearPairPinAt(index - 1)
                              queueMicrotask(() => pairPinInputRefs.current[index - 1]?.focus())
                            }
                            return
                          }
                          if (event.key === 'ArrowLeft' && index > 0) {
                            event.preventDefault()
                            pairPinInputRefs.current[index - 1]?.focus()
                            return
                          }
                          if (event.key === 'ArrowRight' && index < 5) {
                            event.preventDefault()
                            pairPinInputRefs.current[index + 1]?.focus()
                            return
                          }
                          if (event.key === 'Enter' && normalizePinInput(pairPinDigits.join('')).length === 6) {
                            void submitPairPinFromDialog()
                          }
                        }}
                        onPaste={(event) => {
                          const pasted = normalizePinInput(event.clipboardData.getData('text'))
                          if (!pasted) return
                          event.preventDefault()
                          const nextDigits = emptyPairPinDigits()
                          for (let i = 0; i < pasted.length; i += 1) nextDigits[i] = pasted[i] ?? ''
                          setPairPinDigits(nextDigits)
                          const focusIndex = Math.min(Math.max(pasted.length - 1, 0), 5)
                          queueMicrotask(() => pairPinInputRefs.current[focusIndex]?.focus())
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
            {pairDialogError ? <div className="aoPairDialogError">{pairDialogError}</div> : null}
            <div className="aoModalActions">
              <button
                className="aoBtn"
                onClick={() => {
                  setPairDialog(null)
                  setPairPinDigits(emptyPairPinDigits())
                  setPairDialogError('')
                }}
              >
                {pairDialog.mode === 'paired' ? 'Done' : 'Close'}
              </button>
              {pairDialog.mode === 'enter_pin' ? (
                <button
                  className="aoBtn aoBtnPrimary"
                  disabled={normalizePinInput(pairPinDigits.join('')).length !== 6 || pairDialogBusy}
                  onClick={() => void submitPairPinFromDialog()}
                >
                  Confirm
                </button>
              ) : null}
            </div>
          </div>
        </ModalBackdrop>
      ) : null}
    </ModalBackdrop>
  )
}
