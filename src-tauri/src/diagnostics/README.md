# Diagnostics Layout

This folder is the canonical entry point for diagnostics helpers and the inventory of persisted diagnostic outputs.

## Persisted outputs

- `user-data/diagnostics/lan-peer-diagnostics.log`
  - Owner: `src-tauri/src/lan_sync.rs`
  - Purpose: LAN peer discovery, stale-prune, capability drift, heartbeat-gap, and UDP broadcast failure evidence
  - Retention: capped to the most recent 64 KB

- `user-data/diagnostics/lan-remote-update-status.json`
  - Owner: `src-tauri/src/lan_sync/remote_update.rs`
  - Purpose: canonical LAN remote update state machine snapshot and timeline
  - Retention: latest snapshot only

- `user-data/diagnostics/lan-remote-update.log`
  - Owner: `src-tauri/src/lan_sync/remote_update.rs`
  - Purpose: LAN remote update worker/bootstrap log
  - Retention: append-only current-session style log

- `user-data/diagnostics/ui-freeze-*.json`
  - Owner: `src-tauri/src/app_state.rs`
  - Purpose: UI watchdog dumps for slow refresh, long task, frame stall, and frontend error incidents
  - Retention: one file per incident

- `user-data/logs/codex-web-live.ndjson`
  - Owner: `src-tauri/src/orchestrator/gateway/web_codex_storage.rs`
  - Purpose: web codex live trace stream
  - Retention: rotated when reaching 8 MB

## Code ownership

- Shared diagnostics path and log helpers live in `src-tauri/src/diagnostics/mod.rs`.
- Feature-specific diagnostics stay close to their feature logic, but should resolve paths and persistence through this folder.
