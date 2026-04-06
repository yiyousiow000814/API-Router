import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { ModalBackdrop } from './ModalBackdrop'
import type { Config, LanRemoteUpdateDebugResponse } from '../types'
import {
  isRemoteUpdateStatusCurrentForPending,
  remoteUpdateStatusObservedAtUnixMs,
  type RemoteUpdatePendingStage,
} from '../utils/remoteUpdateStatus'

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
  remoteUpdatePendingByNode: Record<string, RemoteUpdatePendingStage>
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

type ConfigSource = NonNullable<Config['config_source']>['sources'][number]
type BuildIdentity = NonNullable<ConfigSource['build_identity']>

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
  source: ConfigSource,
): string {
  if (source.trusted) return 'Trusted'
  if (source.pair_state === 'incoming_request') return 'Needs approval'
  if (source.pair_state === 'pin_required') return 'PIN required'
  if (source.pair_state === 'requested') return 'Pending'
  return 'Unpaired'
}

function compactFollowStatusLabel(
  source: ConfigSource,
): string {
  if (source.active) return 'Following'
  if (source.follow_allowed) return 'Ready to follow'
  if (!source.trusted) return 'Pair required'
  if ((source.sync_blocked_domains?.length ?? 0) > 0) return 'Blocked by sync contract'
  return 'Idle'
}

function compactUpdateStatusLabel(
  source: ConfigSource,
): string {
  if (!source.version_sync_required) return 'No update needed'
  return source.same_version_update_allowed ? 'Update available' : 'Update blocked'
}

export function syncPauseSummaryLabel(source: ConfigSource): string | null {
  const pausedCount = source.sync_blocked_domains?.length ?? 0
  if (pausedCount <= 1) return null
  return pausedCount === 2 ? '2 domains paused' : `${pausedCount} domains paused`
}

function remoteUpdateStateLabel(source: ConfigSource, localBuildSha?: string | null): string | null {
  if (!isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)) return null
  const state = source.remote_update_status?.state?.trim()
  const reasonCode = source.remote_update_status?.reason_code?.trim()
  if (!state) return null
  if (state === 'accepted') return 'Queued'
  if (state === 'running') return 'Updating'
  if (state === 'failed') return 'Update failed'
  if (state === 'succeeded') return 'Updated'
  if (state === 'superseded' && reasonCode === 'peer_build_changed_before_start') return 'Expired before start'
  if (state === 'superseded' && reasonCode === 'peer_build_changed_after_start') return 'Build changed'
  if (state === 'superseded') return 'Replaced'
  return state
}

function normalizedBuildSha(value: string | undefined | null): string {
  const normalized = value?.trim().toLowerCase() || ''
  if (!normalized || normalized === 'unknown') return ''
  return normalized
}

function normalizedTargetRef(value: string | undefined | null): string {
  return value?.trim().toLowerCase() || ''
}

function remoteUpdateTargetMatchesBuild(
  source: ConfigSource,
  buildSha: string | undefined | null,
): boolean | null {
  const normalizedBuild = normalizedBuildSha(buildSha)
  const targetRef = normalizedTargetRef(source.remote_update_status?.target_ref)
  if (!normalizedBuild || !targetRef) return null
  return normalizedBuild.startsWith(targetRef) || targetRef.startsWith(normalizedBuild)
}

export function isRemoteUpdateStatusRelevantToCurrentBuild(
  source: ConfigSource,
  localBuildSha?: string | null,
): boolean {
  const status = source.remote_update_status
  if (!status?.state?.trim()) return false
  const terminalState = ['failed', 'succeeded', 'superseded'].includes(status.state.trim())
  const targetMatchesPeerBuild = remoteUpdateTargetMatchesBuild(source, source.build_identity?.build_git_sha)
  const targetMatchesLocalBuild = remoteUpdateTargetMatchesBuild(source, localBuildSha)
  if (
    terminalState &&
    targetMatchesPeerBuild === false &&
    (localBuildSha ? targetMatchesLocalBuild === false : true)
  ) {
    return false
  }
  const buildCommitUnixMs = source.build_identity?.build_git_commit_unix_ms ?? null
  if (!Number.isFinite(buildCommitUnixMs) || !buildCommitUnixMs) return true
  const statusObservedAtUnixMs = remoteUpdateStatusObservedAtUnixMs(source)
  if (!statusObservedAtUnixMs) return true
  return statusObservedAtUnixMs >= buildCommitUnixMs
}

export function shouldShowDiagnosticsRemoteUpdateStatus(
  source: ConfigSource,
  localBuildSha?: string | null,
): boolean {
  if (!isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)) return false
  const state = source.remote_update_status?.state?.trim()
  if (!state) return false
  if (state !== 'superseded') return true
  return Boolean(source.version_sync_required)
}

function remoteUpdateProgressDetail(source: ConfigSource): string {
  return formatReadableCommitRefs(source.remote_update_status?.detail?.trim() || '')
}

function formatReadableCommitRefs(value: string): string {
  return value.replace(/\b[0-9a-f]{12,40}\b/gi, (match) => match.slice(0, 8))
}

function hasRemoteDebugDetails(
  debugError: string,
  debugReadinessReason: string,
  remoteUpdateDebug: LanRemoteUpdateDebugResponse | undefined,
  debugLogTail: string,
): boolean {
  return Boolean(
    debugError ||
      debugReadinessReason ||
      remoteUpdateDebug?.status_path ||
      remoteUpdateDebug?.log_path ||
      debugLogTail,
  )
}

function remoteDebugStatusRecordText(remoteUpdateDebug: LanRemoteUpdateDebugResponse): string {
  return remoteUpdateDebug.status_file_exists
    ? 'Remote status record available from peer'
    : 'Peer has not written a remote update status record yet'
}

function remoteDebugLogRecordText(remoteUpdateDebug: LanRemoteUpdateDebugResponse): string {
  if (remoteUpdateDebug.log_tail_source === 'timeline' && remoteUpdateDebug.log_tail?.trim()) {
    return 'Remote update log: synthesized from status timeline'
  }
  return remoteUpdateDebug.log_file_exists
    ? 'Remote update log: available'
    : 'No remote update log available from peer'
}

export function remoteUpdateDetailText(source: ConfigSource, localBuildSha?: string | null): string {
  if (!isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)) return ''
  const status = source.remote_update_status
  if (!status) return ''
  const requester = status.requester_node_name?.trim() || status.requester_node_id?.trim() || 'remote peer'
  const detail = remoteUpdateProgressDetail(source)
  if (status.state === 'accepted') {
    return detail || `Accepted update request from ${requester}.`
  }
  if (status.state === 'running') {
    return detail || `Running remote update requested by ${requester}.`
  }
  if (status.state === 'failed') {
    return detail || `Remote update requested by ${requester} failed.`
  }
  if (status.state === 'succeeded') {
    return detail || `Remote update to ${formatReadableCommitRefs(status.target_ref)} completed.`
  }
  if (status.state === 'superseded') {
    if (status.reason_code === 'peer_build_changed_before_start') {
      return detail || 'Queued remote update expired before the worker started.'
    }
    if (status.reason_code === 'peer_build_changed_after_start') {
      return detail || 'Peer build changed while the remote update was running.'
    }
    return detail || 'Previous remote update was replaced by a newer installed build.'
  }
  return detail
}

function remoteUpdateTimestampLabel(source: ConfigSource, localBuildSha?: string | null): string {
  if (!isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)) return ''
  const status = source.remote_update_status
  if (!status) return ''
  const unixMs =
    status.finished_at_unix_ms ??
    status.started_at_unix_ms ??
    status.updated_at_unix_ms ??
    status.accepted_at_unix_ms
  return formatCommitDate(unixMs ?? null)
}

function remoteUpdateTimelineEntries(source: ConfigSource, localBuildSha?: string | null) {
  if (!isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)) return []
  return [...(source.remote_update_status?.timeline ?? [])]
    .filter((entry) => (entry.label?.trim() || entry.detail?.trim() || entry.phase?.trim()))
    .sort((a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0))
}

function pendingRemoteUpdateStateLabel(pendingStage: RemoteUpdatePendingStage | undefined): string | null {
  if (!pendingStage) return null
  if (pendingStage.stage === 'requesting') return 'Sending'
  if (pendingStage.stage === 'refreshing') return 'Waiting'
  return 'Remote update pending'
}

function pendingRemoteUpdateDetailText(pendingStage: RemoteUpdatePendingStage | undefined): string {
  if (!pendingStage) return ''
  return formatReadableCommitRefs(pendingStage.detail?.trim() || '')
}

function pendingRemoteUpdateTimestampLabel(pendingStage: RemoteUpdatePendingStage | undefined): string {
  if (!pendingStage?.startedAtUnixMs) return ''
  return formatCommitDate(pendingStage.startedAtUnixMs)
}

function pendingRemoteUpdateTimelineEntries(pendingStage: RemoteUpdatePendingStage | undefined) {
  if (!pendingStage) return []
  return [
    {
      unix_ms: pendingStage.startedAtUnixMs,
      label:
        pendingStage.stage === 'requesting'
          ? 'Request sent from current machine'
          : 'Peer accepted request; waiting for remote progress',
      detail: pendingStage.detail?.trim() || '',
      phase: pendingStage.stage,
    },
  ]
}

export function diagnosticsRemoteUpdateDisplay(
  source: ConfigSource,
  pendingStage: RemoteUpdatePendingStage | undefined,
  localBuildSha?: string | null,
): {
  label: string | null
  detail: string
  time: string
  timeline: Array<{ unix_ms?: number | null; label?: string | null; detail?: string | null; phase?: string | null }>
} {
  const remoteStatusCurrentForPending = isRemoteUpdateStatusCurrentForPending(source, pendingStage)
  const showPendingRemoteUpdate =
    Boolean(pendingStage) &&
    (!shouldShowDiagnosticsRemoteUpdateStatus(source, localBuildSha) || !remoteStatusCurrentForPending)
  if (showPendingRemoteUpdate) {
    return {
      label: pendingRemoteUpdateStateLabel(pendingStage),
      detail: pendingRemoteUpdateDetailText(pendingStage),
      time: pendingRemoteUpdateTimestampLabel(pendingStage),
      timeline: pendingRemoteUpdateTimelineEntries(pendingStage),
    }
  }
  return {
    label: shouldShowDiagnosticsRemoteUpdateStatus(source, localBuildSha)
      ? remoteUpdateStateLabel(source, localBuildSha)
      : null,
    detail: remoteUpdateDetailText(source, localBuildSha),
    time: remoteUpdateTimestampLabel(source, localBuildSha),
    timeline: remoteUpdateTimelineEntries(source, localBuildSha),
  }
}

function remoteUpdateMenuDetailText(source: ConfigSource, localBuildSha?: string | null): string {
  if (!isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)) return 'Sync to this build'
  const status = source.remote_update_status
  if (!status) return 'Sync to this build'
  const state = status.state?.trim()
  const reasonCode = status.reason_code?.trim()
  if (state === 'accepted') return 'Queued remote update'
  if (state === 'running') return 'Remote update in progress'
  if (state === 'failed') return 'Last remote update failed'
  if (state === 'succeeded') return 'Peer matches this build'
  if (state === 'superseded' && reasonCode === 'peer_build_changed_before_start') {
    return 'Queued update expired before the worker started'
  }
  if (state === 'superseded' && reasonCode === 'peer_build_changed_after_start') {
    return 'Peer changed build while the update was running'
  }
  if (state === 'superseded') return 'Previous remote update was replaced'
  return 'Sync to this build'
}

function remoteUpdateIndicatesIssue(source: ConfigSource, localBuildSha?: string | null): boolean {
  if (!isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)) return false
  const state = source.remote_update_status?.state?.trim()
  return state === 'failed' || state === 'superseded'
}

export function remoteUpdateActionState(
  source: ConfigSource,
  pendingStage: RemoteUpdatePendingStage | undefined,
  localBuildSha?: string | null,
): {
  actionLabel: string
  actionDetail: string | null
  spinning: boolean
} {
  const remoteState = isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)
    ? source.remote_update_status?.state?.trim()
    : ''
  const remoteStatusCurrentForPending = isRemoteUpdateStatusCurrentForPending(source, pendingStage)
  if (pendingStage?.stage === 'requesting') {
    return {
      actionLabel: 'Sending...',
      actionDetail: pendingStage.detail || 'Waiting for peer to accept',
      spinning: true,
    }
  }
  if (pendingStage?.stage === 'refreshing' && (!remoteState || !remoteStatusCurrentForPending)) {
    return {
      actionLabel: 'Queued',
      actionDetail: pendingStage.detail || 'Peer accepted update request',
      spinning: true,
    }
  }
  if (remoteState === 'accepted') {
    return {
      actionLabel: 'Queued',
      actionDetail: remoteUpdateProgressDetail(source) || 'Peer accepted update request',
      spinning: true,
    }
  }
  if (remoteState === 'running') {
    return {
      actionLabel: 'Updating',
      actionDetail: remoteUpdateProgressDetail(source) || 'Peer is applying this build',
      spinning: true,
    }
  }
  if (remoteState === 'failed') {
    return {
      actionLabel: source.same_version_update_allowed ? 'Retry update' : 'Update blocked',
      actionDetail: remoteUpdateProgressDetail(source) || 'Last remote update failed',
      spinning: false,
    }
  }
  if (remoteState === 'succeeded') {
    return {
      actionLabel: 'Updated',
      actionDetail: 'Peer matches this build',
      spinning: false,
    }
  }
  if (remoteState === 'superseded') {
    const issueLabel = remoteUpdateStateLabel(source, localBuildSha)
    return {
      actionLabel: issueLabel || (source.same_version_update_allowed ? 'Update issue' : 'Update blocked'),
      actionDetail: remoteUpdateMenuDetailText(source, localBuildSha),
      spinning: false,
    }
  }
  return {
    actionLabel: source.same_version_update_allowed ? 'Update peer' : 'Update blocked',
    actionDetail: 'Sync to this build',
    spinning: false,
  }
}

export function remoteUpdateMenuActionLabel(
  source: ConfigSource,
  pendingStage: RemoteUpdatePendingStage | undefined,
  localBuildSha?: string | null,
): string {
  const remoteStateLabel = remoteUpdateStateLabel(source, localBuildSha)
  if (remoteStateLabel) return remoteStateLabel
  const actionState = remoteUpdateActionState(source, pendingStage, localBuildSha)
  return actionState.actionLabel
}

export function shouldShowRemoteUpdateMenuDetail(
  source: ConfigSource,
  actionState: { actionDetail: string | null; spinning: boolean } | null,
  localBuildSha?: string | null,
): boolean {
  if (!actionState?.actionDetail?.trim()) return false
  if (actionState.spinning) return true
  const remoteState = isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)
    ? source.remote_update_status?.state?.trim()
    : ''
  return remoteState === 'failed' || remoteState === 'superseded'
}

export function keepSourceMenuOpenAfterAction(source: ConfigSource): boolean {
  return source.kind === 'peer' && Boolean(source.version_sync_required)
}

export function formatBuildLabel(buildIdentity: BuildIdentity): string {
  const version = buildIdentity?.app_version?.trim() || 'unknown'
  const sha = buildIdentity?.build_git_short_sha?.trim() || 'unknown'
  return `v${version} · ${sha}`
}

export function formatCommitDate(unixMs?: number | null): string {
  if (!Number.isFinite(unixMs) || !unixMs) return 'Unknown'
  const date = new Date(unixMs)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absOffsetMinutes = Math.abs(offsetMinutes)
  const offsetHours = String(Math.floor(absOffsetMinutes / 60)).padStart(2, '0')
  const offsetRemainderMinutes = String(absOffsetMinutes % 60).padStart(2, '0')
  return `${day}-${month}-${year} ${hours}:${minutes} UTC${sign}${offsetHours}:${offsetRemainderMinutes}`
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
  localBuildSha?: string | null,
): string {
  if (source.build_matches_local && !source.version_sync_required) {
    return ''
  }
  if (isRemoteUpdateStatusRelevantToCurrentBuild(source, localBuildSha)) {
    return ''
  }
  if (source.version_sync_required) {
    const updateBlockedReason = source.same_version_update_blocked_reason?.trim()
    if (updateBlockedReason && !source.same_version_update_allowed) {
      return updateBlockedReason
    }
    const versionReason = source.version_sync_reason?.trim()
    if (versionReason && !isGenericVersionSyncReason(versionReason)) return versionReason
  } else {
    if (source.active && source.trusted) {
      return ''
    }
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
  remoteUpdatePendingByNode,
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
  const [remoteUpdateDebugByNode, setRemoteUpdateDebugByNode] = useState<Record<string, LanRemoteUpdateDebugResponse>>({})
  const [remoteUpdateDebugLoadingByNode, setRemoteUpdateDebugLoadingByNode] = useState<Record<string, boolean>>({})
  const [remoteUpdateDebugErrorByNode, setRemoteUpdateDebugErrorByNode] = useState<Record<string, string>>({})
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
  const localSource = configSources.find((source) => source.kind === 'local') ?? null
  const localBuildSha = localSource?.build_identity?.build_git_sha ?? null
  const issueSources = configSources.filter(
    (source) =>
      source.kind === 'peer' &&
      (((source.sync_blocked_domains?.length ?? 0) > 0) ||
        (source.version_sync_required && !source.same_version_update_allowed) ||
        remoteUpdateIndicatesIssue(source, localBuildSha)),
  )
  const peerSources = configSources.filter((source) => source.kind === 'peer')
  const peerDebugNodeIds = peerSources.map((source) => source.node_id).join('|')

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

  useEffect(() => {
    if (!diagnosticsOpen || peerSources.length === 0) return
    let cancelled = false
    const loadDebug = async (nodeId: string) => {
      setRemoteUpdateDebugLoadingByNode((prev) => ({ ...prev, [nodeId]: true }))
      try {
        const payload = await invoke<LanRemoteUpdateDebugResponse>('fetch_lan_peer_remote_update_debug', { nodeId })
        if (cancelled) return
        setRemoteUpdateDebugByNode((prev) => ({ ...prev, [nodeId]: payload }))
        setRemoteUpdateDebugErrorByNode((prev) => {
          const next = { ...prev }
          delete next[nodeId]
          return next
        })
      } catch (error) {
        if (cancelled) return
        setRemoteUpdateDebugErrorByNode((prev) => ({ ...prev, [nodeId]: String(error) }))
      } finally {
        if (cancelled) return
        setRemoteUpdateDebugLoadingByNode((prev) => {
          const next = { ...prev }
          delete next[nodeId]
          return next
        })
      }
    }
    const refreshAll = () => {
      peerSources.forEach((source) => {
        void loadDebug(source.node_id)
      })
    }
    refreshAll()
    const timer = window.setInterval(refreshAll, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [diagnosticsOpen, peerDebugNodeIds])

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
                        const versionSyncPendingStage =
                          source.kind === 'peer' ? remoteUpdatePendingByNode[source.node_id] : undefined
                        const versionSyncActionState =
                          versionSyncRequired && source.kind === 'peer'
                            ? remoteUpdateActionState(source, versionSyncPendingStage, localBuildSha)
                            : null
                        const versionSyncPending = Boolean(versionSyncActionState?.spinning)
                        const pairActionAvailable =
                          source.kind === 'peer' &&
                          (!source.trusted ||
                            (source.trusted && source.follow_allowed && !source.active))
                        const disabled =
                          (source.kind === 'peer' && !pairActionAvailable && !versionSyncActionAvailable) ||
                          versionSyncPending
                        const actionLabel =
                          source.kind === 'local'
                            ? source.active
                              ? 'Current'
                              : 'Use local'
                            : versionSyncRequired
                              ? remoteUpdateMenuActionLabel(source, versionSyncPendingStage, localBuildSha)
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
                              if (!keepSourceMenuOpenAfterAction(source)) {
                                setSourceMenuOpen(false)
                              }
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
                                if (versionSyncPending || !source.same_version_update_allowed) return
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
                            </span>
                            <span className="aoConfigSourceMenuMetaBlock">
                              <span className="aoConfigSourceMenuMeta">
                                {versionSyncPending ? (
                                  <span className="aoConfigSourceMenuSpinnerWrap" aria-hidden="true">
                                    <span className="aoPairWaitingSpinner aoConfigSourceMenuSpinner" />
                                  </span>
                                ) : null}
                                {actionLabel}
                              </span>
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
                    className={`aoConfigDiagPill${issueSources.length > 0 ? ' is-alert' : ''}`}
                    onClick={() => setDiagnosticsOpen(true)}
                  >
                    <span>LAN</span>
                    <span>{issueSources.length > 0 ? `${issueSources.length} issue${issueSources.length === 1 ? '' : 's'}` : 'healthy'}</span>
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
                        : ' Choose Update peer in Config source to sync this peer to the current machine build.'}
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
            className="aoModal aoConfigDiagnosticsModal"
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
            <div className="aoModalBody aoConfigDiagnosticsModalBody">
              {peerSources.length === 0 ? (
                <div className="aoHint">No LAN peers detected.</div>
              ) : (
                <>
                  {(() => {
                    const localRemoteUpdateStatusLabel =
                      localSource && shouldShowDiagnosticsRemoteUpdateStatus(localSource, localBuildSha)
                        ? remoteUpdateStateLabel(localSource, localBuildSha)
                        : null
                    const localRemoteUpdateDetail = localSource
                      ? remoteUpdateDetailText(localSource, localBuildSha)
                      : ''
                    const localRemoteUpdateTime = localSource
                      ? remoteUpdateTimestampLabel(localSource, localBuildSha)
                      : ''
                    return (
                  <div className="aoCard aoConfigDiagLocalCard">
                    <div className="aoConfigDiagLocalHead">
                      <div className="aoConfigDiagPeerBlock">
                        <div className="aoConfigDiagPeerName">Current machine</div>
                        <div className="aoConfigDiagPeerMeta">
                          <span>{localSource?.node_name ?? 'Local'}</span>
                          <span>·</span>
                          <span>Reference build for peer comparisons</span>
                        </div>
                      </div>
                    </div>
                    <div className="aoConfigDiagBody">
                      <div className="aoConfigDiagSection">
                        <div className="aoConfigDiagSectionLabel">Build</div>
                        <div className="aoConfigDiagBuildValue">
                          {localSource?.build_identity ? formatBuildLabel(localSource.build_identity) : 'Unknown'}
                        </div>
                      </div>
                      <div className="aoConfigDiagSection">
                        <div className="aoConfigDiagSectionLabel">Commit</div>
                        <div className="aoConfigDiagCompareValue">
                          {formatCommitDate(localSource?.build_identity?.build_git_commit_unix_ms ?? null)}
                        </div>
                      </div>
                      {localRemoteUpdateStatusLabel ? (
                        <div className="aoConfigDiagSection">
                          <div className="aoConfigDiagSectionLabel">Update</div>
                          <div className="aoConfigDiagRemoteUpdateBlock">
                            <div className="aoConfigDiagRemoteUpdateState">{localRemoteUpdateStatusLabel}</div>
                            {localRemoteUpdateDetail ? (
                              <div className="aoConfigDiagRemoteUpdateDetail">{localRemoteUpdateDetail}</div>
                            ) : null}
                            {localRemoteUpdateTime && localRemoteUpdateTime !== 'Unknown' ? (
                              <div className="aoConfigDiagRemoteUpdateTime">{localRemoteUpdateTime}</div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                    )
                  })()}
                  {peerSources.map((source) => {
                    const pausedDomains = source.sync_blocked_domains?.map(syncDomainLabel) ?? []
                    const pausedSummary = syncPauseSummaryLabel(source)
                    const whyText = diagnosticsWhyText(source, localBuildSha)
                    const pendingStage = remoteUpdatePendingByNode[source.node_id]
                    const remoteUpdateDisplay = diagnosticsRemoteUpdateDisplay(
                      source,
                      pendingStage,
                      localBuildSha,
                    )
                    const peerBuildLabel = source.build_identity
                      ? formatBuildLabel(source.build_identity)
                      : 'Unknown'
                    const peerCommitLabel = formatCommitDate(
                      source.build_identity?.build_git_commit_unix_ms ?? null,
                    )
                    const remoteUpdateStatusLabel = remoteUpdateDisplay.label
                    const remoteUpdateDetail = remoteUpdateDisplay.detail
                    const remoteUpdateTime = remoteUpdateDisplay.time
                    const remoteUpdateTimeline = remoteUpdateDisplay.timeline
                    const remoteUpdateDebug = remoteUpdateDebugByNode[source.node_id]
                    const remoteUpdateDebugLoading = Boolean(remoteUpdateDebugLoadingByNode[source.node_id])
                    const remoteUpdateDebugError = remoteUpdateDebugErrorByNode[source.node_id] ?? ''
                    const debugReadinessReason =
                      formatReadableCommitRefs(
                        remoteUpdateDebug?.remote_update_readiness.blocked_reason?.trim() ?? '',
                      )
                    const debugLogTail = remoteUpdateDebug?.log_tail?.trim() ?? ''
                    const formattedDebugError = formatReadableCommitRefs(remoteUpdateDebugError)
                    const formattedWhyText = formatReadableCommitRefs(whyText)
                    const showDebugReadinessReason =
                      Boolean(debugReadinessReason) && debugReadinessReason !== formattedWhyText
                    const showDebugSection =
                      remoteUpdateDebugLoading ||
                      hasRemoteDebugDetails(
                        formattedDebugError,
                        showDebugReadinessReason ? debugReadinessReason : '',
                        remoteUpdateDebug,
                        debugLogTail,
                      )
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
                            {pausedSummary ? (
                              <span className="aoConfigDiagBadge">{pausedSummary}</span>
                            ) : null}
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
                            <div className="aoConfigDiagBuildValue">{peerBuildLabel}</div>
                          </div>
                          <div className="aoConfigDiagSection">
                            <div className="aoConfigDiagSectionLabel">Commit</div>
                            <div className="aoConfigDiagCompareValue">{peerCommitLabel}</div>
                          </div>
                          <div className="aoConfigDiagSection">
                            <div className="aoConfigDiagSectionLabel">Local</div>
                            <div className="aoConfigDiagCompareValue">
                              {source.build_matches_local
                                ? 'Matches current machine build'
                                : 'Does not match current machine build'}
                            </div>
                          </div>
                          {remoteUpdateStatusLabel ? (
                            <div className="aoConfigDiagSection">
                              <div className="aoConfigDiagSectionLabel">Update</div>
                              <div className="aoConfigDiagRemoteUpdateBlock">
                                <div className="aoConfigDiagRemoteUpdateState">{remoteUpdateStatusLabel}</div>
                                {remoteUpdateDetail ? (
                                  <div className="aoConfigDiagRemoteUpdateDetail">{remoteUpdateDetail}</div>
                                ) : null}
                                {remoteUpdateTime && remoteUpdateTime !== 'Unknown' ? (
                                  <div className="aoConfigDiagRemoteUpdateTime">{remoteUpdateTime}</div>
                                ) : null}
                                {source.remote_update_status?.request_id ? (
                                  <div className="aoConfigDiagRemoteUpdateDetail">
                                    Request: {source.remote_update_status.request_id}
                                  </div>
                                ) : null}
                                {remoteUpdateTimeline.length > 0 ? (
                                  <div
                                    style={{
                                      display: 'grid',
                                      gap: 6,
                                      marginTop: 8,
                                      paddingTop: 8,
                                      borderTop: '1px solid rgba(10, 16, 28, 0.08)',
                                    }}
                                  >
                                    {remoteUpdateTimeline.map((entry, index) => (
                                      <div key={`${entry.phase ?? 'phase'}-${entry.unix_ms ?? index}-${index}`}>
                                        <div className="aoConfigDiagRemoteUpdateDetail">
                                          {formatCommitDate(entry.unix_ms ?? null)} · {entry.label?.trim() || entry.phase?.trim() || 'Step'}
                                        </div>
                                        {entry.detail?.trim() ? (
                                          <div className="aoConfigDiagWhyText">{formatReadableCommitRefs(entry.detail.trim())}</div>
                                        ) : null}
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                          {showDebugSection ? (
                            <div className="aoConfigDiagSection">
                              <div className="aoConfigDiagSectionLabel">Debug</div>
                              <div className="aoConfigDiagRemoteUpdateBlock">
                                {remoteUpdateDebugLoading && !remoteUpdateDebug && !remoteUpdateDebugError ? (
                                  <div className="aoConfigDiagRemoteUpdateDetail">Checking peer remote update state...</div>
                                ) : null}
                                {formattedDebugError ? (
                                  <div className="aoConfigDiagWhyText">{formattedDebugError}</div>
                                ) : null}
                                {remoteUpdateDebug ? (
                                  <>
                                    {showDebugReadinessReason ? (
                                      <div className="aoConfigDiagRemoteUpdateDetail">{debugReadinessReason}</div>
                                    ) : null}
                                    <div className="aoConfigDiagRemoteUpdateDetail">
                                      {remoteDebugStatusRecordText(remoteUpdateDebug)}
                                    </div>
                                    <div className="aoConfigDiagRemoteUpdateDetail">
                                      {remoteDebugLogRecordText(remoteUpdateDebug)}
                                    </div>
                                    {debugLogTail ? (
                                      <pre
                                        className="aoConfigDiagWhyText"
                                        style={{
                                          margin: '8px 0 0',
                                          padding: '10px 12px',
                                          whiteSpace: 'pre-wrap',
                                          overflowWrap: 'anywhere',
                                          background: 'rgba(10, 16, 28, 0.04)',
                                          borderRadius: 10,
                                        }}
                                      >
                                        {debugLogTail}
                                      </pre>
                                    ) : null}
                                  </>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                          {whyText ? (
                            <div className="aoConfigDiagSection">
                              <div className="aoConfigDiagSectionLabel">Why</div>
                              <div className="aoConfigDiagWhyText">{formattedWhyText}</div>
                            </div>
                          ) : null}
                          {pausedDomains.length > 0 ? (
                            <div className="aoConfigDiagSection">
                              <div className="aoConfigDiagSectionLabel">Paused</div>
                              <div className="aoConfigDiagPausedWrap">
                                <div className="aoConfigDiagPausedList">
                                  {pausedDomains.map((domain) => (
                                    <div key={domain} className="aoConfigDiagPausedItem">
                                      {domain}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </>
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
