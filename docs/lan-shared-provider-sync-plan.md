# LAN Shared Provider Sync Plan

## Goal

Build a LAN-only multi-node collaboration model for `API Router` so that:

- multiple computers on the same router/Wi-Fi can share the same providers and API keys
- provider metadata changes also converge across nodes, including rename, base URL, key, group, and account email
- the same `provider + api key + usage source` is refreshed by only one alive node at a time
- each computer keeps recording its own local requests and activity while offline
- requests, analytics, usage history, and quota state converge across nodes after reconnect
- dashboard sessions remain local-only, while requests and analytics can show cross-device data

## Product Rules

### Canonical rules

- There is no permanent central node.
- Every node keeps a full local copy of provider configuration and local event history.
- Shared quota refresh must use per-provider ownership with expiry, not blind polling from every node.
- Cross-device sync must replicate append-only events, not only derived totals.
- Provider configuration changes must replicate across nodes with deterministic conflict handling.
- Nodes must continue working while disconnected from peers.
- Reconnected nodes must catch up automatically from other alive peers.
- Requests and analytics views must stay smooth under frequent multi-node updates without materially increasing CPU load.

### Network scope

- This feature is LAN-only.
- Discovery and sync should work on the same router/Wi-Fi without `Tailscale`, `ZeroTier`, or public exposure.
- Nodes should identify peers by `node_id`, `node_name`, LAN address, and heartbeat freshness.

### UI semantics

- `dashboard sessions` remains local-only.
- `requests` and `analytics` may show all nodes combined.
- `requests` table should include a device column such as `node_name`.
- `cache create` column should be removed from the requests table if it remains non-actionable.

## Target Architecture

## 1. Peer Discovery

Each running `API Router` instance should advertise itself on the LAN and discover other alive peers.

Each peer record should include:

- `node_id`
- `node_name`
- `listen_addr`
- `last_heartbeat_unix_ms`
- `capabilities`
- `provider fingerprints`

## 2. Shared Provider Identity

Shared quota ownership should be decided per logical provider source, not per machine-local provider row.

A candidate shared key should include:

- normalized provider name or provider family
- normalized usage base / effective usage source
- API key fingerprint

This lets multiple nodes recognize that they are talking to the same upstream quota source.

## 3. Quota Refresh Ownership

For each shared provider key, only one alive node should perform usage/quota refresh at a time.

Ownership should use:

- heartbeat-based liveness
- short lease expiry
- deterministic tie-break such as `node_id`

If the current owner disappears, another alive node should take over after lease expiry.

## 4. Event Replication

Nodes should exchange append-only records instead of pushing merged totals.

Replication candidates:

- usage request events
- analytics source events
- quota snapshots
- spend history manual edits
- provider pricing timeline edits
- provider metadata edits such as rename, base URL, API key, group, usage settings, and account email

Each replicated event should carry:

- `event_id`
- `node_id`
- `created_at_unix_ms`
- `entity_type`
- `entity_key`
- `payload`
- optional `revision`

## 5. Local-first Operation

A disconnected node must still:

- route requests locally
- record its own requests
- compute local analytics from local data
- attempt quota refresh only when it currently owns the shared lease or no peers are alive

After reconnect, it should fetch missing remote events and merge them without wiping local state.

## 6. Provider Metadata Sync

Provider configuration should also converge across nodes.

This includes:

- provider rename
- base URL changes
- API key changes
- group membership changes
- account email changes
- shared usage-related settings

These edits should use revisioned entity updates instead of ad-hoc file overwrite so that:

- reconnecting nodes can apply missing updates in order
- conflicts are deterministic
- provider identity remains stable across rename operations

## 7. Derived Views

Derived screens should be computed from merged event/state data.

- `sessions`: local-only
- `requests`: merged all-node view with `node_name`
- `analytics`: merged all-node aggregates with optional node filter
- `quota`: shared latest snapshot, tagged with source node and updated time

## 8. Performance Constraints

Multi-node sync must not make `requests` or `analytics` feel heavy.

Guardrails:

- avoid full-table recompute on every incoming remote event
- batch remote updates into short windows
- incrementally update derived aggregates where possible
- keep polling and repaint frequency bounded
- prefer append-only ingestion plus indexed queries over repeated full scans
- default UI subscriptions should only watch the data needed by the visible page

## Delivery Phases

## Phase 1 - Discovery Foundation

- add node identity
- add LAN peer discovery and heartbeat
- show alive peers in debug/status UI

Acceptance:

- nodes on the same LAN can discover each other reliably
- stale peers expire automatically

## Phase 2 - Shared Quota Ownership

- define shared provider fingerprint
- implement per-provider lease ownership
- allow only the owner node to refresh shared usage/quota

Acceptance:

- two alive nodes with the same provider/key do not both hit the same usage endpoint
- owner failover happens automatically after timeout

## Phase 3 - Request Event Sync

- replicate raw usage request events across peers
- dedupe by event id
- add `node_name` to requests table
- remove `cache create` column
- add batching/indexing so the requests page remains smooth under multi-node updates

Acceptance:

- requests from different computers appear in one merged table
- reconnecting peers catch up without duplicates
- requests table remains responsive during sustained cross-node ingestion

## Phase 4 - Analytics Convergence

- compute analytics from merged request/event history
- support all-node and single-node filters
- use incremental aggregation or bounded recompute so analytics remains efficient

Acceptance:

- analytics totals converge across peers after sync
- local/offline work appears after reconnect
- analytics page remains smooth without obvious CPU spikes during sync bursts

## Phase 5 - Editable State Sync

- replicate spend history manual edits
- replicate pricing timeline edits
- replicate provider metadata edits
- add revision/conflict handling for editable entities

Acceptance:

- editable usage history and pricing changes converge across peers
- provider rename, base URL, key, group, and email changes converge across peers
- conflicts resolve deterministically

## Immediate Questions

- What exact fields define the shared provider fingerprint?
- What stable provider identity survives rename while still allowing renamed display/provider labels to sync cleanly?
- What lease timeout is safe enough to avoid duplicate quota refresh while keeping failover responsive?
- Should merged requests/analytics default to all nodes or current node?
- What batching window keeps UI smooth while still feeling live enough during multi-node ingestion?

## Non-goals

- Do not require a permanent master node.
- Do not depend on public internet exposure or third-party mesh VPN tools.
- Do not merge local session runtime lists across machines.
- Do not sync only precomputed aggregates without raw event provenance.

## Verification Strategy

Each phase should include:

1. multi-node repro on the same router/Wi-Fi
2. evidence of peer discovery and heartbeat expiry
3. evidence that only one node refreshes a shared quota source
4. reconnection sync proof with no duplicate request rows
5. UI proof for local-only sessions and merged requests/analytics

## Success Criteria

The work is complete when:

- multiple LAN nodes can share the same providers without permanent central ownership
- shared quota refresh is deduplicated per provider/key across alive nodes
- offline nodes keep working locally and catch up after reconnect
- provider metadata edits converge across peers
- requests and analytics converge across nodes
- requests and analytics remain smooth under sustained multi-node updates
- sessions remain local-only and UI clearly labels cross-device request sources
