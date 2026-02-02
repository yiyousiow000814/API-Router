# Windows Terminal Sessions (Windows Only)

API Router can show a **Sessions** table and let you set a **per-session preferred provider**.
This is designed for running multiple Codex instances in different Windows Terminal tabs.

## What "Session" Means

There are two identifiers:

- **WT_SESSION** (Windows Terminal): stable per tab/pane session.
- **Codex session id**: the id shown in the Codex banner. This is often available from
  `codex.exe resume <uuid>` and can also be inferred from Codex session rollout files.

In the UI, the Sessions table shows **Codex session id** (and keeps WT_SESSION as the internal stable key).
This makes it easier to distinguish multiple concurrent Codex instances.

## How Auto-Detection Works

On Windows, the gateway infers WT_SESSION without requiring you to modify PowerShell profiles or Codex configs:

1. Capture the incoming request peer address/port (loopback).
2. Map the loopback TCP connection to the owning client **PID** via `GetExtendedTcpTable`.
3. Read the client process environment block via the PEB and extract `WT_SESSION`.

This logic lives in reusable platform helpers:

- `src-tauri/src/platform/windows_loopback_peer.rs` (loopback TCP -> PID, PID liveness, process env var read)
- `src-tauri/src/platform/windows_terminal.rs` (WT_SESSION inference wrapper)

## Verified vs Unverified (Pre-Discovery)

API Router supports a best-effort "pre-discovery" scan (Windows only): it can list Codex sessions that exist in
Windows Terminal even before the first request hits the gateway.

Because the app cannot always prove the effective `base_url` of a running Codex process (Codex freezes config at
process start and does not always record `base_url` in session metadata), sessions are shown in two states:

- **verified**: API Router has strong evidence the session is using the gateway (for example, the session has
  sent at least one request through the gateway).
- **unverified**: API Router has discovered a Codex process, but cannot confirm its effective `base_url` yet.

Unverified sessions are typically hidden behind a collapsible row inside the Sessions table.

## Active / Idle / Disappear

- **active**: last seen within ~60 seconds.
- **idle**: last seen is older than ~60 seconds.
- **disappear**: if the underlying PID exits (e.g. you Ctrl+C Codex), the session row is removed on the next UI refresh.

Note: only the runtime list is pruned. Your configured per-session preference mapping is persisted in `config.toml`.

## Columns (Quick Guide)

- **Codex provider**: the model_provider id reported by Codex session metadata (may be missing or misleading; it is
  not the source of truth for the gateway decision).
- **Routing provider**: the provider API Router would route to for that session (session override or global preferred).
- **Preferred provider**: per-session override setting (only enabled for verified sessions).

## Limitations

- This feature is **Windows-only**.
- WSL2 is not supported for session mapping yet (a Codex process inside WSL2 is not trivially attributable to a Windows Terminal tab).

## Why a Session Can Stay Unverified

If a Codex process never sends a request through API Router (because it is configured with a different `base_url`,
or because it has not made any model call yet), API Router cannot confirm it is using the gateway. In that case,
the session will remain unverified.
