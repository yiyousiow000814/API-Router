import type { Status } from '../types'

export function lanConfigSourceSyncSignature(lanSync?: Status['lan_sync'] | null): string {
  if (!lanSync?.enabled) return 'disabled'
  const peers = [...(lanSync.peers ?? [])]
    .map((peer) => ({
      node_id: peer.node_id ?? '',
      node_name: peer.node_name ?? '',
      listen_addr: peer.listen_addr ?? '',
      trusted: Boolean(peer.trusted),
      pair_state: peer.pair_state ?? null,
      pair_request_id: peer.pair_request_id ?? null,
      followed_source_node_id: peer.followed_source_node_id ?? null,
    }))
    .sort((a, b) => a.node_id.localeCompare(b.node_id))
  return JSON.stringify({
    enabled: true,
    local_node_id: lanSync.local_node?.node_id ?? '',
    peers,
  })
}
