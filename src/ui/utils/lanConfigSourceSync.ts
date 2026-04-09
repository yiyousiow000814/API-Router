import type { Status } from '../types'

export function lanConfigSourceSyncSignature(lanSync?: Status['lan_sync'] | null): string {
  if (!lanSync?.enabled) return 'disabled'
  const peers = [...(lanSync.peers ?? [])]
    .map((peer) => ({
      node_id: peer.node_id ?? '',
      node_name: peer.node_name ?? '',
      listen_addr: peer.listen_addr ?? '',
      build_git_sha: peer.build_identity?.build_git_sha ?? '',
      build_git_commit_unix_ms: peer.build_identity?.build_git_commit_unix_ms ?? null,
      capabilities: [...(peer.capabilities ?? [])].sort(),
      remote_update_ready: peer.remote_update_readiness?.ready ?? null,
      remote_update_blocked_reason: peer.remote_update_readiness?.blocked_reason ?? null,
      remote_update_status_state: peer.remote_update_status?.state ?? null,
      remote_update_status_target_ref: peer.remote_update_status?.target_ref ?? null,
      remote_update_status_detail: peer.remote_update_status?.detail ?? null,
      remote_update_status_updated_at_unix_ms: peer.remote_update_status?.updated_at_unix_ms ?? null,
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
