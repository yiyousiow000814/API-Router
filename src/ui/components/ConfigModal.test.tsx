import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  remoteUpdateMenuActionLabel,
  diagnosticsRemoteUpdateDisplay,
  ConfigModal,
  diagnosticsWhyText,
  formatBuildLabel,
  formatCommitDate,
  isRemoteUpdateStatusRelevantToCurrentBuild,
  keepSourceMenuOpenAfterAction,
  remoteUpdateActionState,
  remoteUpdateDetailText,
  shouldShowDiagnosticsRemoteUpdateStatus,
  shouldShowRemoteUpdateMenuDetail,
  syncPauseSummaryLabel,
} from './ConfigModal'
import {
  isRemoteUpdateStatusCurrentForPending,
  remoteUpdateStatusObservedAtUnixMs,
} from '../utils/remoteUpdateStatus'
import type { Config } from '../types'

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
        detail: 'Building checked EXE: Running npm run build:root-exe:checked',
        started_at_unix_ms: 1775312828000,
      },
    }

    expect(remoteUpdateActionState(source, undefined)).toEqual({
      actionLabel: 'Updating',
      actionDetail: 'Building checked EXE: Running npm run build:root-exe:checked',
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
      actionLabel: 'Retry update',
      actionDetail: 'Fetching from origin: git fetch failed',
      spinning: false,
    })
    expect(
      shouldShowRemoteUpdateMenuDetail(source, remoteUpdateActionState(source, undefined)),
    ).toBe(true)
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
      actionLabel: 'Retry update',
      actionDetail: 'Remote update worker PID 112248 exited without recording completion for target dfa0f229.',
      spinning: false,
    })
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
        detail: 'Peer accepted request. Refreshing remote progress',
        accepted_at_unix_ms: 1775435700000,
      },
    }

    expect(remoteUpdateMenuActionLabel(source, undefined)).toBe('Queued')
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
