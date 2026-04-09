# Debug Interfaces

This document is the single entry point for API Router operational checks, debug endpoints, MCP access, persisted diagnostics, and the one-shot debug dump workflow.

## What exists

API Router exposes three different debug surfaces:

1. HTTP endpoints on the local gateway
2. Persisted diagnostics files under `user-data`
3. The minimal MCP server in `mcp/`

`MCP` is not the whole story. It is a thin tool wrapper around a subset of the local gateway and config operations. For direct troubleshooting from a terminal, HTTP + diagnostics files are usually the fastest path.

## Default local base URLs

- Gateway health/status base: `http://127.0.0.1:4000`
- OpenAI-compatible base: `http://127.0.0.1:4000/v1`

If the configured listen port changes, replace `4000` with the current port.

## Data locations by profile

Default local development layout is repo-local:

- `.\user-data\config.toml`
- `.\user-data\secrets.json`
- `.\user-data\data\...`
- `.\user-data\diagnostics\...`

Test profile uses:

- `.\user-data-test\...` for isolated test-profile runtime when applicable

Installed app runtime may also use the per-app profile directory resolved by the app. If in doubt, check:

```powershell
$env:API_ROUTER_USER_DATA_DIR
```

If that variable is set for the running process, diagnostics should be read from that directory first.

## HTTP debug endpoints

### `GET /health`

Small liveness probe.

PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/health
```

### `GET /status`

Primary machine-readable runtime snapshot for terminal debugging.

Includes:

- listen host/port
- preferred provider and manual override
- provider runtime states
- recent error events
- quota and ledgers
- LAN sync snapshot
- Windows firewall snapshot

PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/status | ConvertTo-Json -Depth 12
```

Save to a file:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/status | ConvertTo-Json -Depth 12 | Set-Content .\status.json
```

Important:

- This HTTP `/status` is the lightweight gateway status.
- The more detailed app-side status used by the desktop UI comes from the Tauri command `get_status` in [status_snapshot.rs](C:\Users\yiyou\API-Router\src-tauri\src\commands\status_snapshot.rs). That richer command is not currently exposed as a general CLI endpoint.
- If you need a quick snapshot bundle, prefer `npm run debug:dump` over manually saving `/status`.

### `POST /lan-sync/remote-update`

Trusted LAN peer endpoint for requesting a remote self-update.

This is an internal/trusted endpoint, not a public local-debug endpoint.

### `POST /lan-sync/debug/remote-update`

Trusted LAN peer debug endpoint for remote update state.

Returns:

- readiness
- remote update status snapshot
- status/log file paths
- log tail
- worker bootstrap observed flag
- worker script probe
- local build identity
- local version sync snapshot

This endpoint requires LAN auth headers and is intended for trusted peer-to-peer debugging, not generic localhost inspection.

Required headers:

- `x-api-router-lan-node-id`
- `x-api-router-lan-secret`

The request `node_id` must already be trusted, or the endpoint returns `401`.

## Persisted diagnostics files

Most developer-facing diagnostics live under:

- `user-data/diagnostics/`

Current important files:

- `user-data/diagnostics/lan-peer-diagnostics.log`
  - LAN peer discovery, stale prune, heartbeat gap, capability drift, UDP send failures
  - capped to recent 64 KB

- `user-data/diagnostics/lan-remote-update-status.json`
  - canonical LAN remote update state machine snapshot

- `user-data/diagnostics/lan-remote-update.log`
  - LAN remote update worker log

- `user-data/diagnostics/ui-freeze-*.json`
  - UI watchdog dumps for slow refresh, long task, frame stall, frontend error

- `user-data/app-startup.json`
  - app startup stage progression

- `user-data/logs/codex-web-live.ndjson`
  - codex live trace stream

Related code inventory:

- Shared path/log helpers: [mod.rs](C:\Users\yiyou\API-Router\src-tauri\src\diagnostics\mod.rs)
- Diagnostics file inventory: [README.md](C:\Users\yiyou\API-Router\src-tauri\src\diagnostics\README.md)

### Terminal examples

Tail LAN peer diagnostics:

```powershell
Get-Content .\user-data\diagnostics\lan-peer-diagnostics.log -Tail 200
```

Watch LAN peer diagnostics live:

```powershell
Get-Content .\user-data\diagnostics\lan-peer-diagnostics.log -Wait
```

Read remote update status JSON:

```powershell
Get-Content .\user-data\diagnostics\lan-remote-update-status.json -Raw
```

Read startup diagnostics:

```powershell
Get-Content .\user-data\app-startup.json -Raw
```

Read codex live trace tail:

```powershell
Get-Content .\user-data\logs\codex-web-live.ndjson -Tail 100
```

## One-shot debug dump

Use this when you want a single folder with the most important runtime evidence.

Run:

```powershell
npm run debug:dump
```

This writes a timestamped folder in the repo root such as:

- `debug-dump-20260407-221530`

Contents:

- `summary.json`
- `health.json` if reachable
- `status.json` if reachable
- copied diagnostics files when present
- up to the 10 newest `ui-freeze-*.json` dumps

Direct script usage:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/diagnostics/debug-dump.ps1
```

Custom base URL:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/diagnostics/debug-dump.ps1 -BaseUrl http://127.0.0.1:4010
```

Custom user-data directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/diagnostics/debug-dump.ps1 -UserDataDir C:\path\to\user-data
```

## MCP server

The repo contains a minimal MCP server at [README.md](C:\Users\yiyou\API-Router\mcp\README.md).

Its purpose is to give MCP clients a small toolset for:

- `ao.health`
- `ao.status`
- `ao.config.get`
- selected config mutations
- safe predefined dev commands

Build:

```powershell
cargo build --release --manifest-path mcp/Cargo.toml
```

Optional user-data override:

```powershell
$env:AO_USER_DATA_DIR = "C:\path\to\user-data"
```

Important:

- MCP here is stdio JSON-RPC, mainly for agent/client integration.
- For human troubleshooting in a terminal, hitting `/status` and reading diagnostics files is usually simpler than speaking MCP directly.
- MCP currently covers only a subset of what you need during incident response.

## Recommended incident workflow

When something looks wrong in the UI but the root cause is unclear:

1. Run `npm run debug:dump`.
2. Open `summary.json` first to see what was reachable and what files were present.
3. If the issue is gateway/provider state, inspect `status.json`.
4. If the issue is LAN peer flapping, inspect `diagnostics/lan-peer-diagnostics.log`.
5. If the issue is LAN remote update, inspect both `diagnostics/lan-remote-update-status.json` and `diagnostics/lan-remote-update.log`.
6. If the issue is UI freeze or missing refreshes, inspect the newest `diagnostics/ui-freeze-*.json`.

## Current gap

There is now a unified document and a one-shot dump script, but there is still no authenticated local CLI for the richer app-side `get_status` Tauri command.

If that becomes necessary, the next step should be a dedicated local debug command that exposes the richer desktop-only status snapshot without requiring the UI.
