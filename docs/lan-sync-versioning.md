# LAN Sync Versioning

Canonical version definitions live in [src-tauri/src/lan_sync/versioning.rs](../src-tauri/src/lan_sync/versioning.rs).

## What is versioned

- `capability` versions:
  advertised in LAN heartbeat strings like `heartbeat_v1`
- `sync contract` versions:
  advertised per domain like `usage_history_v4`

## Bump rules

- Bump a capability version when a peer-facing feature, route, or transport behavior changes incompatibly.
- Bump a sync contract version when mixed-version peers could disagree on payload meaning, source of truth, replay behavior, projection behavior, or merge semantics.
- If unsure, bump the version. A temporary sync pause is safer than silent divergence.

## Required update flow

1. Change the canonical version entry in `versioning.rs`.
2. Keep or update the bump-rule comment beside that entry.
3. Update or add regression tests that prove the new version is exposed and mixed-version peers block correctly when required.
4. Open LAN / Sync Diagnostics and confirm `Versions` shows the expected local entries.

## Diagnostics

- `Current machine` now renders a unified `Versions` list.
- Each peer renders its own `Versions` list from the heartbeat-advertised capabilities and sync contracts it sent.
- The UI should be treated as a quick audit surface for version skew before debugging follow/sync behavior.
