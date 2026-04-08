import type { Config } from '../types'
import { deriveLocalCopyState, nextCopiedProviderName, normalizedProviderKey } from './configSourceCopy'

export const DEV_PREVIEW_REMOTE_PROVIDERS: Record<string, Config['providers']> = {
  'node-desk-b': {
    alpha_remote: {
      display_name: 'alpha_remote',
      base_url: 'https://desk-b.alpha.example/v1',
      usage_adapter: 'ppchat',
      usage_base_url: 'https://desk-b.alpha.example',
      has_key: true,
      key_preview: 'sk-db-alpha-001',
      has_usage_token: false,
    },
    beta_remote: {
      display_name: 'beta_remote',
      base_url: 'https://codex-api.packycode.com/v1',
      usage_adapter: 'packycode',
      usage_base_url: 'https://codex.packycode.com',
      has_key: true,
      key_preview: 'sk-pk********mN5',
      has_usage_token: true,
    },
    gamma_remote: {
      display_name: 'gamma_remote',
      base_url: 'https://desk-b.gamma.example/v1',
      usage_adapter: 'pumpkinai',
      usage_base_url: 'https://desk-b.gamma.example',
      has_key: true,
      key_preview: 'sk-db-gamma-003',
      has_usage_token: false,
    },
  },
  'node-laptop-c': {
    delta_remote: {
      display_name: 'delta_remote',
      base_url: 'https://laptop-c.delta.example/v1',
      usage_adapter: 'ppchat',
      usage_base_url: 'https://laptop-c.delta.example',
      has_key: true,
      key_preview: 'sk-lc-delta-101',
      has_usage_token: false,
    },
    epsilon_remote: {
      display_name: 'epsilon_remote',
      base_url: 'https://laptop-c.epsilon.example/v1',
      usage_adapter: 'pumpkinai',
      usage_base_url: 'https://laptop-c.epsilon.example',
      has_key: false,
      key_preview: null,
      has_usage_token: false,
    },
  },
}

function cloneProviderMap(providers: Config['providers']): Config['providers'] {
  return Object.fromEntries(Object.entries(providers).map(([name, provider]) => [name, { ...provider }]))
}

function sourceFollowAllowed(source: NonNullable<Config['config_source']>['sources'][number]): boolean {
  if (source.kind !== 'peer') return false
  return Boolean(source.trusted) && !source.follow_blocked_reason
}

export function getDevPreviewSourceProviders(
  nodeId: string,
  localSnapshot: Config,
): Config['providers'] {
  return cloneProviderMap(DEV_PREVIEW_REMOTE_PROVIDERS[nodeId] ?? localSnapshot.providers)
}

export function buildDevPreviewFollowConfig(
  config: Config,
  nodeId: string,
  localSnapshot?: Config | null,
  sourceProviders?: Config['providers'],
): Config {
  const source = config.config_source?.sources.find((entry) => entry.node_id === nodeId)
  if (!source || source.kind !== 'peer') return config
  const localSharedIds = new Set(
    Object.values(localSnapshot?.providers ?? {})
      .map((provider) => provider.shared_provider_id)
      .filter((value): value is string => Boolean(value)),
  )
  const localSnapshotKeys = new Set(
    Object.values(localSnapshot?.providers ?? {})
      .map((provider) => normalizedProviderKey(provider.key_preview))
      .filter((value): value is string => Boolean(value)),
  )
  const sourceProviderMap = sourceProviders ?? getDevPreviewSourceProviders(nodeId, localSnapshot ?? config)
  const followedProviders = Object.fromEntries(
    Object.entries(sourceProviderMap).map(([name, provider], index) => {
      const remoteName = `${source.node_name.toLowerCase().replace(/\s+/g, '_')}_${index + 1}`
      const sharedProviderId = `${nodeId}:${name}`
      const providerKey = normalizedProviderKey(provider.key_preview)
      return [
        remoteName,
        {
          ...provider,
          display_name: remoteName,
          borrowed: true,
          editable: false,
          source_node_id: nodeId,
          shared_provider_id: sharedProviderId,
          local_copy_state: deriveLocalCopyState({
            sharedProviderId,
            providerKey,
            copiedSharedProviderIds: localSharedIds,
            localSnapshotKeys,
          }),
        },
      ]
    }),
  )
  const followedOrder = Object.keys(followedProviders)
  const followedPreferred = followedOrder[0] ?? config.routing.preferred_provider
  return {
    ...config,
    routing: {
      ...config.routing,
      preferred_provider: followedPreferred,
      session_preferred_providers: {},
    },
    providers: followedProviders,
    provider_order: followedOrder,
    config_source: {
      mode: 'follow',
      followed_node_id: nodeId,
      sources:
        config.config_source?.sources.map((entry) => ({
          ...entry,
          active: entry.node_id === nodeId,
          follow_allowed: entry.node_id === nodeId ? sourceFollowAllowed(entry) : entry.follow_allowed,
        })) ?? [],
    },
  }
}

export function updateDevPreviewPairState(
  config: Config,
  nodeId: string,
  updater: (
    source: NonNullable<Config['config_source']>['sources'][number],
  ) => NonNullable<Config['config_source']>['sources'][number],
): Config {
  if (!config.config_source) return config
  return {
    ...config,
    config_source: {
      ...config.config_source,
      sources: config.config_source.sources.map((source) =>
        source.node_id === nodeId ? updater({ ...source }) : source,
      ),
    },
  }
}

export function copyDevPreviewBorrowedProvider(args: {
  activeConfig: Config
  localBase: Config
  sourceNodeId: string
  sharedProviderId: string
  sourceProviders?: Config['providers']
}): {
  nextLocalConfig: Config
  nextFollowConfig: Config
  targetName: string
  localCopyState: 'copied' | 'linked'
} | null {
  const { activeConfig, localBase, sourceNodeId, sharedProviderId, sourceProviders } = args
  const borrowedEntry = Object.entries(activeConfig.providers ?? {}).find(
    ([, provider]) =>
      provider.borrowed &&
      provider.source_node_id === sourceNodeId &&
      provider.shared_provider_id === sharedProviderId,
  )
  if (!borrowedEntry) {
    return null
  }
  const [borrowedName, borrowedProvider] = borrowedEntry
  const nextLocalProviders = { ...localBase.providers }
  const borrowedKey = normalizedProviderKey(borrowedProvider.key_preview)
  const existingMatch = borrowedKey
    ? Object.entries(nextLocalProviders).find(([name, provider]) => {
        if (name === borrowedName) return false
        return normalizedProviderKey(provider.key_preview) === borrowedKey
      })?.[0] ?? null
    : null
  const targetName = existingMatch
    ? existingMatch
    : nextLocalProviders[borrowedName]
      ? nextCopiedProviderName(Object.keys(nextLocalProviders), borrowedName)
      : borrowedName
  const localCopyState = existingMatch ? ('linked' as const) : ('copied' as const)
  nextLocalProviders[targetName] = {
    ...borrowedProvider,
    display_name: targetName,
    borrowed: false,
    editable: true,
    source_node_id: null,
    local_copy_state: null,
  }
  const nextLocalOrder = localBase.provider_order?.includes(targetName)
    ? (localBase.provider_order ?? [])
    : [...(localBase.provider_order ?? []), targetName]
  const nextLocalConfig = {
    ...localBase,
    providers: nextLocalProviders,
    provider_order: nextLocalOrder,
  }
  const followedNodeId = activeConfig.config_source?.followed_node_id
  const nextFollowConfig = followedNodeId
    ? buildDevPreviewFollowConfig(
        activeConfig,
        followedNodeId,
        nextLocalConfig,
        sourceProviders,
      )
    : activeConfig
  return {
    nextLocalConfig,
    nextFollowConfig: {
      ...nextFollowConfig,
      providers: Object.fromEntries(
        Object.entries(nextFollowConfig.providers).map(([name, provider]) => [
          name,
          provider.source_node_id === sourceNodeId && provider.shared_provider_id === sharedProviderId
            ? { ...provider, local_copy_state: localCopyState }
            : provider,
        ]),
      ),
    },
    targetName,
    localCopyState,
  }
}
