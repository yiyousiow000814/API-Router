import { describe, expect, it } from 'vitest'
import { lanPeerTailscaleSummary, lanPeersSummary, tailscaleSummary } from './HeroStatusCard'
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
    tailscale: {
      installed: true,
      connected: true,
      dns_name: 'desk.tail.ts.net',
      ipv4: ['100.64.0.8'],
      reachable_ipv4: ['100.64.0.8'],
      gateway_reachable: true,
      needs_gateway_restart: false,
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

  it('shows restart guidance when tailscale is connected but the gateway is not reachable yet', () => {
    const status = buildStatus()
    status.tailscale = {
      installed: true,
      connected: true,
      dns_name: 'desk.tail.ts.net',
      ipv4: ['100.64.0.8'],
      reachable_ipv4: [],
      gateway_reachable: false,
      needs_gateway_restart: true,
    }

    expect(tailscaleSummary(status)).toBe('Connected, restart API Router')
  })

  it('summarizes peer tailscale issues for remote diagnosis', () => {
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
        tailscale: {
          installed: true,
          connected: true,
          dns_name: 'peer-a.tail.ts.net',
          ipv4: ['100.64.0.10'],
          reachable_ipv4: [],
          gateway_reachable: false,
          needs_gateway_restart: true,
        },
      },
    ]

    expect(lanPeerTailscaleSummary(status)).toBe('Peer A: needs restart')
  })
})
