<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="Agent Orchestrator logo" />
</p>

# Agent Orchestrator

Rust + Tauri app that runs a local **OpenAI-compatible gateway** on a stable `base_url` (default: `http://127.0.0.1:4000`) and routes requests across multiple upstream providers (official OAuth passthrough, 3rd-party keys, etc.).

Key features (MVP):
- `wire_api = "responses"` gateway endpoint: `POST /v1/responses` (supports SSE streaming by simulating events).
- Automatic failover on upstream errors (timeouts / 5xx / 429), with cooldown.
- Conversation continuity across provider switches via local history store.
- Desktop UI (React) to view status/events and lock routing to a provider.
- Runs “in the background” (window starts hidden; tray menu can show/quit).

## One-time `codex` config

Point `codex` to the local gateway once:

```toml
model_provider = "orchestrator"

[model_providers.orchestrator]
name = "Agent Orchestrator"
base_url = "http://127.0.0.1:4000"
wire_api = "responses"
```

After that, you switch providers inside Agent Orchestrator — no more editing `codex` config.

## Run (Windows)

```powershell
npm install
npm run tauri dev
```

The app creates its config at:
- `config.toml` under the app config directory (Tauri `app_config_dir`)

## Run (Release EXE locally)

```powershell
npm install
npm run tauri build
```

Then launch via `Agent Orchestrator.cmd` at repo root (it starts `src-tauri/target/release/agent_orchestrator.exe`).

Note: `tauri build --debug` produces a debug build that can still try to load the dev server URL and may show "localhost refused to connect" if no dev server is running.

## Gateway endpoints

- `GET /health`
- `GET /status`
- `POST /v1/responses`
- `GET /v1/models` (best-effort proxy)

## Official OAuth

If the configured provider `api_key` is empty, the gateway tries to forward the client’s `Authorization` header to the upstream.
This is the least invasive way to support OAuth-based clients.
