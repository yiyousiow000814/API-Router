import { describe, expect, it } from 'vitest'
import type { Config } from '../types'
import {
  buildDevPreviewFollowConfig,
  getDevPreviewSourceProviders,
} from './devPreviewConfigSource'

function buildConfig(): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: 'provider_1',
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 3,
      cooldown_seconds: 600,
      request_timeout_seconds: 60,
      session_preferred_providers: {},
    },
    providers: {
      provider_1: {
        display_name: 'provider_1',
        base_url: 'https://local.example/v1',
        usage_adapter: 'ppchat',
        usage_base_url: 'https://local.example',
        has_key: true,
        key_preview: 'sk-local-alpha',
        has_usage_token: false,
      },
      provider_2: {
        display_name: 'provider_2',
        base_url: 'https://codex-api.packycode.com/v1',
        usage_adapter: 'packycode',
        usage_base_url: 'https://codex.packycode.com',
        has_key: true,
        key_preview: 'sk-pk********mN5',
        has_usage_token: true,
      },
    },
    provider_order: ['provider_1', 'provider_2'],
    config_source: {
      mode: 'local',
      followed_node_id: null,
      sources: [
        {
          kind: 'local',
          node_id: 'node-local',
          node_name: 'Local',
          active: true,
          follow_allowed: false,
          follow_blocked_reason: null,
          using_count: 1,
        },
        {
          kind: 'peer',
          node_id: 'node-desk-b',
          node_name: 'Desk B',
          active: false,
          follow_allowed: true,
          follow_blocked_reason: null,
          using_count: 0,
        },
      ],
    },
  }
}

describe('dev preview config source helpers', () => {
  it('uses dedicated remote providers for Desk B instead of mirroring local providers', () => {
    const localConfig = buildConfig()

    const providers = getDevPreviewSourceProviders('node-desk-b', localConfig)

    expect(Object.keys(providers)).toEqual(['alpha_remote', 'beta_remote', 'gamma_remote'])
    expect(providers.alpha_remote?.key_preview).toBe('sk-db-alpha-001')
    expect(providers.provider_1).toBeUndefined()
  })

  it('marks only matching-key providers as linked in follow mode', () => {
    const localConfig = buildConfig()
    const remoteProviders = getDevPreviewSourceProviders('node-desk-b', localConfig)

    const followedConfig = buildDevPreviewFollowConfig(
      localConfig,
      'node-desk-b',
      localConfig,
      remoteProviders,
    )

    expect(followedConfig.providers.desk_b_1?.local_copy_state).toBeNull()
    expect(followedConfig.providers.desk_b_2?.local_copy_state).toBe('linked')
    expect(followedConfig.providers.desk_b_3?.local_copy_state).toBeNull()
  })
})
