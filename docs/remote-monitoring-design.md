# Remote Monitoring Design

## Goal

Provide a trustworthy monitoring system for local and remote API Router nodes without turning LAN sync into a hidden machine-state collector.

The system must answer these questions:

- Did PR 161 actually recover Tailscale automatically on the remote node?
- If WebSocket reconnect loops happen, why did they happen?
- Did HTTP failover activate, and did it work?
- Did watchdog or other self-checks detect abnormal conditions?
- Can one node inspect another node's abnormal state without TeamViewer?

## Design Principles

- Default LAN heartbeats stay minimal and non-invasive.
- Sensitive runtime details are not continuously broadcast.
- Each node records its own self-diagnostics locally.
- Remote peers fetch diagnostics only when the operator explicitly requests them or when the node decides an abnormal condition should be shared.
- Diagnostics storage is bounded and structured around problem-specific state, not unbounded logs.

## Diagnostic Model

Split monitoring into three layers.

### 1. Local self-diagnostics

Each node writes its own bounded diagnostic state to `user-data/diagnostics/`.

This includes:

- `watchdog` incidents
- `codex-web ws/failover` incidents
- `lan peer` instability incidents
- `tailscale recovery` milestone events
- `remote update` state machine data

### 2. Event snapshot stores

For flows where history matters but full logs are excessive, use event snapshots instead of rolling generic logs.

Examples:

- `tailscale_recovery_events.json`
- `codex_web_transport_events.json`
- `watchdog_health_events.json`

Each store should track:

- whether a milestone/incident has happened
- latest detail for that event
- latest transition value when needed
- first/last observed timestamps only when required for debugging

### 3. Remote diagnostics fetch

LAN peers expose a diagnostic summary endpoint and a detailed fetch endpoint.

Recommended shape:

- `GET /lan/diagnostics/summary`
- `GET /lan/diagnostics/report?domains=tailscale,watchdog,codex_web_transport`

These endpoints should return bounded summaries only.

## PR 161 Verification

To verify whether PR 161 worked, generic health checks are not enough.

Add a dedicated `tailscale recovery` event store on each node.

Suggested events:

- `tailscale_installed_observed`
- `tailscale_connected_observed`
- `tailscale_ipv4_observed`
- `runtime_bind_attempted`
- `runtime_bind_succeeded`
- `runtime_bind_failed`
- `gateway_reachable_observed`
- `restart_hint_observed`
- `ready_observed`

Suggested extra fields:

- `latest_ipv4`
- `latest_bind_failure`
- `latest_probe_failure`
- `latest_ready_state`

This lets operators answer:

- did the machine ever reach `tailscale ready`
- did runtime bind run
- did bind fail
- did reachability ever become true

without needing continuous raw state streaming.

## WebSocket And Failover Monitoring

Current codex-web reconnect state is mostly frontend-only. That is insufficient because operators can see reconnect loops but cannot see the reason remotely.

Introduce a `codex_web_transport` diagnostic domain.

Suggested events:

- `ws_open_observed`
- `ws_error_observed`
- `ws_close_observed`
- `ws_reconnect_scheduled`
- `ws_reconnect_attempted`
- `http_fallback_engaged`
- `thread_refresh_failed`
- `active_thread_poll_failed`
- `live_notification_gap_observed`

Suggested detail fields:

- `close_code`
- `close_reason`
- `was_clean`
- `requested_workspace`
- `http_route`
- `http_status`
- `error_message`
- `failover_active`

This domain should bridge frontend live debug events into a bounded backend diagnostic sink so they become remotely inspectable.

## Watchdog Monitoring

Watchdog should publish a normalized health summary instead of forcing operators to inspect scattered dump files.

Recommended `watchdog` summary fields:

- `healthy`
- `last_incident_kind`
- `last_incident_summary`
- `last_incident_dump_path`
- `incident_count_by_kind`
- `recent_recovery_observed`

The existing dump files remain useful for deep inspection, but the summary should make abnormal situations visible on a page immediately.

## Automatic Abnormal Sharing

Not every status should be shared. Only abnormal conditions should be surfaced automatically.

Recommended rule:

- normal states remain local unless explicitly fetched
- abnormal states publish a compact peer-visible summary

Examples of automatically shared abnormal states:

- watchdog incident active
- repeated websocket reconnecting
- HTTP fallback failing
- tailscale recovery stuck after bind failure
- LAN peer heartbeat instability above threshold
- remote update worker failed

Suggested peer-visible summary fields:

- `domain`
- `severity`
- `summary`
- `active`
- `sticky_until_cleared`

This gives operators a useful overview without exposing full local state by default.

## Monitoring Page

Add a dedicated monitoring page instead of burying diagnostics in the event log.

Recommended sections:

### Overview

- local node health
- peer count
- active abnormal conditions
- last refresh time

### Local Node

- watchdog status
- codex-web transport status
- tailscale recovery status
- remote update status
- LAN peer diagnostics summary

### Remote Nodes

One card per peer showing:

- node name
- trust status
- build match state
- active abnormal badges
- last heartbeat
- quick actions: `Fetch diagnostics`, `Run self diagnose`

### Detail Drawer

For a selected node, show:

- summary diagnostics by domain
- PR 161 tailscale recovery event checklist
- recent transport failures
- watchdog incident summary
- raw diagnostic payload JSON for copy/export

## Implementation Order

### Phase 1

- add a shared diagnostics event-store helper in `src-tauri/src/diagnostics/`
- add `tailscale_recovery` event store
- add `codex_web_transport` event store
- add read endpoints for local diagnostics

### Phase 2

- add LAN debug endpoint to fetch remote diagnostic summaries
- expose abnormal summaries in peer snapshot/status responses
- wire codex-web frontend reconnect/failover failures into backend diagnostics

### Phase 3

- add a dedicated monitoring page in the UI
- show local plus remote abnormal summaries
- add manual `Run self diagnose` action

## Non-Goals

- full remote machine inspection
- continuous streaming of all runtime state to peers
- unbounded append-only logs for every feature
- using generic event log as the only monitoring UI

## Expected Outcome

After this system is implemented:

- operators can verify whether PR 161 really fixed late Tailscale recovery
- reconnect loops become diagnosable
- failover failures stop being silent
- watchdog incidents are visible in one place
- remote node issues can be inspected without TeamViewer
