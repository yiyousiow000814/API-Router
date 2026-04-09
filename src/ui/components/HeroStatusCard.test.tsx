import { describe, expect, it } from 'vitest'
import { lanPeersSummary } from './HeroStatusCard'
import type { Status } from '../types'

function buildStatus(): Status {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    preferred_provider: 'p1',
    manual_override: null,
    providers: {},
    metrics: {},
    recent_events: [],
    quota: {},
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: {
      ok: true,
    },
    lan_sync: {
      enabled: true,
      discovery_port: 49052,
      heartbeat_interval_ms: 5000,
      peer_stale_after_ms: 15000,
      local_node: {
        node_id: 'node-local',
        node_name: 'Desk',
        capabilities: [],
        provider_fingerprints: [],
      },
      peers: [],
    },
  }
}

describe('HeroStatusCard', () => {
  it('shows plain alive count when no peer needs update', () => {
    const status = buildStatus()
    status.lan_sync!.peers = [
      {
        node_id: 'node-a',
        node_name: 'Peer A',
        listen_addr: '192.168.1.10:4000',
        last_heartbeat_unix_ms: 1,
        capabilities: [],
        provider_fingerprints: [],
        build_matches_local: true,
      },
    ]

    expect(lanPeersSummary(status)).toBe('1 alive')
  })

  it('shows update available summary when any peer needs version sync', () => {
    const status = buildStatus()
    status.lan_sync!.peers = [
      {
        node_id: 'node-a',
        node_name: 'Peer A',
        listen_addr: '192.168.1.10:4000',
        last_heartbeat_unix_ms: 1,
        capabilities: [],
        provider_fingerprints: [],
        build_matches_local: false,
      },
    ]

    expect(lanPeersSummary(status)).toBe('1 alive (update available)')
  })
})
