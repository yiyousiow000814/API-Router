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
- Provider rows are shared objects, not machine-local objects.
- A shared provider must converge to the same fields on every alive node; long-lived per-node drift is not allowed.
- Shared quota refresh must use per-provider ownership with expiry, not blind polling from every node.
- Cross-device sync must replicate append-only events, not only derived totals.
- Provider configuration changes must replicate across nodes with deterministic conflict handling.
- Nodes must continue working while disconnected from peers.
- Reconnected nodes must catch up automatically from other alive peers.
- Requests and analytics views must stay smooth under frequent multi-node updates without materially increasing CPU load.
- Provider health must converge per shared provider source, not drift independently per node once peers are connected.
- A provider failure confirmed on any trusted alive node must stop the same shared provider source on the other trusted alive nodes too.
- Cooldown must be shared per logical provider source and default to 10 minutes.
- Cooldown recovery probing must be single-owner and limited, not performed by every node at once.
- During shared cooldown, normal routing must not send regular traffic to that shared provider source.
- LAN sync traffic must be authenticated, but trusted peers should join automatically without manual pairing.
- Version or capability mismatch between peers must not cause hard failure; replication and routing should use only the mutually supported feature subset.

### Network scope

- This feature is LAN-only.
- Discovery and sync should work on the same router/Wi-Fi without `Tailscale`, `ZeroTier`, or public exposure.
- Nodes should identify peers by `node_id`, `node_name`, LAN address, and heartbeat freshness.

### Version and capability compatibility

- Peers may run different app versions.
- Discovery must advertise both app version and capability flags.
- A newer node must not force an older node to execute unsupported sync behavior.
- An older node must not block the cluster from using newer behavior among peers that support it.
- Unsupported features must degrade by capability negotiation, not by crashing, forcing disconnect, or poisoning shared state.
- Shared provider state that depends on a capability absent on some peers must fall back to the highest mutually supported behavior for that specific message or feature.
- Capability mismatch should be visible in debug/status UI so it can be diagnosed without packet inspection.

## Target Architecture

## 1. Peer Discovery

Each running `API Router` instance should advertise itself on the LAN and discover other alive peers.

Each peer record should include:

- `node_id`
- `node_name`
- `listen_addr`
- `last_heartbeat_unix_ms`
- `app_version`
- `capabilities`
- `provider fingerprints`

## 2. Shared Provider Identity

Providers are shared entities across nodes, not separate local rows that happen to look similar.

Canonical identity must use two layers:

- `shared_provider_id`: the stable identity of the provider object itself
- `shared_provider_fingerprint`: the runtime identity of the current upstream quota/health source used by that provider

`shared_provider_id` rules:

- generated once when the shared provider is created
- replicated to every node unchanged
- survives rename, base URL change, API key change, group change, account email change, and other editable metadata changes
- is the canonical key for provider metadata sync and conflict resolution

`shared_provider_fingerprint` rules:

- derived from the provider's current effective upstream source
- may change when API key, usage base, or provider-family mapping changes
- is used for shared quota ownership and shared health/cooldown propagation
- is not the canonical identity of the provider object itself

A candidate `shared_provider_fingerprint` should include:

- normalized provider family
- normalized effective usage base / effective usage source
- API key fingerprint

This lets all nodes agree on two different truths at the same time:

- this is the same shared provider object
- this provider is currently talking to this shared upstream quota/health source

## 3. Quota Refresh Ownership

For each shared provider key, only one alive node should perform usage/quota refresh at a time.

Ownership should use:

- heartbeat-based liveness
- short lease expiry
- deterministic tie-break such as `node_id`

If the current owner disappears, another alive node should take over after lease expiry.

## 4. Shared Health and Cooldown Propagation

Provider health must converge across nodes for the same `shared_provider_fingerprint`.

Rules:

- If any trusted alive node records a qualifying shared failure for a `shared_provider_fingerprint`, that failure should be replicated to the other trusted alive nodes.
- Once replicated, that shared provider source should be treated as `healthy = no` on every trusted alive node that currently uses the same fingerprint.
- Health state must not remain machine-local for shared providers; otherwise one node may keep routing into a provider that another node already proved broken.
- Shared cooldown should default to 10 minutes.
- Entering cooldown on one node should cause the same shared provider fingerprint to enter cooldown on the other alive nodes as well.
- During shared cooldown, normal routing must not send regular traffic to that shared provider source.
- The only allowed traffic during cooldown is a single-owner recovery probe after cooldown expiry, or an explicit operator-triggered probe.
- Cooldown ownership should be single-node: after cooldown expiry, only one alive node may perform the next recovery probe for that shared provider fingerprint.
- That recovery probe should be a single test attempt, not a burst from all nodes.
- If the owner probe succeeds, the shared provider fingerprint should converge back to `healthy = yes` across alive nodes.
- If the owner probe fails or gets no response, it should start a new 10-minute shared cooldown window from the probe time and other nodes must not all probe immediately.
- If the elected owner disappears during cooldown expiry, another alive node may take over the single recovery probe based on the same deterministic lease / tie-break rule.
- Delayed replication of older failure events must not incorrectly restart cooldown if they are older than the currently active shared cooldown state.

Shared failure classification must be explicit:

- `401` / `403`: shared unhealthy immediately for that fingerprint
- upstream `5xx`: shared unhealthy immediately for that fingerprint
- stream disconnected before completion when clearly attributable to upstream/provider failure: shared unhealthy immediately for that fingerprint
- retry exhausted after transient upstream/provider failures: shared unhealthy immediately for that fingerprint
- `429`: shared backoff/cooldown signal, but not automatically a permanent unhealthy state by itself
- node-local network failure or transient LAN noise: do not mark shared unhealthy unless it is proven to be a real provider-source failure
- quota/usage endpoint failure: only marks shared unhealthy if that provider cannot be used safely without the failing endpoint; otherwise it degrades quota freshness only
- manual operator disable: treated separately from observed shared upstream health unless explicitly modeled as a shared state change

This health propagation is scoped to the shared provider fingerprint, not all providers globally.

## 5. Event Replication

Nodes should exchange append-only records instead of pushing merged totals.

Replication candidates:

- usage request events
- analytics source events
- quota snapshots
- shared health / cooldown state transitions
- spend history manual edits
- provider pricing timeline edits
- provider metadata edits such as rename, base URL, API key, group, usage settings, and account email

Each replicated event should carry:

- `event_id`
- `node_id`
- `created_at_unix_ms`
- `lamport_ts` or another deterministic monotonic merge timestamp
- `entity_type`
- `entity_id`
- `op`
- `payload`
- optional `revision`

Replication contract rules:

- `event_id` is the global dedupe key
- merged ordering must not rely only on wall-clock time; use a deterministic tie-break such as `lamport_ts`, then `created_at_unix_ms`, then `event_id`
- reconnecting nodes must fetch incrementally from a durable cursor, not by repeatedly full-scanning all history
- deletes or removals must use tombstone-style events instead of silent overwrite or implicit disappearance
- late-arriving duplicate events must be ignored without changing derived state

## 6. Local-first Operation

A disconnected node must still:

- route requests locally
- record its own requests
- compute local analytics from local data
- attempt quota refresh only when it currently owns the shared lease or no peers are alive
- continue using its last known shared provider state while clearly treating peer freshness as stale

After reconnect, it should fetch missing remote events and merge them without wiping local state.

## 7. Provider Metadata Sync

Provider configuration should also converge across nodes.

This includes:

- provider rename
- base URL changes
- API key changes
- group membership changes
- account email changes
- shared usage-related settings
- disabled state and other operator-controlled provider flags

These edits should use revisioned entity updates instead of ad-hoc file overwrite so that:

- reconnecting nodes can apply missing updates in order
- conflicts are deterministic
- provider identity remains stable across rename operations
- changing one field does not implicitly replace unrelated fields

Conflict rules for shared providers:

- the canonical entity key is `shared_provider_id`
- the canonical update unit is field-level or patch-level mutation, not whole-file overwrite
- rename is not a special entity move; it is a field update on the same `shared_provider_id`
- API key change is also a field update on the same `shared_provider_id`
- if two nodes update the same field concurrently, the higher `revision` wins
- if `revision` ties, use a deterministic tie-break such as `node_id`
- delete/remove semantics must use tombstones so reconnecting nodes can converge deterministically

## 8. Derived Views

Derived screens should be computed from merged event/state data.

- `sessions`: local-only
- `requests`: merged all-node view with `node_name`
- `analytics`: merged all-node aggregates with optional node filter
- `quota`: shared latest snapshot, tagged with source node and updated time

UI contract rules:

- `sessions` stays local-only even when all other shared views are enabled
- `requests` should default to all nodes and support node filtering
- `analytics` should default to all nodes and support node filtering
- shared provider health/cooldown should display the last reporting or probe node when useful
- shared cooldown UI should show the remaining shared cooldown time, not a misleading local-only timer

## 9. LAN Trust Model

LAN-only is not treated as inherently trusted.

Rules:

- peer discovery messages may be visible on the LAN, but shared-state mutation and replication must require authentication
- trusted peers should join automatically when they satisfy the shared LAN trust mechanism; no manual per-peer pairing flow is required
- unauthenticated peers may be shown as untrusted discovery candidates for debugging, but must not change provider state, health state, cooldown state, or replicated event history
- duplicate `node_id` values must be treated as a conflict and surfaced clearly instead of silently trusting both senders
- trust decisions must be deterministic and restart-safe

Minimum acceptable implementation:

- sign or authenticate replication messages with a shared LAN sync secret or another automatic shared-membership credential
- ignore shared-state mutation traffic when the signature or secret is invalid
- persist the local node identity and trust secret separately from normal provider fields

## 10. Performance Constraints

Multi-node sync must not make `requests` or `analytics` feel heavy.

Guardrails:

- avoid full-table recompute on every incoming remote event
- batch remote updates into short windows
- incrementally update derived aggregates where possible
- keep polling and repaint frequency bounded
- prefer append-only ingestion plus indexed queries over repeated full scans
- default UI subscriptions should only watch the data needed by the visible page
- shared health propagation and cooldown replication must not cause every node to hot-loop probe or repaint repeatedly

## Delivery Phases

## Phase 1 - Discovery Foundation

- add node identity
- add LAN peer discovery and heartbeat
- show alive peers in debug/status UI

Acceptance:

- nodes on the same LAN can discover each other reliably
- stale peers expire automatically

## Phase 2 - Shared Quota Ownership

- define `shared_provider_id` and `shared_provider_fingerprint`
- implement per-provider lease ownership
- allow only the owner node to refresh shared usage/quota
- expose owner identity and lease freshness for debug/status inspection

Acceptance:

- two alive nodes with the same provider/key do not both hit the same usage endpoint
- owner failover happens automatically after timeout
- only one alive node is considered the active quota refresh owner per shared fingerprint at a time
- changing provider metadata does not create duplicate provider identities across nodes

## Phase 3 - Shared Health and Cooldown Convergence

- replicate provider failure events for shared provider fingerprints
- converge shared `healthy/unhealthy/cooldown` state across alive nodes
- make shared cooldown default to 10 minutes
- block normal routing to a shared provider while it is in shared cooldown
- elect exactly one alive node to perform the post-cooldown recovery probe
- mark shared provider healthy again only after a successful owner probe
- if the owner probe fails or does not respond, re-enter shared cooldown without causing all peers to probe

Acceptance:

- if one node proves a shared provider is broken, the same shared provider becomes unavailable on the other alive nodes too
- cooldown state and remaining cooldown time converge across alive nodes for that shared provider fingerprint
- normal requests do not continue using that shared provider during the shared cooldown window
- after cooldown expiry, only one alive node sends the recovery probe
- a successful recovery probe restores health on all alive nodes sharing that fingerprint
- a failed or non-responsive recovery probe keeps the shared provider unhealthy and re-enters cooldown without thundering herd behavior

## Phase 4 - Request Event Sync

- replicate raw usage request events across peers
- dedupe by event id
- add `node_name` to requests table
- remove `cache create` column
- add batching/indexing so the requests page remains smooth under multi-node updates

Acceptance:

- requests from different computers appear in one merged table
- reconnecting peers catch up without duplicates
- requests table remains responsive during sustained cross-node ingestion

## Phase 5 - Analytics Convergence

- compute analytics from merged request/event history
- support all-node and single-node filters
- use incremental aggregation or bounded recompute so analytics remains efficient

Acceptance:

- analytics totals converge across peers after sync
- local/offline work appears after reconnect
- analytics page remains smooth without obvious CPU spikes during sync bursts

## Phase 6 - Editable State Sync

- replicate spend history manual edits
- replicate pricing timeline edits
- replicate provider metadata edits
- add revision/conflict handling for editable entities

Acceptance:

- editable usage history and pricing changes converge across peers
- provider rename, base URL, key, group, and email changes converge across peers
- conflicts resolve deterministically

## Immediate Questions

- What exact fields define `shared_provider_fingerprint` for each provider family?
- What lease timeout is safe enough to avoid duplicate quota refresh while keeping failover responsive?
- How should we classify "no response" for the single recovery probe so it predictably re-enters shared cooldown?
- Should merged requests/analytics default to all nodes or current node?
- What batching window keeps UI smooth while still feeling live enough during multi-node ingestion?
- What automatic authentication mechanism should LAN peers use for trusted replication membership?

## Non-goals

- Do not require a permanent master node.
- Do not depend on public internet exposure or third-party mesh VPN tools.
- Do not merge local session runtime lists across machines.
- Do not sync only precomputed aggregates without raw event provenance.
- Do not allow unauthenticated LAN peers to mutate shared state.

## Verification Strategy

Each phase should include:

1. multi-node repro on the same router/Wi-Fi
2. evidence of peer discovery and heartbeat expiry
3. evidence that only one node refreshes a shared quota source
4. evidence that a shared provider failure on one node propagates to the other alive nodes
5. evidence that normal traffic stops using a shared provider during shared cooldown
6. evidence that only one node performs the cooldown recovery probe after expiry
7. reconnection sync proof with no duplicate request rows
8. UI proof for local-only sessions and merged requests/analytics
9. trust proof that unauthenticated peers are ignored

## Success Criteria

The work is complete when:

- multiple LAN nodes can share the same providers without permanent central ownership
- provider objects converge by `shared_provider_id` and do not drift across alive nodes
- shared quota refresh is deduplicated per provider/key across alive nodes
- shared provider health and 10-minute cooldown converge across alive nodes
- only one alive node performs each cooldown recovery probe for a shared provider fingerprint
- normal routing stops using a shared provider while it is in shared cooldown
- offline nodes keep working locally and catch up after reconnect
- provider metadata edits converge across peers
- requests and analytics converge across nodes
- requests and analytics remain smooth under sustained multi-node updates
- sessions remain local-only and UI clearly labels cross-device request sources
- unauthenticated LAN peers cannot mutate shared state
