import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  compactUpdateStatusLabel,
  remoteUpdateMenuActionLabel,
  diagnosticVersionEntries,
  diagnosticVersionRows,
  diagnosticsRemoteUpdateDisplay,
  ConfigModal,
  diagnosticsWhyText,
  effectiveRemoteUpdateStatus,
  formatBuildLabel,
  formatCommitDate,
  isRemoteUpdateStatusRelevantToCurrentBuild,
  isRemoteDebugStatusRelevantToCurrentBuild,
  keepSourceMenuOpenAfterAction,
  remoteUpdateDebugPollNodeIds,
  remoteDebugStatusRelevance,
  remoteUpdateActionState,
  remoteUpdateDetailText,
  remoteUpdateRollbackConfirmationText,
  remoteUpdateRollbackActionAvailable,
  remoteDebugReadinessReasonText,
  remoteDebugPeerReachabilityDiagnosisText,
  remoteDebugStartupDiagnosisText,
  splitRemoteDebugLogTail,
  shouldShowDiagnosticsRemoteUpdateStatus,
  shouldShowRemoteUpdateMenuDetail,
  syncPauseSummaryLabel,
  withEffectiveRemoteUpdateStatus,
} from './ConfigModal'
import {
  isRemoteUpdateStatusCurrentForPending,
  remoteUpdateStatusObservedAtUnixMs,
} from '../utils/remoteUpdateStatus'
import type { Config, LanRemoteUpdateDebugResponse } from '../types'

function buildConfig(): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: 'p1',
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 3,
      cooldown_seconds: 20,
      request_timeout_seconds: 60,
    },
    providers: {
      p1: {
        display_name: 'Provider 1',
        base_url: 'https://example.com/v1',
        has_key: false,
      },
    },
    provider_order: ['p1'],
    config_source: {
      mode: 'local',
      followed_node_id: null,
      sources: [
        {
          kind: 'local',
          node_id: 'node-local',
          node_name: 'Desk',
          active: true,
          follow_allowed: false,
          follow_blocked_reason: null,
          using_count: 1,
          version_sync_required: false,
          version_sync_reason: null,
          same_version_update_allowed: true,
          same_version_update_blocked_reason: null,
        },
      ],
    },
  }
}

describe('ConfigModal', () => {
  it('polls pending peer debug targets before scanning all online peers', () => {
    expect(remoteUpdateDebugPollNodeIds(['node-a', 'node-b'], ['node-b'])).toEqual(['node-b'])
    expect(remoteUpdateDebugPollNodeIds(['node-a', 'node-b'], [])).toEqual(['node-a', 'node-b'])
    expect(remoteUpdateDebugPollNodeIds(['node-a', 'node-a', ''], [' ', 'node-b', 'node-b'])).toEqual([
      'node-b',
    ])
  })

  it('combines capability and contract versions into one diagnostics list', () => {
    expect(
      diagnosticVersionEntries({
        capabilities: ['heartbeat_v1', 'status_v1', 'remote_update_v2'],
        sync_contracts: {
          usage_history: 4,
          usage_requests: 2,
          shared_health: 1,
        },
      }),
    ).toEqual([
      'heartbeat_v1',
      'status_v1',
      'remote_update_v2',
      'shared_health_v1',
      'usage_history_v4',
      'usage_requests_v2',
    ])
  })

  it('marks peer contract mismatches in diagnostic version rows', () => {
    expect(
      diagnosticVersionRows(
        {
          version_inventory: ['heartbeat_v1', 'usage_history_v1'],
          sync_contracts: { usage_history: 1 },
        },
        {
          version_inventory: ['heartbeat_v1', 'usage_history_v4'],
          sync_contracts: { usage_history: 4 },
        },
      ),
    ).toEqual([
      expect.objectContaining({
        feature: 'usage_history',
        localVersion: 4,
        version: 1,
        status: 'mismatch',
      }),
      expect.objectContaining({
        feature: 'heartbeat',
        localVersion: 1,
        version: 1,
        status: 'match',
      }),
    ])
  })

  it('marks peer-only version entries as peer_only', () => {
    expect(
      diagnosticVersionRows(
        {
          version_inventory: ['heartbeat_v1', 'usage_history_v4', 'shared_health_v1'],
          sync_contracts: { usage_history: 4, shared_health: 1 },
        },
        {
          version_inventory: ['heartbeat_v1', 'usage_history_v4'],
          sync_contracts: { usage_history: 4 },
        },
      ),
    ).toEqual([
      expect.objectContaining({
        feature: 'shared_health',
        localVersion: undefined,
        peerVersion: 1,
        version: 1,
        status: 'peer_only',
      }),
      expect.objectContaining({
        feature: 'heartbeat',
        localVersion: 1,
        peerVersion: 1,
        version: 1,
        status: 'match',
      }),
      expect.objectContaining({
        feature: 'usage_history',
        localVersion: 4,
        peerVersion: 4,
        version: 4,
        status: 'match',
      }),
    ])
  })

  it('marks local-only version entries when the peer lacks a local feature', () => {
    expect(
      diagnosticVersionRows(
        {
          version_inventory: ['heartbeat_v1'],
          sync_contracts: {},
        },
        {
          version_inventory: ['heartbeat_v1', 'usage_history_v4'],
          sync_contracts: { usage_history: 4 },
        },
      ),
    ).toEqual([
      expect.objectContaining({
        feature: 'usage_history',
        localVersion: 4,
        peerVersion: undefined,
        version: 4,
        status: 'local_only',
      }),
      expect.objectContaining({
        feature: 'heartbeat',
        localVersion: 1,
        peerVersion: 1,
        version: 1,
        status: 'match',
      }),
    ])
  })

  it('sanitizes debug log tail noise and ansi fragments', () => {
    const { recent, older } = splitRemoteDebugLogTail(
      [
        '[36mvite v7.3.1 [32mbuilding client environment for production...',
        '210 modules transformed.',
        '+ Write-Error $_',
        '+ ~~~~~~~~~~~~~~',
        'error during build: EPERM: operation not permitted, rename dist/assets/app.js',
      ].join('\n'),
    )

    expect(older).toBe('')
    expect(recent).toBe('error during build: EPERM: operation not permitted, rename dist/assets/app.js')
  })

  it('renders provider name, base url, and key inputs for add provider', () => {
    const html = renderToStaticMarkup(
      <ConfigModal
        open
        config={buildConfig()}
        newProviderName=""
        newProviderBaseUrl=""
        newProviderKey=""
        newProviderKeyStorage="auth_json"
        nextProviderPlaceholder="provider1"
        setNewProviderName={() => undefined}
        setNewProviderBaseUrl={() => undefined}
        setNewProviderKey={() => undefined}
        setNewProviderKeyStorage={() => undefined}
        onAddProvider={() => undefined}
        onFollowSource={() => undefined}
        onClearFollowSource={() => undefined}
        onRequestPair={() => undefined}
        onApprovePair={() => undefined}
        onSubmitPairPin={() => undefined}
        onSyncPeerVersion={() => undefined}
        onRollbackPeerVersion={() => undefined}
        remoteUpdatePendingByNode={{}}
        onOpenGroupManager={() => undefined}
        onClose={() => undefined}
        providerListRef={{ current: null }}
        orderedConfigProviders={['p1']}
        dragPreviewOrder={null}
        draggingProvider={null}
        dragCardHeight={0}
        renderProviderCard={() => null}
      />,
    )

    expect(html).toContain('Config')
    expect(html).toContain('provider1')
    expect(html).toContain('Base URL (e.g. https://api.openai.com/v1)')
    expect(html).toContain('placeholder="Key"')
  })

  it('keeps drag placeholder height aligned with the measured drag card height', () => {
    const html = renderToStaticMarkup(
      <ConfigModal
        open
        config={buildConfig()}
        newProviderName=""
        newProviderBaseUrl=""
        newProviderKey=""
        newProviderKeyStorage="auth_json"
        nextProviderPlaceholder="provider1"
        setNewProviderName={() => undefined}
        setNewProviderBaseUrl={() => undefined}
        setNewProviderKey={() => undefined}
        setNewProviderKeyStorage={() => undefined}
        onAddProvider={() => undefined}
        onFollowSource={() => undefined}
        onClearFollowSource={() => undefined}
        onRequestPair={() => undefined}
        onApprovePair={() => undefined}
        onSubmitPairPin={() => undefined}
        onSyncPeerVersion={() => undefined}
        onRollbackPeerVersion={() => undefined}
        remoteUpdatePendingByNode={{}}
        onOpenGroupManager={() => undefined}
        onClose={() => undefined}
        providerListRef={{ current: null }}
        orderedConfigProviders={['p1']}
        dragPreviewOrder={['p1']}
        draggingProvider="p1"
        dragCardHeight={50}
        renderProviderCard={() => null}
      />,
    )

    expect(html).toContain('height:50px')
    expect(html).toContain('min-height:50px')
  })

  it('shows selected source usage count in the trigger', () => {
    const config = buildConfig()
    config.config_source = {
      mode: 'local',
      followed_node_id: null,
      sources: [
        {
          kind: 'local',
          node_id: 'node-local',
          node_name: 'Desk',
          active: true,
          follow_allowed: false,
          follow_blocked_reason: null,
          using_count: 1,
          version_sync_required: false,
          version_sync_reason: null,
          same_version_update_allowed: true,
          same_version_update_blocked_reason: null,
        },
        {
          kind: 'peer',
          node_id: 'node-b',
          node_name: 'Desk B',
          active: false,
          follow_allowed: true,
          follow_blocked_reason: null,
          using_count: 2,
          version_sync_required: false,
          version_sync_reason: null,
          same_version_update_allowed: true,
          same_version_update_blocked_reason: null,
        },
      ],
    }

    const html = renderToStaticMarkup(
      <ConfigModal
        open
        config={config}
        newProviderName=""
        newProviderBaseUrl=""
        newProviderKey=""
        newProviderKeyStorage="auth_json"
        nextProviderPlaceholder="provider1"
        setNewProviderName={() => undefined}
        setNewProviderBaseUrl={() => undefined}
        setNewProviderKey={() => undefined}
        setNewProviderKeyStorage={() => undefined}
        onAddProvider={() => undefined}
        onFollowSource={() => undefined}
        onClearFollowSource={() => undefined}
        onRequestPair={() => undefined}
        onApprovePair={() => undefined}
        onSubmitPairPin={() => undefined}
        onSyncPeerVersion={() => undefined}
        onRollbackPeerVersion={() => undefined}
        remoteUpdatePendingByNode={{}}
        onOpenGroupManager={() => undefined}
        onClose={() => undefined}
        providerListRef={{ current: null }}
        orderedConfigProviders={['p1']}
        dragPreviewOrder={null}
        draggingProvider={null}
        dragCardHeight={0}
        renderProviderCard={() => null}
      />,
    )

    expect(html).toContain('1 using')
  })

  it('shows update available warning copy for peer version mismatch', () => {
    const config = buildConfig()
    config.config_source = {
      mode: 'follow',
      followed_node_id: 'node-b',
      sources: [
        {
          kind: 'local',
          node_id: 'node-local',
          node_name: 'Desk',
          active: false,
          follow_allowed: false,
          follow_blocked_reason: null,
          using_count: 0,
          version_sync_required: false,
          version_sync_reason: null,
          same_version_update_allowed: true,
          same_version_update_blocked_reason: null,
        },
        {
          kind: 'peer',
          node_id: 'node-b',
          node_name: 'Desk B',
          active: true,
          trusted: true,
          follow_allowed: false,
          follow_blocked_reason: null,
          using_count: 1,
          version_sync_required: true,
          version_sync_reason: 'Desk B is on a different build. Remote update can sync it to the current machine build if needed.',
          same_version_update_allowed: true,
          same_version_update_blocked_reason: null,
        },
      ],
    }

    const html = renderToStaticMarkup(
      <ConfigModal
        open
        config={config}
        newProviderName=""
        newProviderBaseUrl=""
        newProviderKey=""
        newProviderKeyStorage="auth_json"
        nextProviderPlaceholder="provider1"
        setNewProviderName={() => undefined}
        setNewProviderBaseUrl={() => undefined}
        setNewProviderKey={() => undefined}
        setNewProviderKeyStorage={() => undefined}
        onAddProvider={() => undefined}
        onFollowSource={() => undefined}
        onClearFollowSource={() => undefined}
        onRequestPair={() => undefined}
        onApprovePair={() => undefined}
        onSubmitPairPin={() => undefined}
        onSyncPeerVersion={() => undefined}
        onRollbackPeerVersion={() => undefined}
        remoteUpdatePendingByNode={{}}
        onOpenGroupManager={() => undefined}
        onClose={() => undefined}
        providerListRef={{ current: null }}
        orderedConfigProviders={['p1']}
        dragPreviewOrder={null}
        draggingProvider={null}
        dragCardHeight={0}
        renderProviderCard={() => null}
      />,
    )

    expect(html).toContain('Desk B is on a different build. Remote update can sync it to the current machine build if needed.')
    expect(html).toContain('Choose Update peer in Config source to sync this peer to the current machine build.')
  })

  it('keeps config source peer rows single-line even while remote update is building', () => {
    const config = buildConfig()
    config.config_source = {
      mode: 'follow',
      followed_node_id: 'node-b',
      sources: [
        {
          kind: 'local',
          node_id: 'node-local',
          node_name: 'Desk',
          active: false,
          follow_allowed: false,
          follow_blocked_reason: null,
          using_count: 0,
          version_sync_required: false,
          version_sync_reason: null,
          same_version_update_allowed: true,
          same_version_update_blocked_reason: null,
        },
        {
          kind: 'peer',
          node_id: 'node-b',
          node_name: 'Desk B',
          active: true,
          trusted: true,
          follow_allowed: false,
          follow_blocked_reason: null,
          using_count: 1,
          version_sync_required: true,
          version_sync_reason: 'Desk B requires update.',
          same_version_update_allowed: true,
          same_version_update_blocked_reason: null,
          remote_update_status: {
            state: 'running',
            target_ref: 'abc123',
            detail: 'Building release binary: Running npm run tauri -- build --no-bundle',
            started_at_unix_ms: 1775312828000,
          },
        },
      ],
    }

    const html = renderToStaticMarkup(
      <ConfigModal
        open
        config={config}
        newProviderName=""
        newProviderBaseUrl=""
        newProviderKey=""
        newProviderKeyStorage="auth_json"
        nextProviderPlaceholder="provider1"
        setNewProviderName={() => undefined}
        setNewProviderBaseUrl={() => undefined}
        setNewProviderKey={() => undefined}
        setNewProviderKeyStorage={() => undefined}
        onAddProvider={() => undefined}
        onFollowSource={() => undefined}
        onClearFollowSource={() => undefined}
        onRequestPair={() => undefined}
        onApprovePair={() => undefined}
        onSubmitPairPin={() => undefined}
        onSyncPeerVersion={() => undefined}
        onRollbackPeerVersion={() => undefined}
        remoteUpdatePendingByNode={{}}
        onOpenGroupManager={() => undefined}
        onClose={() => undefined}
        providerListRef={{ current: null }}
        orderedConfigProviders={['p1']}
        dragPreviewOrder={null}
        draggingProvider={null}
        dragCardHeight={0}
        renderProviderCard={() => null}
      />,
    )

    expect(html).toContain('Desk B')
    expect(html).not.toContain('aoConfigSourceMenuSub')
    expect(html).not.toContain('Building release binary: Running npm run tauri -- build --no-bundle')
  })

  it('prefers concrete diagnostics why text over generic paused copy', () => {
    const whyText = diagnosticsWhyText({
      kind: 'peer',
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      follow_blocked_reason: null,
      using_count: 0,
      version_sync_required: true,
      version_sync_reason: 'Sync paused until both devices run compatible builds.',
      same_version_update_allowed: false,
      same_version_update_blocked_reason:
        "This machine's git worktree is dirty. Commit or stash local changes there before remote update can run.",
      sync_blocked_domains: ['provider_definitions', 'usage_history', 'usage_requests'],
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'abc',
        build_git_short_sha: 'abc',
        build_git_commit_unix_ms: 1775312828000,
      },
      build_matches_local: false,
    })

    expect(whyText).toBe(
      "This machine's git worktree is dirty. Commit or stash local changes there before remote update can run.",
    )
  })

  it('hides why text for healthy active followed peers', () => {
    const whyText = diagnosticsWhyText({
      kind: 'peer',
      node_id: 'node-b',
      node_name: 'SYB',
      active: true,
      trusted: true,
      follow_allowed: false,
      follow_blocked_reason: 'that node is already following this local node',
      using_count: 1,
      version_sync_required: false,
      version_sync_reason: null,
      same_version_update_allowed: false,
      same_version_update_blocked_reason: null,
      sync_blocked_domains: [],
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'abc',
        build_git_short_sha: 'abc',
        build_git_commit_unix_ms: 1775312828000,
      },
      build_matches_local: true,
    })

    expect(whyText).toBe('')
  })

  it('shows sending stage while peer remote update request is still local pending', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
    }

    const pendingState = {
      stage: 'requesting' as const,
      detail: 'Sending update request to peer',
      startedAtUnixMs: 1775312828000,
    }

    expect(remoteUpdateActionState(source, pendingState)).toEqual({
      actionLabel: 'Sending...',
      actionDetail: 'Sending update request to peer',
      spinning: true,
    })
    expect(
      shouldShowRemoteUpdateMenuDetail(source, remoteUpdateActionState(source, pendingState)),
    ).toBe(true)
  })

  it('shows queued stage while peer has accepted the remote update request', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'accepted',
        target_ref: 'abc123',
        detail: 'Queued remote self-update worker',
        accepted_at_unix_ms: 1775312828000,
      },
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Queued',
      actionDetail: 'Queued remote self-update worker',
      spinning: true,
    })
    expect(
      shouldShowRemoteUpdateMenuDetail(source, remoteUpdateActionState(source, undefined)),
    ).toBe(true)
  })

  it('keeps local queued animation when only an older remote update status is available', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'superseded',
        reason_code: 'peer_build_changed_before_start',
        target_ref: 'older-target',
        detail: 'Queued remote update to older-target never started.',
        finished_at_unix_ms: 1775312828000,
      },
    }
    const pendingState = {
      stage: 'refreshing' as const,
      detail: 'Peer accepted request. Refreshing remote progress',
      startedAtUnixMs: 1775312830000,
    }

    expect(isRemoteUpdateStatusCurrentForPending(source, pendingState)).toBe(false)
    expect(remoteUpdateActionState(source, pendingState)).toEqual({
      actionLabel: 'Queued',
      actionDetail: 'Peer accepted request. Refreshing remote progress',
      spinning: true,
    })
  })

  it('uses the newest remote update timestamp when comparing pending progress freshness', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'running',
        target_ref: 'abc123',
        accepted_at_unix_ms: 1775312827000,
        started_at_unix_ms: 1775312829000,
        updated_at_unix_ms: 1775312831000,
      },
    }

    expect(remoteUpdateStatusObservedAtUnixMs(source)).toBe(1775312831000)
    expect(
      isRemoteUpdateStatusCurrentForPending(source, {
        stage: 'refreshing',
        detail: 'Peer accepted request. Refreshing remote progress',
        startedAtUnixMs: 1775312830000,
      }),
    ).toBe(true)
  })

  it('keeps the source menu open for peer update actions only', () => {
    expect(
      keepSourceMenuOpenAfterAction({
        kind: 'peer',
        node_id: 'node-b',
        node_name: 'Desk B',
        active: false,
        trusted: true,
        follow_allowed: false,
        follow_blocked_reason: null,
        using_count: 1,
        version_sync_required: true,
        version_sync_reason: 'Desk B requires update.',
        same_version_update_allowed: true,
        same_version_update_blocked_reason: null,
      }),
    ).toBe(true)

    expect(
      keepSourceMenuOpenAfterAction({
        kind: 'peer',
        node_id: 'node-c',
        node_name: 'Desk C',
        active: false,
        trusted: true,
        follow_allowed: true,
        follow_blocked_reason: null,
        using_count: 0,
        version_sync_required: false,
        version_sync_reason: null,
        same_version_update_allowed: false,
        same_version_update_blocked_reason: null,
      }),
    ).toBe(false)

    expect(
      keepSourceMenuOpenAfterAction({
        kind: 'local',
        node_id: 'node-local',
        node_name: 'Local',
        active: true,
        follow_allowed: false,
        follow_blocked_reason: null,
        using_count: 1,
        version_sync_required: false,
        version_sync_reason: null,
        same_version_update_allowed: false,
        same_version_update_blocked_reason: null,
      }),
    ).toBe(false)
  })

  it('prefers fresher remote debug status for action and diagnostics progress', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'accepted',
        target_ref: 'abc12345',
        detail: 'Queued remote self-update worker',
        accepted_at_unix_ms: 1775312828000,
        updated_at_unix_ms: 1775312828000,
        timeline: [
          {
            unix_ms: 1775312828000,
            phase: 'request_accepted',
            label: 'Peer accepted request',
            detail: 'Queued remote self-update worker',
            source: 'launcher',
            state: 'accepted',
          },
        ],
      },
    }
    const remoteUpdateDebug: LanRemoteUpdateDebugResponse = {
      ok: true,
      version: 1,
      node_id: 'node-b',
      node_name: 'Desk B',
      remote_update_readiness: {
        ready: true,
        blocked_reason: null,
        checked_at_unix_ms: 1775312827000,
      },
      remote_update_status: {
        state: 'running',
        target_ref: 'abc12345',
        detail: 'Running build:root-exe',
        accepted_at_unix_ms: 1775312828000,
        started_at_unix_ms: 1775312829000,
        updated_at_unix_ms: 1775312831000,
        finished_at_unix_ms: null,
        request_id: 'req-1',
        reason_code: null,
        requester_node_id: 'node-a',
        requester_node_name: 'Desk A',
        worker_script: null,
        timeline: [
          {
            unix_ms: 1775312828000,
            phase: 'request_accepted',
            label: 'Peer accepted request',
            detail: 'Queued remote self-update worker',
            source: 'launcher',
            state: 'accepted',
          },
          {
            unix_ms: 1775312829000,
            phase: 'worker_started',
            label: 'Worker started',
            detail: 'Bootstrapping remote self-update worker.',
            source: 'worker',
            state: 'running',
          },
          {
            unix_ms: 1775312831000,
            phase: 'build_exe',
            label: 'Building release executable',
            detail: 'Running build:root-exe',
            source: 'worker',
            state: 'running',
          },
        ],
      },
      status_path: 'C:\\status.json',
      status_file_exists: true,
      log_path: 'C:\\log.txt',
      log_file_exists: true,
      log_tail_source: 'timeline',
      log_tail: 'Running build:root-exe',
      worker_bootstrap_observed: true,
      worker_script_probe: null,
      local_build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'abc12345ffff',
        build_git_short_sha: 'abc12345',
        build_git_commit_unix_ms: 1775312800000,
      },
      local_version_sync: {
        git_worktree_clean: true,
        update_to_local_build_allowed: true,
        blocked_reason: null,
      },
    }

    expect(effectiveRemoteUpdateStatus(source, remoteUpdateDebug)?.state).toBe('running')

    const effectiveSource = withEffectiveRemoteUpdateStatus(source, remoteUpdateDebug)

    expect(remoteUpdateActionState(effectiveSource, undefined, 'abc12345ffff')).toEqual({
      actionLabel: 'Building',
      actionDetail: 'Running build:root-exe',
      spinning: true,
    })
    expect(diagnosticsRemoteUpdateDisplay(effectiveSource, undefined, 'abc12345ffff').label).toBe('Building')
  })

  it('shows concrete running step details while peer update is executing', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'running',
        target_ref: 'abc123',
        detail: 'Building release binary: Compiling release EXE',
        started_at_unix_ms: 1775312828000,
        timeline: [
          {
            unix_ms: 1775312829000,
            phase: 'build_release_binary',
            label: 'Building release binary',
            detail: 'Building release binary: Compiling release EXE',
          },
        ],
      },
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Building',
      actionDetail: 'Building release binary: Compiling release EXE',
      spinning: true,
    })
  })

  it('shows concrete failure step details after a remote update error', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'failed',
        target_ref: 'abc123',
        detail: 'Fetching from origin: git fetch failed',
        finished_at_unix_ms: 1775312828000,
      },
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Update failed',
      actionDetail: 'Fetching from origin: git fetch failed',
      spinning: false,
    })
    expect(
      shouldShowRemoteUpdateMenuDetail(source, remoteUpdateActionState(source, undefined)),
    ).toBe(true)
  })

  it('keeps failed remote updates labeled as failed even when a new update is currently blocked', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: false,
      same_version_update_blocked_reason: 'Local build is not ready for another remote update.',
      remote_update_status: {
        state: 'failed',
        target_ref: 'abc123',
        detail: 'Building EXE: build-root-exe.ps1 failed',
        finished_at_unix_ms: 1775312828000,
      },
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Update failed',
      actionDetail: 'Building EXE: build-root-exe.ps1 failed',
      spinning: false,
    })
  })

  it('sanitizes noisy remote update failure output into a readable summary', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'failed',
        target_ref: 'abc123',
        detail:
          'Building EXE: tools/build/build-root-exe.ps1 failed. Output: dist/assets/App.js 10 kB | gzip: 2 kB | At C:\\repo\\tools\\build\\build-root-exe.ps1:328 char:3 | CategoryInfo: NotSpecified: (:) [Write-Error], WriteErrorException',
        finished_at_unix_ms: 1775312828000,
        timeline: [
          {
            unix_ms: 1775312828000,
            phase: 'failed',
            label: 'Building EXE failed',
            detail:
              'Building EXE: tools/build/build-root-exe.ps1 failed. Output: dist/assets/App.js 10 kB | gzip: 2 kB | FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException',
          },
        ],
      },
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Update failed',
      actionDetail: 'Building EXE: tools/build/build-root-exe.ps1 failed',
      spinning: false,
    })
    expect(remoteUpdateDetailText(source)).toBe('Building EXE: tools/build/build-root-exe.ps1 failed')
    expect(diagnosticsRemoteUpdateDisplay(source, undefined).timeline).toEqual([
      expect.objectContaining({
        detail: 'Building EXE: tools/build/build-root-exe.ps1 failed',
      }),
    ])
  })

  it('shows live update progress instead of blocked while a remote update is running', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: false,
      same_version_update_blocked_reason: 'Another update cannot be queued right now.',
      remote_update_status: {
        state: 'running',
        target_ref: 'abc12345',
        detail: 'Preparing worker: Starting remote self-update worker.',
        started_at_unix_ms: 1775312828000,
        timeline: [
          {
            unix_ms: 1775312829000,
            phase: 'worker_started',
            label: 'Worker started',
            detail: 'Preparing worker: Starting remote self-update worker.',
            source: 'worker',
            state: 'running',
          },
        ],
      },
    }

    expect(compactUpdateStatusLabel(source, 'abc12345ffff')).toBe('Preparing')
  })

  it('keeps succeeded remote updates in updated state until version sync flags catch up', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'succeeded',
        target_ref: 'abc123',
        detail: 'Completed: Remote self-update completed successfully.',
        finished_at_unix_ms: 1775312828000,
      },
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Updated',
      actionDetail: 'Peer matches this build',
      spinning: false,
    })
  })

  it('shows expired-before-start stage after a queued update never launched', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'superseded',
        reason_code: 'peer_build_changed_before_start',
        target_ref: '9910964e24802d327b1500a69f2d4471fb7ac647',
        detail: 'Queued remote update to 9910964e never started before the peer build changed.',
        finished_at_unix_ms: 1775312828000,
      },
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Expired before start',
      actionDetail: 'Queued update expired before the worker started',
      spinning: false,
    })
    expect(
      shouldShowRemoteUpdateMenuDetail(source, remoteUpdateActionState(source, undefined)),
    ).toBe(true)
    expect(remoteUpdateDetailText(source)).toBe(
      'Queued remote update to 9910964e never started before the peer build changed.',
    )
  })

  it('avoids claiming a conflicting current build in expired-before-start details', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'superseded',
        reason_code: 'peer_build_changed_before_start',
        target_ref: '9910964e24802d327b1500a69f2d4471fb7ac647',
        detail: 'Queued remote update to 9910964e never started before the peer build changed.',
        finished_at_unix_ms: 1775312828000,
      },
    }

    expect(remoteUpdateDetailText(source)).not.toContain('currently on build')
  })

  it('hides stale superseded diagnostics once the peer no longer needs an update', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: false,
      version_sync_reason: null,
      build_matches_local: true,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'superseded',
        reason_code: 'peer_build_changed_after_start',
        target_ref: '9910964e24802d327b1500a69f2d4471fb7ac647',
        detail: 'Queued remote update to 9910964e stopped after the peer changed to build ce542b7.',
        finished_at_unix_ms: 1775312828000,
      },
    }

    expect(shouldShowDiagnosticsRemoteUpdateStatus(source)).toBe(false)
  })

  it('keeps superseded diagnostics visible while a peer still needs an update', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      build_matches_local: false,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'superseded',
        reason_code: 'peer_build_changed_after_start',
        target_ref: '9910964e24802d327b1500a69f2d4471fb7ac647',
        detail: 'Queued remote update to 9910964e stopped after the peer changed to build ce542b7.',
        finished_at_unix_ms: 1775312828000,
      },
    }

    expect(shouldShowDiagnosticsRemoteUpdateStatus(source)).toBe(true)
  })

  it('hides remote update diagnostics when the status record is older than the current peer build', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: '4731214fc6e75c3dda5a409045c02be55fdfb01d',
        build_git_short_sha: '4731214f',
        build_git_commit_unix_ms: 1775450940000,
      },
      remote_update_status: {
        state: 'superseded',
        reason_code: 'peer_build_changed_before_start',
        target_ref: 'db1d2529',
        detail: 'Queued remote update to db1d2529 never started; peer is currently on build e53479d1.',
        finished_at_unix_ms: 1775435700000,
      },
    }

    expect(isRemoteUpdateStatusRelevantToCurrentBuild(source)).toBe(false)
    expect(shouldShowDiagnosticsRemoteUpdateStatus(source)).toBe(false)
    expect(remoteUpdateDetailText(source)).toBe('')
    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Update peer',
      actionDetail: 'Sync to this build',
      spinning: false,
    })
    expect(
      shouldShowRemoteUpdateMenuDetail(source, remoteUpdateActionState(source, undefined)),
    ).toBe(false)
  })

  it('shows diagnostics why text again once the only remote update status is stale', () => {
    const whyText = diagnosticsWhyText({
      kind: 'peer',
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      follow_blocked_reason: null,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: '4731214fc6e75c3dda5a409045c02be55fdfb01d',
        build_git_short_sha: '4731214f',
        build_git_commit_unix_ms: 1775450940000,
      },
      remote_update_status: {
        state: 'superseded',
        reason_code: 'peer_build_changed_before_start',
        target_ref: 'db1d2529',
        detail: 'Queued remote update to db1d2529 never started; peer is currently on build e53479d1.',
        finished_at_unix_ms: 1775435700000,
      },
      build_matches_local: false,
    })

    expect(whyText).toBe('Desk B requires update.')
  })

  it('hides failed remote update diagnostics once the peer is already on a different newer build', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: '368ce27fbbb47a851d0f89588085539465954111',
        build_git_short_sha: '368ce27f',
        build_git_commit_unix_ms: 1775477100000,
      },
      remote_update_status: {
        state: 'failed',
        reason_code: 'worker_exited_early',
        target_ref: '25e785b0',
        detail: 'Remote update worker PID 117016 exited without recording completion for target 25e785b0.',
        finished_at_unix_ms: 1775477340000,
      },
    }

    expect(isRemoteUpdateStatusRelevantToCurrentBuild(source)).toBe(false)
    expect(shouldShowDiagnosticsRemoteUpdateStatus(source)).toBe(false)
    expect(remoteUpdateDetailText(source)).toBe('')
    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Update peer',
      actionDetail: 'Sync to this build',
      spinning: false,
    })
  })

  it('keeps the latest failed remote update visible when it matches the current machine build target', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: '368ce27fbbb47a851d0f89588085539465954111',
        build_git_short_sha: '368ce27f',
        build_git_commit_unix_ms: 1775477100000,
      },
      remote_update_status: {
        state: 'failed',
        reason_code: 'worker_exited_early',
        target_ref: 'dfa0f229',
        detail: 'Remote update worker PID 112248 exited without recording completion for target dfa0f229.',
        finished_at_unix_ms: 1775480352000,
        timeline: [
          {
            unix_ms: 1775480352000,
            label: 'Remote update worker exited early',
            detail: 'Remote update worker PID 112248 exited without recording completion for target dfa0f229.',
            phase: 'worker_exit',
          },
        ],
      },
    }

    expect(isRemoteUpdateStatusRelevantToCurrentBuild(source, 'dfa0f229abcdef')).toBe(true)
    expect(shouldShowDiagnosticsRemoteUpdateStatus(source, 'dfa0f229abcdef')).toBe(true)
    expect(remoteUpdateDetailText(source, 'dfa0f229abcdef')).toContain('target dfa0f229')
    expect(remoteUpdateActionState(source, undefined, 'dfa0f229abcdef')).toEqual({
      actionLabel: 'Update failed',
      actionDetail: 'Remote update worker PID 112248 exited without recording completion for target dfa0f229.',
      spinning: false,
    })
  })

  it('hides failed remote update diagnostics once the peer already matches the current build', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: false,
      version_sync_reason: null,
      build_matches_local: true,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9',
        build_git_short_sha: 'ce1b5920',
        build_git_commit_unix_ms: 1775499120000,
      },
      remote_update_status: {
        state: 'failed',
        reason_code: 'worker_never_bootstrapped',
        target_ref: 'ce1b5920',
        detail: 'Remote update worker PID 107844 exited before bootstrap for target ce1b5920 with code 0.',
        finished_at_unix_ms: 1775499340000,
      },
    }

    expect(isRemoteUpdateStatusRelevantToCurrentBuild(source, 'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9')).toBe(false)
    expect(shouldShowDiagnosticsRemoteUpdateStatus(source, 'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9')).toBe(false)
    expect(remoteUpdateDetailText(source, 'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9')).toBe('')
  })

  it('hides terminal remote update diagnostics when the target only matches the peer history but not the current machine build', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      build_matches_local: false,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9',
        build_git_short_sha: 'ce1b5920',
        build_git_commit_unix_ms: 1775499120000,
      },
      remote_update_status: {
        state: 'failed',
        reason_code: 'worker_never_bootstrapped',
        target_ref: 'ce1b5920',
        detail: 'Remote update worker PID 107844 exited before bootstrap for target ce1b5920 with code 0.',
        finished_at_unix_ms: 1775499340000,
      },
    }

    expect(isRemoteUpdateStatusRelevantToCurrentBuild(source, '781c07b0abcdef1234567890')).toBe(false)
    expect(shouldShowDiagnosticsRemoteUpdateStatus(source, '781c07b0abcdef1234567890')).toBe(false)
    expect(remoteUpdateDetailText(source, '781c07b0abcdef1234567890')).toBe('')
  })

  it('treats remote debug logs for an older target as stale for the current build', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: false,
      version_sync_reason: null,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: '4731214fabcd12344343fae28a8e4280bb760d99',
        build_git_short_sha: '4731214f',
        build_git_commit_unix_ms: 1775482000000,
      },
    }

    const remoteUpdateDebug = {
      ok: true,
      version: 1,
      node_id: 'node-b',
      node_name: 'Desk B',
      remote_update_readiness: {
        ready: true,
      },
      remote_update_status: {
        state: 'failed',
        target_ref: '56159561',
        finished_at_unix_ms: 1775477266179,
      },
      status_file_exists: true,
      log_file_exists: true,
      local_build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'dfa0f229abcdef1234567890',
        build_git_short_sha: 'dfa0f229',
        build_git_commit_unix_ms: 1775482000000,
      },
      local_version_sync: {
        target_ref: 'dfa0f229abcdef1234567890',
        git_worktree_clean: true,
        update_to_local_build_allowed: true,
      },
    } as const

    expect(isRemoteDebugStatusRelevantToCurrentBuild(source, remoteUpdateDebug)).toBe(false)
  })

  it('treats terminal remote debug logs as stale once the peer already matches the current build', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: false,
      version_sync_reason: null,
      build_matches_local: true,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9',
        build_git_short_sha: 'ce1b5920',
        build_git_commit_unix_ms: 1775499120000,
      },
    }

    const remoteUpdateDebug = {
      ok: true,
      version: 1,
      node_id: 'node-b',
      node_name: 'Desk B',
      remote_update_readiness: {
        ready: true,
      },
      remote_update_status: {
        state: 'failed',
        target_ref: 'ce1b5920',
        finished_at_unix_ms: 1775499340000,
      },
      status_file_exists: true,
      log_file_exists: true,
      local_build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9',
        build_git_short_sha: 'ce1b5920',
        build_git_commit_unix_ms: 1775499120000,
      },
      local_version_sync: {
        target_ref: 'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9',
        git_worktree_clean: true,
        update_to_local_build_allowed: true,
      },
    } as const

    expect(
      isRemoteDebugStatusRelevantToCurrentBuild(
        source,
        remoteUpdateDebug,
        'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9',
      ),
    ).toBe(false)
  })

  it('treats terminal remote debug logs as stale when they only match the peer history and not the current machine build', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      build_matches_local: false,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'ce1b5920b25646c3940e5ca7bb2fc79cdd6151a9',
        build_git_short_sha: 'ce1b5920',
        build_git_commit_unix_ms: 1775499120000,
      },
    }

    const remoteUpdateDebug = {
      ok: true,
      version: 1,
      node_id: 'node-b',
      node_name: 'Desk B',
      remote_update_readiness: {
        ready: true,
      },
      remote_update_status: {
        state: 'failed',
        target_ref: 'ce1b5920',
        finished_at_unix_ms: 1775499340000,
      },
      status_file_exists: true,
      log_file_exists: true,
      local_build_identity: {
        app_version: '0.4.0',
        build_git_sha: '781c07b0abcdef1234567890',
        build_git_short_sha: '781c07b0',
        build_git_commit_unix_ms: 1775500680000,
      },
      local_version_sync: {
        target_ref: '781c07b0abcdef1234567890',
        git_worktree_clean: true,
        update_to_local_build_allowed: true,
      },
    } as const

    expect(
      isRemoteDebugStatusRelevantToCurrentBuild(
        source,
        remoteUpdateDebug,
        '781c07b0abcdef1234567890',
      ),
    ).toBe(false)
    expect(
      remoteDebugStatusRelevance(
        source,
        remoteUpdateDebug,
        '781c07b0abcdef1234567890',
      ).reason,
    ).toContain('does not match current build')
  })

  it('treats debug logs without a usable remote update status as previous instead of current', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      build_matches_local: false,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: '2f211f11abcdef1234567890',
        build_git_short_sha: '2f211f11',
        build_git_commit_unix_ms: 1775505060000,
      },
    }

    const remoteUpdateDebug = {
      ok: true,
      version: 1,
      node_id: 'node-b',
      node_name: 'Desk B',
      remote_update_readiness: {
        ready: true,
      },
      remote_update_status: undefined,
      status_file_exists: true,
      log_file_exists: true,
      log_tail_source: 'file',
      log_tail: 'Queued remote update to 2f211f11 was replaced.',
      local_build_identity: {
        app_version: '0.4.0',
        build_git_sha: '2f211f11abcdef1234567890',
        build_git_short_sha: '2f211f11',
        build_git_commit_unix_ms: 1775505060000,
      },
      local_version_sync: {
        target_ref: 'e5ae2003abcdef1234567890',
        git_worktree_clean: true,
        update_to_local_build_allowed: true,
      },
    } as const

    expect(
      isRemoteDebugStatusRelevantToCurrentBuild(
        source,
        remoteUpdateDebug,
        'e5ae2003abcdef1234567890',
      ),
    ).toBe(false)
    expect(
      remoteDebugStatusRelevance(
        source,
        remoteUpdateDebug,
        'e5ae2003abcdef1234567890',
      ).reason,
    ).toContain('did not return a structured remote update status')
  })

  it('keeps diagnostics render-safe when remote debug readiness is missing', () => {
    expect(
      remoteDebugReadinessReasonText({
        ok: true,
        version: 1,
        node_id: 'node-b',
        node_name: 'Desk B',
        remote_update_readiness: undefined as unknown as never,
        status_file_exists: false,
        log_file_exists: false,
        local_build_identity: {
          app_version: '0.4.0',
          build_git_sha: 'dfa0f229abcdef1234567890',
          build_git_short_sha: 'dfa0f229',
          build_git_commit_unix_ms: 1775482000000,
        },
        local_version_sync: {
          target_ref: 'dfa0f229abcdef1234567890',
          git_worktree_clean: true,
          update_to_local_build_allowed: true,
        },
      }),
    ).toBe('')
  })

  it('keeps remote debug summary render-safe before payload arrives', () => {
    expect(remoteDebugReadinessReasonText(undefined)).toBe('')
  })

  it('explains when peer app is missing but the updater is still reachable', () => {
    expect(
      remoteDebugPeerReachabilityDiagnosisText({
        ok: true,
        version: 1,
        node_id: 'node-b',
        node_name: 'Desk B',
        remote_update_readiness: {
          ready: false,
          blocked_reason: 'Peer app debug is unavailable',
        },
        status_file_exists: false,
        log_file_exists: false,
        transport: {
          app_base_url: 'http://192.168.1.10:4000',
          app_debug_state: 'request_error',
          app_debug_detail: 'connection refused',
          updater_base_url: 'http://192.168.1.10:4001',
          updater_state: 'ok',
          updater_detail: 'updater responded',
        },
        updater_status: {
          ok: true,
          busy: false,
        },
        local_build_identity: {
          app_version: '0.4.0',
          build_git_sha: 'dfa0f229abcdef1234567890',
          build_git_short_sha: 'dfa0f229',
          build_git_commit_unix_ms: 1775482000000,
        },
        local_version_sync: {
          target_ref: 'dfa0f229abcdef1234567890',
          git_worktree_clean: true,
          update_to_local_build_allowed: true,
        },
      }),
    ).toBe(
      'Peer app is not responding at http://192.168.1.10:4000 (request_error: connection refused), but the updater is reachable at http://192.168.1.10:4001. This is a runtime restart/rollback state, not a LAN peer-missing state.',
    )
  })

  it('explains when both peer app and updater are unavailable', () => {
    expect(
      remoteDebugPeerReachabilityDiagnosisText({
        ok: true,
        version: 1,
        node_id: 'node-b',
        node_name: 'Desk B',
        remote_update_readiness: {
          ready: false,
        },
        status_file_exists: false,
        log_file_exists: false,
        transport: {
          app_base_url: 'http://192.168.1.10:4000',
          app_debug_state: 'request_error',
          app_debug_detail: 'timed out',
          updater_base_url: 'http://192.168.1.10:4001',
          updater_state: 'request_error',
          updater_detail: 'timed out',
        },
        local_build_identity: {
          app_version: '0.4.0',
          build_git_sha: 'dfa0f229abcdef1234567890',
          build_git_short_sha: 'dfa0f229',
          build_git_commit_unix_ms: 1775482000000,
        },
        local_version_sync: {
          target_ref: 'dfa0f229abcdef1234567890',
          git_worktree_clean: true,
          update_to_local_build_allowed: true,
        },
      }),
    ).toBe(
      'Peer app and updater are both unreachable. That points to a LAN/offline/firewall state, or a remote process crash before the updater could answer.',
    )
  })

  it('diagnoses startup stalls from remote update app startup diagnostics', () => {
    expect(
      remoteDebugStartupDiagnosisText({
        ok: true,
        version: 1,
        node_id: 'node-b',
        node_name: 'Desk B',
        remote_update_readiness: {
          ready: true,
        },
        status_file_exists: true,
        log_file_exists: true,
        app_startup_tail: [
          '{"stage": "build_state_start"}',
          '{"stage": "build_state_load_config_start"}',
          '{"stage": "build_state_load_config_ok"}',
          '{"stage": "build_state_secret_store_start"}',
          '{"stage": "build_state_secret_store_ok"}',
          '{"stage": "build_state_open_store_start"}',
        ].join('\n'),
        local_build_identity: {
          app_version: '0.4.0',
          build_git_sha: 'dfa0f229abcdef1234567890',
          build_git_short_sha: 'dfa0f229',
          build_git_commit_unix_ms: 1775482000000,
        },
        local_version_sync: {
          target_ref: 'dfa0f229abcdef1234567890',
          git_worktree_clean: true,
          update_to_local_build_allowed: true,
        },
      }),
    ).toContain('opening the local store')
  })

  it('keeps idle update rows visually quiet', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Update peer',
      actionDetail: 'Sync to this build',
      spinning: false,
    })
    expect(
      shouldShowRemoteUpdateMenuDetail(source, remoteUpdateActionState(source, undefined)),
    ).toBe(false)
  })

  it('exposes rollback as the peer action when the rollback slot is available', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      build_matches_local: true,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'bad1234567890',
        build_git_short_sha: 'bad12345',
        build_git_commit_unix_ms: 1775312827000,
      },
      version_sync_required: false,
      version_sync_reason: null,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'succeeded',
        target_ref: 'bad1234567890',
        from_git_sha: 'good1234567890',
        to_git_sha: 'bad1234567890',
        current_git_sha: 'bad1234567890',
        previous_git_sha: 'good1234567890',
        rollback_available: true,
        finished_at_unix_ms: 1775312829000,
        updated_at_unix_ms: 1775312829000,
      },
    }

    const actionState = remoteUpdateActionState(source, undefined, 'bad1234567890')
    expect(remoteUpdateRollbackActionAvailable(source)).toBe(true)
    expect(actionState).toEqual({
      actionLabel: 'Rollback peer',
      actionDetail: 'Restore previous build good1234',
      spinning: false,
    })
    expect(remoteUpdateMenuActionLabel(source, undefined, 'bad1234567890')).toBe('Rollback peer')
    expect(shouldShowRemoteUpdateMenuDetail(source, actionState, 'bad1234567890')).toBe(true)
  })

  it('keeps rollback available after the local machine moves past the bad peer build', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      build_matches_local: false,
      build_identity: {
        app_version: '0.4.0',
        build_git_sha: 'bad1234567890',
        build_git_short_sha: 'bad12345',
        build_git_commit_unix_ms: 1775312827000,
      },
      version_sync_required: true,
      version_sync_reason: 'Desk B is on a bad build.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'succeeded',
        target_ref: 'bad1234567890',
        from_git_sha: 'good1234567890',
        to_git_sha: 'bad1234567890',
        current_git_sha: 'bad1234567890',
        previous_git_sha: 'good1234567890',
        rollback_available: true,
        finished_at_unix_ms: 1775312829000,
        updated_at_unix_ms: 1775312829000,
      },
    }

    expect(remoteUpdateRollbackActionAvailable(source)).toBe(true)
    expect(remoteUpdateMenuActionLabel(source, undefined, 'fix9999999999')).toBe('Rollback peer')
    expect(remoteUpdateRollbackConfirmationText(source)).toBe(
      'Rollback Desk B to previous build good1234? This will replace and restart API Router on that peer.',
    )
  })

  it('keeps offline peers from showing the normal update action without rollback', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      online: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
    }

    expect(remoteUpdateRollbackActionAvailable(source)).toBe(false)
    expect(remoteUpdateMenuActionLabel(source, undefined, 'abc123')).toBe('Offline')
  })

  it('allows rollback for a pending remote update after the peer goes offline', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      online: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: false,
      same_version_update_blocked_reason: 'that node is currently offline',
      remote_update_status: null,
    }
    const pendingStage = {
      stage: 'refreshing' as const,
      detail: 'Peer accepted request. Refreshing remote progress',
      startedAtUnixMs: 1775312829000,
    }

    const actionState = remoteUpdateActionState(source, pendingStage, 'abc123')
    expect(remoteUpdateRollbackActionAvailable(source, pendingStage)).toBe(true)
    expect(actionState).toEqual({
      actionLabel: 'Rollback peer',
      actionDetail: 'Restore previous build',
      spinning: false,
    })
    expect(remoteUpdateMenuActionLabel(source, pendingStage, 'abc123')).toBe('Rollback peer')
  })

  it('shows terminal superseded state in dropdown after a superseded update', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'superseded',
        reason_code: 'peer_build_changed_after_start',
        target_ref: 'db1d2529',
        detail: 'Queued remote update to db1d2529 stopped after the peer changed build.',
        finished_at_unix_ms: 1775435700000,
      },
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Build changed',
      actionDetail: 'Peer changed build while the update was running',
      spinning: false,
    })
    expect(remoteUpdateMenuActionLabel(source, undefined)).toBe('Build changed')
  })

  it('keeps dropdown remote update labels on live progress while pending', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'accepted',
        target_ref: 'db1d2529',
        detail: 'Preparing worker: Starting remote self-update worker.',
        accepted_at_unix_ms: 1775435700000,
        timeline: [
          {
            unix_ms: 1775435701000,
            phase: 'worker_started',
            label: 'Worker started',
            detail: 'Preparing worker: Starting remote self-update worker.',
          },
        ],
      },
    }

    expect(remoteUpdateMenuActionLabel(source, undefined)).toBe('Preparing')
  })

  it('shows failed state in dropdown instead of immediately reverting to update peer', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'failed',
        target_ref: '45a389c0',
        detail: 'Remote update worker PID 116572 exited without recording completion for target 45a389c0.',
        finished_at_unix_ms: 1775483940000,
      },
    }

    expect(remoteUpdateMenuActionLabel(source, undefined, '45a389c0abcdef')).toBe('Update failed')
  })

  it('shows succeeded state in dropdown instead of immediately reverting to update peer', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'succeeded',
        target_ref: '45a389c0',
        detail: 'Remote update to 45a389c0 completed.',
        finished_at_unix_ms: 1775483940000,
      },
    }

    expect(remoteUpdateMenuActionLabel(source, undefined, '45a389c0abcdef')).toBe('Updated')
  })

  it('shows local pending remote update details in diagnostics before peer status catches up', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
    }

    const display = diagnosticsRemoteUpdateDisplay(source, {
      stage: 'requesting',
      detail: 'Sending update request to peer',
      startedAtUnixMs: 1775435700000,
    })

    expect(display.label).toBe('Sending')
    expect(display.detail).toBe('Sending update request to peer')
    expect(display.time).toBe(formatCommitDate(1775435700000))
    expect(display.timeline).toEqual([
      {
        unix_ms: 1775435700000,
        label: 'Request sent from current machine',
        detail: 'Sending update request to peer',
        phase: 'requesting',
      },
    ])
  })

  it('switches diagnostics to remote status once peer progress is newer than local pending', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: true,
      version_sync_reason: 'Desk B requires update.',
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      remote_update_status: {
        state: 'running',
        target_ref: 'db1d2529',
        detail: 'Peer is fetching and applying this build.',
        accepted_at_unix_ms: 1775435701000,
        started_at_unix_ms: 1775435702000,
        updated_at_unix_ms: 1775435703000,
        timeline: [
          {
            unix_ms: 1775435702000,
            label: 'Fetching build',
            detail: 'Downloading target build archive',
            phase: 'fetching',
          },
        ],
      },
    }

    const display = diagnosticsRemoteUpdateDisplay(source, {
      stage: 'refreshing',
      detail: 'Peer accepted request. Refreshing remote progress',
      startedAtUnixMs: 1775435700000,
    })

    expect(display.label).toBe('Updating')
    expect(display.detail).toBe('Peer is fetching and applying this build.')
    expect(display.time).toBe(formatCommitDate(1775435702000))
    expect(display.timeline).toEqual([
      {
        unix_ms: 1775435702000,
        label: 'Fetching build',
        detail: 'Downloading target build archive',
        phase: 'fetching',
      },
    ])
  })

  it('keeps the newest remote debug log lines expanded and collapses older ones', () => {
    expect(
      splitRemoteDebugLogTail(
        ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n'),
      ),
    ).toEqual({
      older: ['line 1', 'line 2'].join('\n'),
      recent: ['line 3', 'line 4', 'line 5', 'line 6'].join('\n'),
    })
  })

  it('keeps short remote debug logs fully expanded', () => {
    expect(splitRemoteDebugLogTail(['line 1', 'line 2'].join('\n'))).toEqual({
      older: '',
      recent: ['line 1', 'line 2'].join('\n'),
    })
  })

  it('only shows a paused summary badge when more than one sync domain is paused', () => {
    const config = buildConfig()
    const baseSource = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: false,
      version_sync_reason: null,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
    }

    expect(syncPauseSummaryLabel({
      ...baseSource,
      sync_blocked_domains: ['usage_history'],
    })).toBeNull()
    expect(syncPauseSummaryLabel({
      ...baseSource,
      sync_blocked_domains: ['usage_history', 'provider_definitions'],
    })).toBe('2 domains paused')
  })

  it('keeps single paused domain visible instead of collapsing it away', () => {
    const config = buildConfig()
    const source = {
      ...config.config_source!.sources[0],
      kind: 'peer' as const,
      node_id: 'node-b',
      node_name: 'Desk B',
      active: false,
      trusted: true,
      follow_allowed: false,
      using_count: 1,
      version_sync_required: false,
      version_sync_reason: null,
      same_version_update_allowed: true,
      same_version_update_blocked_reason: null,
      sync_blocked_domains: ['usage_history'],
    }

    expect(syncPauseSummaryLabel(source)).toBeNull()
    expect(source.sync_blocked_domains?.map((domain) => domain)).toEqual(['usage_history'])
  })

  it('formats diagnostics build compare values', () => {
    const commitDate = new Date(1775312828000)
    const day = String(commitDate.getDate()).padStart(2, '0')
    const month = String(commitDate.getMonth() + 1).padStart(2, '0')
    const year = commitDate.getFullYear()
    const hours = String(commitDate.getHours()).padStart(2, '0')
    const minutes = String(commitDate.getMinutes()).padStart(2, '0')
    const offsetMinutes = -commitDate.getTimezoneOffset()
    const sign = offsetMinutes >= 0 ? '+' : '-'
    const absOffsetMinutes = Math.abs(offsetMinutes)
    const offsetHours = String(Math.floor(absOffsetMinutes / 60)).padStart(2, '0')
    const offsetRemainderMinutes = String(absOffsetMinutes % 60).padStart(2, '0')
    const expectedCommitDate = `${day}-${month}-${year} ${hours}:${minutes} UTC${sign}${offsetHours}:${offsetRemainderMinutes}`

    expect(
      formatBuildLabel({
        app_version: '0.4.0',
        build_git_sha: 'fc1078f04a67355e98571c295bfbb5a2c3578560',
        build_git_short_sha: 'fc1078f0',
        build_git_commit_unix_ms: 1775312828000,
      }),
    ).toBe('v0.4.0 · fc1078f0')
    expect(
      formatBuildLabel({
        app_version: '0.4.0',
        build_git_sha: 'unknown',
        build_git_short_sha: 'unknown',
        build_git_commit_unix_ms: null,
      }),
    ).toBe('v0.4.0 · unknown')
    expect(formatCommitDate(1775312828000)).toBe(expectedCommitDate)
    expect(formatCommitDate(null)).toBe('Unknown')
  })
})
