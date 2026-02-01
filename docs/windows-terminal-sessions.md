# Windows Terminal Sessions (Windows Only)

API Router can show a **Sessions** table and let you set a **per-session preferred provider**.
This is designed for running multiple Codex instances in different Windows Terminal tabs.

## What "Session" Means

There are two identifiers:

- **WT_SESSION** (Windows Terminal): stable per tab/pane session.
- **Codex session id**: the id shown in the Codex banner (when available from requests).

In the UI, the Sessions table uses **Codex session id** as the primary label (and shows WT_SESSION in a tooltip)
so multiple concurrent Codex instances are easier to distinguish.

## How Auto-Detection Works

On Windows, the gateway infers WT_SESSION without requiring you to modify PowerShell profiles or Codex configs:

1. Capture the incoming request peer address/port (loopback).
2. Map the loopback TCP connection to the owning client **PID** via `GetExtendedTcpTable`.
3. Read the client process environment block via the PEB and extract `WT_SESSION`.

This logic lives in reusable platform helpers:

- `src-tauri/src/platform/windows_loopback_peer.rs` (loopback TCP -> PID, PID liveness, process env var read)
- `src-tauri/src/platform/windows_terminal.rs` (WT_SESSION inference wrapper)

## Active / Idle / Disappear

- **active**: last seen within ~60 seconds.
- **idle**: last seen is older than ~60 seconds.
- **disappear**: if the underlying PID exits (e.g. you Ctrl+C Codex), the session row is removed on the next UI refresh.

Note: only the runtime list is pruned. Your configured per-session preference mapping is persisted in `config.toml`.

## Limitations

- This feature is **Windows-only**.
- WSL2 is not supported for session mapping yet (a Codex process inside WSL2 is not trivially attributable to a Windows Terminal tab).

