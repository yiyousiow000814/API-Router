# Remote Monitoring — Implementation Design Spec

## Status

**2026-04-14** — Draft for review

## Goal

Complete the remaining implementation for the remote monitoring design (PR #173). The design doc at `docs/remote-monitoring-design.md` defines the three-layer diagnostic model and monitoring page requirements. This spec covers the implementation details not yet in the PR.

## Confirmed Navigation Structure

```
Dashboard | Requests | Analytics | Provider Switchboard | Events | More ▾  [Help]
```

- 5 primary tabs (unchanged from existing)
- **More ▾** dropdown contains: Web Codex, Getting Started, **Monitor**
- **Monitor** links to the full Monitoring page
- Events tab stays primary (important for monitoring/alerting)
- Help button on far right

**Why this structure:**
- Monitoring and Web Codex are secondary/diagnostic tools, not daily-use pages
- Events is primary because it surfaces abnormal conditions
- Nav stays compact at 5 tabs + More + Help
- More dropdown follows standard UI convention (YouTube, GitHub, Vercel)

## Monitoring Page

### Route

The Monitoring page renders when the user selects "Monitor" from the More ▾ dropdown. It replaces the main content area (same as other tab pages), replacing Dashboard content with the monitoring workstation.

### Layout

Single scrollable page, no sub-tabs. Sections:

```
┌─ Monitoring ──────────────────────────────────────────────────────────────┐
│                                                                           │
│  Local Node                                    Last refresh: 12:34:56 ↻  │
│  ─────────────────────────────────────────────────────────────────────  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│  │ ● Tailscale│ │ ○ Websock│ │ ● Watchdog│ │ ● LAN    │                   │
│  │   ok     │ │  1 issue │ │   ok     │ │   ok     │                   │
│  │           │ │   [→]    │ │           │ │           │                   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                   │
│                                                                           │
│  Active Abnormal Conditions (2)                                           │
│  ─────────────────────────────────────────────────────────────────────  │
│  ○ ws: reconnect loop detected · 12s ago · WebSocket                    │
│  ○ ws: HTTP fallback degraded · 2m ago · HTTP Failover                  │
│                                                                           │
│  Remote Peers (2)                                         [Fetch All ▸] │
│  ─────────────────────────────────────────────────────────────────────  │
│  NODE-B · 192.168.1.42 · 3 min ago                  ● Tailscale ok     │
│                                                         ○ Websock 1 issue│
│                                                         [Fetch ▸]         │
│  NODE-A · 192.168.1.17 · 12s ago                 ● all ok              │
│                                                         [Fetch ▸]         │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Sections

**1. Local Node — domain cards grid**

One card per diagnostic domain:

| Domain | Source | Events to record |
|--------|--------|-----------------|
| `tailscale` | `tailscale_diagnostics.rs` (existing) | installed, connected, gateway reachable, bootstrap stages |
| `codex_web_transport` | New — WebSocket + HTTP failover events | ws open/close/error, reconnect attempts, HTTP fallback, thread poll failures |
| `watchdog` | `diagnostics/mod.rs` | health, last incident kind/summary, incident count |
| `lan_peer` | `lan_sync/shared_health.rs` (existing broadcast) | peer heartbeat stability |

Each card shows:
- Status dot: green (ok), amber (warning), red (abnormal)
- Domain name
- Brief status text (1 line)
- Expand button to show detail

**2. Active Abnormal Conditions**

List of currently active abnormal states. Each entry:
- Severity dot (amber/red)
- Summary text
- Domain label
- Time since observed
- "View Details →" link to expand raw event

Empty state: "No active abnormal conditions" with a green checkmark.

**3. Remote Peers**

List of discovered LAN peers from `lan_sync`. For each peer:
- Node name and address
- Last heartbeat timestamp
- Per-domain status dots (same domains as local)
- "Fetch ▸" button to pull detailed diagnostics from that peer

"Fetch All ▸" initiates parallel fetch to all live peers.

Fetched data populates peer cards with detailed diagnostics in a slide-over detail panel.

**4. Detail Panel (slide-over)**

When user clicks "View Details →" on any entry, a slide-over panel opens from the right (40% width) showing:
- Full event timeline for the domain
- Raw event JSON (copyable)
- PR 161 tailscale recovery checklist (for tailscale domain)
- Recent transport failures (for codex_web_transport domain)

Close via X button or Escape key.

## Codebase Changes

### Phase 1 — `codex_web_transport` Event Store (Backend)

**New file:** `src-tauri/src/diagnostics/codex_web_transport.rs`

Module handles WebSocket and HTTP failover event recording. Uses the same event-store pattern as `tailscale_diagnostics.rs`.

Events to record (bounded snapshot store, not rolling log):

```
codex_web_transport_events.json
{
  "ws_open_observed": { "last": timestamp, "count": N },
  "ws_error_observed": { "last": timestamp, "count": N, "latest_error": "..." },
  "ws_close_observed": { "last": timestamp, "count": N, "latest_close_code": N },
  "ws_reconnect_scheduled": { "last": timestamp, "count": N },
  "ws_reconnect_attempted": { "last": timestamp, "count": N },
  "http_fallback_engaged": { "last": timestamp, "count": N, "latest_route": "..." },
  "thread_refresh_failed": { "last": timestamp, "count": N },
  "active_thread_poll_failed": { "last": timestamp, "count": N },
  "live_notification_gap_observed": { "last": timestamp, "count": N }
}
```

Wire frontend WebSocket events into backend: Tauri command `record_web_transport_event` called from frontend `WebCodexPanel` when reconnect, error, or failover events occur.

### Phase 2 — LAN Diagnostic Fetch (Backend)

**New file:** `src-tauri/src/diagnostics/lan_fetch.rs`

Implements remote diagnostic fetch via existing LAN UDP broadcast channel:

1. **Broadcast request**: send diagnostic fetch request to target peer via `lan_sync` UDP channel
2. **Receive response**: peer responds with its local diagnostic snapshot
3. **Store result**: cache remote diagnostics in memory with TTL (30s)

New Tauri command:
```
get_remote_peer_diagnostics(peer_node_id: String, domains: Vec<String>) -> RemotePeerDiagnostics
```

Response shape:
```rust
struct RemotePeerDiagnostics {
    node_id: String,
    node_name: String,
    fetched_at_unix_ms: u64,
    domains: HashMap<String, DiagnosticDomainSnapshot>,
}
```

### Phase 3 — Monitoring Page (Frontend)

**New file:** `src/ui/components/MonitoringPanel.tsx`

Replaces main content area when Monitor page is active. Consumes Tauri commands:
- `get_local_diagnostics` — returns all local domain snapshots
- `get_remote_peer_diagnostics` — fetches from a specific peer
- `get_status` (existing) — peer list, heartbeat timestamps

**New Tauri commands:**
```
get_local_diagnostics() -> LocalDiagnosticsSummary
record_web_transport_event(event: WebTransportEvent)
```

### Navigation Changes

1. **AppTopNav.tsx**: Add "More" dropdown button
   - Dropdown renders below the "Events" tab
   - Items: Web Codex, Getting Started, **Monitor**
   - Monitor item has an icon

2. **App.tsx**: Add `monitor` page to `TopPage` type and switch/case

3. **More dropdown**: implement as a simple positioned dropdown (no library dependency — follow existing modal patterns)

### Testing

- `npm run check:ci-local` must pass
- Unit tests for new `codex_web_transport.rs` event parsing
- Unit tests for `get_remote_peer_diagnostics` command
- Component tests for `MonitoringPanel.tsx` basic rendering

## Non-Goals (unchanged from design doc)

- Full remote machine inspection
- Continuous streaming of all runtime state to peers
- Unbounded append-only logs
- Generic event log as the only monitoring UI

## Implementation Order

1. Add `codex_web_transport` event store + `record_web_transport_event` Tauri command
2. Add `get_local_diagnostics` Tauri command merging all domain snapshots
3. Add `get_remote_peer_diagnostics` Tauri command
4. Add More dropdown to AppTopNav
5. Add Monitor page to App.tsx routing
6. Implement MonitoringPanel.tsx
7. Wire frontend WebSocket events to backend
8. Run tests, verify `npm run check:ci-local`
