import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ConfigModal,
  diagnosticsWhyText,
  formatBuildLabel,
  formatCommitDate,
  keepSourceMenuOpenAfterAction,
  remoteUpdateActionState,
  syncPauseSummaryLabel,
} from './ConfigModal'
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

    expect(remoteUpdateActionState(source, 'requesting')).toEqual({
      actionLabel: 'Sending...',
      actionDetail: 'Waiting for peer to accept',
      spinning: true,
    })
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
    expect(formatCommitDate(1775312828000)).toBe('04-04-2026 14:27 UTC')
    expect(formatCommitDate(null)).toBe('Unknown')
  })
})
