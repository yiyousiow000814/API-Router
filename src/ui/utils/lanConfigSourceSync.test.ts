import { describe, expect, it } from 'vitest'
import { lanConfigSourceSyncSignature } from './lanConfigSourceSync'

describe('lanConfigSourceSyncSignature', () => {
  it('ignores heartbeat timestamp churn', () => {
    const a = lanConfigSourceSyncSignature({
      enabled: true,
      discovery_port: 38455,
      heartbeat_interval_ms: 2000,
      peer_stale_after_ms: 7000,
      last_peer_heartbeat_received_unix_ms: 100,
      last_peer_heartbeat_source: '192.168.1.20:50000',
      local_node: {
        node_id: 'node-local',
        node_name: 'Local',
        listen_addr: '192.168.1.10:4000',
        capabilities: [],
        provider_fingerprints: [],
      },
      peers: [
        {
          node_id: 'node-remote',
          node_name: 'Remote',
          listen_addr: '192.168.1.20:4000',
          last_heartbeat_unix_ms: 100,
          capabilities: [],
          provider_fingerprints: [],
          trusted: false,
          pair_state: null,
          pair_request_id: null,
          followed_source_node_id: null,
        },
      ],
    })
    const b = lanConfigSourceSyncSignature({
      enabled: true,
      discovery_port: 38455,
      heartbeat_interval_ms: 2000,
      peer_stale_after_ms: 7000,
      last_peer_heartbeat_received_unix_ms: 999,
      last_peer_heartbeat_source: '192.168.1.20:50001',
      local_node: {
        node_id: 'node-local',
        node_name: 'Local',
        listen_addr: '192.168.1.10:4000',
        capabilities: [],
        provider_fingerprints: [],
      },
      peers: [
        {
          node_id: 'node-remote',
          node_name: 'Remote',
          listen_addr: '192.168.1.20:4000',
          last_heartbeat_unix_ms: 999,
          capabilities: [],
          provider_fingerprints: [],
          trusted: false,
          pair_state: null,
          pair_request_id: null,
          followed_source_node_id: null,
        },
      ],
    })

    expect(a).toBe(b)
  })

  it('changes when peer trust or pair state changes', () => {
    const base = {
      enabled: true as const,
      discovery_port: 38455,
      heartbeat_interval_ms: 2000,
      peer_stale_after_ms: 7000,
      local_node: {
        node_id: 'node-local',
        node_name: 'Local',
        listen_addr: '192.168.1.10:4000',
        capabilities: [],
        provider_fingerprints: [],
      },
    }

    const untrusted = lanConfigSourceSyncSignature({
      ...base,
      peers: [
        {
          node_id: 'node-remote',
          node_name: 'Remote',
          listen_addr: '192.168.1.20:4000',
          last_heartbeat_unix_ms: 100,
          capabilities: [],
          provider_fingerprints: [],
          trusted: false,
          pair_state: null,
          pair_request_id: null,
          followed_source_node_id: null,
        },
      ],
    })
    const trusted = lanConfigSourceSyncSignature({
      ...base,
      peers: [
        {
          node_id: 'node-remote',
          node_name: 'Remote',
          listen_addr: '192.168.1.20:4000',
          last_heartbeat_unix_ms: 100,
          capabilities: [],
          provider_fingerprints: [],
          trusted: true,
          pair_state: 'trusted',
          pair_request_id: null,
          followed_source_node_id: null,
        },
      ],
    })

    expect(untrusted).not.toBe(trusted)
  })
})
