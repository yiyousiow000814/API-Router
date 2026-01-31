<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="API Router logo" />
</p>

# API Router

Desktop app that runs a local **OpenAI-compatible gateway** on a stable `base_url` (default: `http://127.0.0.1:4000/v1`) and routes requests across multiple upstream providers.

Key features (MVP):
- `wire_api = "responses"` gateway endpoint: `POST /v1/responses` (supports SSE streaming by simulating events).
- Automatic failover on upstream errors (timeouts / 5xx / 429), with cooldown.
- Conversation continuity across provider switches by replaying Codex session history when an upstream rejects `previous_response_id` (reads `.codex/sessions/*.jsonl`).
- Desktop UI (React) to view status/events and lock routing to a provider.
- Runs “in the background” (window starts hidden; tray menu can show/quit).
- Provider management: rename, reorder, usage refresh, per-provider usage base URL.

## One-time `codex` config

Point `codex` to the local gateway once:

```toml
model_provider = "api_router"

[model_providers.api_router]
name = "API Router"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

After that, you switch providers inside API Router — no more editing `codex` config.

## Gateway token (required)

Set the gateway token in `.codex/auth.json` so Codex can call the local gateway:

```json
{
  "OPENAI_API_KEY": "ao_xxx..."
}
```

Notes:
- The file must be UTF-8 without BOM (BOM will break JSON parsing).
- The gateway token is stored locally at `./user-data/secrets.json` (gitignored).

## Run (Windows)

```powershell
npm install
npm run tauri dev
```

The app creates its config at:
- `./user-data/config.toml` next to the executable (gitignored)

## Run (Release EXE locally)

```powershell
npm install
npm run build:root-exe
```

Then launch `API Router.exe` at repo root.

Note: `tauri build --debug` produces a debug build that can still try to load the dev server URL and may show "localhost refused to connect" if no dev server is running.

## Gateway endpoints

- `GET /health`
- `GET /status`
- `POST /v1/responses`
- `GET /v1/models` (best-effort proxy)

## Official OAuth

The local gateway requires its own token (stored in `./user-data/secrets.json`) so the localhost base_url is not exposed to other processes.
Because clients authenticate to the gateway using this token, the gateway cannot automatically reuse the client's OAuth credentials for the upstream.

Official upstream support currently requires an API key configured in the app, or a future built-in OAuth flow.

## Usage / quota display

Usage display is best-effort and depends on the upstream exposing a compatible usage endpoint.
If an upstream's usage API lives on a different host than the OpenAI-compatible `base_url`, set a per-provider "Usage base URL" in the UI.
When empty, the usage base defaults to the provider `base_url`.
