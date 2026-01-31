<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="API Router logo" />
</p>

# API Router

API Router is a desktop app that runs a local OpenAI-compatible gateway on a stable base URL
(default: `http://127.0.0.1:4000/v1`). You point Codex at the gateway once, then switch providers
inside the app without editing your Codex config again.

## What it does

- Routes **Responses API** requests (`POST /v1/responses`) to your chosen providers.
- Automatic failover on upstream errors (timeouts / 5xx / 429) with cooldown.
- Provider management in UI: add, rename, reorder, set keys, set usage base URL.
- Usage display is best-effort (depends on each provider’s usage endpoint).
- Runs in the background (tray icon with Show/Quit).

## Quick start (Windows)

1) Install dependencies:

```powershell
npm install
```

2) Run the app:

```powershell
npm run tauri dev
```

3) In the app, add providers and set their API keys.

4) Set the gateway token in `.codex/auth.json`:

```json
{
  "OPENAI_API_KEY": "ao_xxx..."
}
```

Notes:
- The file must be UTF-8 **without BOM** (BOM breaks JSON parsing).
- The gateway token is stored locally at `./user-data/secrets.json` (gitignored).

5) Point Codex to API Router (one-time):

```toml
model_provider = "api_router"

[model_providers.api_router]
name = "API Router"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

After this, you switch providers inside the app.

## How to use

- **Preferred provider**: choose a default target.
- **Auto mode**: the router picks a healthy provider and fails over if needed.
- **Usage base URL**: set this if the usage endpoint is on a different host.
  When empty, the usage base defaults to the provider `base_url`.

## Not supported

- Chat Completions API (this app focuses on Responses).
- Reusing official OAuth credentials for upstream providers.
- Non-Windows platforms are untested.

## Troubleshooting

- **"expected value at line 1 column 1"** in `.codex/auth.json`  
  Ensure the file is UTF-8 **without BOM**.
- **Usage shows empty or error**  
  The provider may not expose a compatible usage endpoint. Try setting a Usage base URL.
- **"localhost refused to connect"**  
  Make sure the app is running and the gateway port matches your config.

## Config & data locations

- Config: `./user-data/config.toml`
- Secrets: `./user-data/secrets.json` (gitignored)

## Build EXE (local)

```powershell
npm run build:root-exe
```

The EXE will be written to the repo root as `API Router.exe`.
