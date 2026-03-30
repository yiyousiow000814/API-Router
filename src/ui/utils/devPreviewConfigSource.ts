import type { Config } from '../types'

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

export function nextCopiedProviderName(providers: Config['providers'], baseName: string): string {
  const trimmed = baseName.trim()
  const first = trimmed ? `${trimmed} [copy]` : '[copy]'
  if (!providers[first]) return first
  let index = 2
  while (true) {
    const candidate = trimmed ? `${trimmed} [copy ${index}]` : `[copy ${index}]`
    if (!providers[candidate]) return candidate
    index += 1
  }
}

export function normalizedProviderKey(keyPreview?: string | null): string | null {
  const normalized = keyPreview?.trim() ?? ''
  return normalized ? normalized : null
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
      const linkedByKey = providerKey ? localSnapshotKeys.has(providerKey) : false
      return [
        remoteName,
        {
          ...provider,
          display_name: remoteName,
          borrowed: true,
          editable: false,
          source_node_id: nodeId,
          shared_provider_id: sharedProviderId,
          local_copy_state: localSharedIds.has(sharedProviderId)
            ? ('copied' as const)
            : linkedByKey
              ? ('linked' as const)
              : null,
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
        })) ?? [],
    },
  }
}
