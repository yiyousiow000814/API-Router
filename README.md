<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="API Router logo" />
</p>

# API Router

API Router is a desktop app that runs a local OpenAI-compatible gateway on a stable base URL
(default: `http://127.0.0.1:4000/v1`). You point Codex at the gateway once, then switch providers
inside the app without editing your Codex config again.

## What it does

- Routes **Responses API** requests (`POST /v1/responses`) to your chosen providers.
- Automatic failover on upstream errors (timeouts / 5xx / 429) with cooldown and a short stabilization window.
- Provider management in UI: add, rename, reorder, set keys, set usage base URL.
- Usage display is best-effort (depends on each provider's usage endpoint).
- Runs in the background (tray icon with Show/Quit).

## Quick start

1) Download the latest Windows build from GitHub Releases and run it.

2) Clone this repo and build the EXE locally:

```powershell
npm install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\build\build-root-exe.ps1
```	

The built app is written to the repo root as `API Router.exe`.

Then open the app, add providers, and set their API keys.

Set the gateway token in `.codex/auth.json`:

```json
{
  "OPENAI_API_KEY": "ao_xxx..."
}
```

Notes:
- The file must be UTF-8 **without BOM** (BOM breaks JSON parsing).
- The gateway token is stored locally at `./user-data/secrets.json` (gitignored).

Point Codex to API Router (one-time):

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
- For routing tuning (cooldown / stabilization window), edit `./user-data/config.toml`.
- **Usage base URL**: set this if the usage endpoint is on a different host.
  When empty, the usage base defaults to the provider `base_url`.
- **Sessions (Windows Terminal only)**: when you run Codex inside Windows Terminal, API Router can
  auto-detect the tab identity (`WT_SESSION`) and let you set a per-session preferred provider.
  Sessions may appear as verified or unverified (best-effort pre-discovery before the first request).
  Closed Codex sessions disappear automatically. See `docs/windows-terminal-sessions.md`.

## Platform support

- Windows only

## Not supported

- Chat Completions API (this app focuses on Responses).
- Reusing official OAuth credentials for upstream providers.
- Non-Windows platforms.

## Troubleshooting

- **"expected value at line 1 column 1"** in `.codex/auth.json`  
  Ensure the file is UTF-8 **without BOM**.
- **Usage shows empty or error**  
  The provider may not expose a compatible usage endpoint. Try setting a Usage base URL.
- **"localhost refused to connect"**  
  Make sure the app is running and the gateway port matches your config.

For terminal-first debugging surfaces, HTTP status checks, MCP access, and persisted diagnostics,
see [docs/debug-interfaces.md](docs/debug-interfaces.md).
For a one-shot local evidence bundle, run `npm run debug:dump`.

## Repo layout

- `tools/`: developer tooling grouped by responsibility. See `tools/README.md`.
- `tests/`: UI/E2E runners, support code, and baselines. See `tests/README.md`.
- `src-tauri/src/diagnostics/`: runtime diagnostics helpers and notes for persisted evidence.

## Config & data locations

- Config: `./user-data/config.toml`
- Secrets: `./user-data/secrets.json` (gitignored)

### Test profile (isolated app data)

If your main app is running and you want safe manual testing without touching production data,
you can use either approach:

1) Set profile env var:

```powershell
$env:API_ROUTER_PROFILE='test'
.\API Router.exe
```

2) Or rename/copy EXE to include `[TEST]` (for example `API Router [TEST].exe`) and run it directly.
   When the executable name contains `[TEST]`, API Router auto-uses `test` profile.

Behavior:
- Uses isolated data directory: `%APPDATA%/com.api-router.app/user-data-test`
- Uses isolated Codex home under that profile directory
- Allows running alongside your default profile instance
- Starts from a clean test dataset every launch (safe for repeated manual test cycles)
- Auto-seeds mock providers/history/events on launch so Usage and Daily History are immediately testable

Reset to normal mode:

```powershell
Remove-Item Env:API_ROUTER_PROFILE
```
