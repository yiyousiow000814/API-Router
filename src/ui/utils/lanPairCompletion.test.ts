import { describe, expect, it, vi } from 'vitest'
import type { Config, Status } from '../types'
import { ensureLanConfigSourceTrust, isLanConfigSourceTrusted, waitForLanConfigSourceTrust } from './lanPairCompletion'

function buildStatus(): Status {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    providers: {},
    metrics: {},
    quota: [],
    ledgers: [],
    client_sessions: [],
    recent_events: [],
    preferred_provider: 'provider_1',
    manual_override: null,
    last_activity_unix_ms: 0,
    codex_account: { ok: false },
  } as unknown as Status
}

function buildConfig(
  trusted: boolean,
  pairState: 'trusted' | 'incoming_request' | 'requested' | 'pin_required' | null,
): Config {
  return {
    providers: {},
    config_source: {
      mode: 'local',
      sources: [
        {
          kind: 'peer',
          node_id: 'node-b',
          node_name: 'Desk B',
          active: false,
          trusted,
          pair_state: pairState,
          pair_request_id: trusted ? null : 'pair_123',
          follow_allowed: trusted,
          follow_blocked_reason: trusted ? null : 'pair this device before following its config',
          using_count: 0,
        },
      ],
    },
  } as Config
}

describe('lanPairCompletion', () => {
  it('recognizes trusted config sources', () => {
    expect(isLanConfigSourceTrusted(buildConfig(true, 'trusted'), 'node-b')).toBe(true)
    expect(isLanConfigSourceTrusted(buildConfig(false, 'requested'), 'node-b')).toBe(false)
  })

  it('keeps polling until the config source becomes trusted', async () => {
    const statuses = [buildStatus(), buildStatus(), buildStatus()]
    const configs = [
      buildConfig(false, 'requested'),
      buildConfig(false, 'pin_required'),
      buildConfig(true, 'trusted'),
    ]
    const appliedConfigs: Config[] = []
    const wait = vi.fn(async () => {})

    const trusted = await waitForLanConfigSourceTrust({
      nodeId: 'node-b',
      loadStatus: vi.fn(async () => statuses.shift() ?? buildStatus()),
      loadConfig: vi.fn(async () => configs.shift() ?? buildConfig(true, 'trusted')),
      applyStatus: vi.fn(),
      applyConfig: (config) => {
        appliedConfigs.push(config)
      },
      wait,
      intervalMs: 1,
      maxAttempts: 5,
    })

    expect(trusted).toBe(true)
    expect(appliedConfigs).toHaveLength(3)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(
      appliedConfigs.at(-1)?.config_source?.sources.find((source) => source.node_id === 'node-b')?.pair_state,
    ).toBe('trusted')
  })

  it('rejects when the config source never becomes trusted', async () => {
    const wait = vi.fn(async () => {})

    await expect(
      ensureLanConfigSourceTrust({
        nodeId: 'node-b',
        loadStatus: vi.fn(async () => buildStatus()),
        loadConfig: vi.fn(async () => buildConfig(false, 'pin_required')),
        applyStatus: vi.fn(),
        applyConfig: vi.fn(),
        wait,
        intervalMs: 1,
        maxAttempts: 3,
      }),
    ).rejects.toThrow('Pairing PIN was not accepted.')

    expect(wait).toHaveBeenCalledTimes(2)
  })
})
