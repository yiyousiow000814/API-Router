# Web Codex Runtime Modes

## Why there are two ports

- `5173` is the Vite development server (frontend hot reload).
- `4000` is the API Router gateway (Rust backend / app runtime).

## URLs

- Dev hot-reload Web Codex: `http://127.0.0.1:5173/codex-web`
- Dev hot-reload sandbox (read-only): `http://127.0.0.1:5173/sandbox/codex-web`
- App/runtime Web Codex: `http://127.0.0.1:4000/codex-web`

## Important note for the preview URL

- `http://127.0.0.1:5173/codex-web` only works when the Vite dev server is running.
- Start it with `npm run dev` before opening the preview URL.
- If Vite is not running, use the app/runtime URL on port `4000` instead.

## Expected behavior

- In **dev** (`5173/codex-web`), frontend changes update immediately via Vite HMR.
- In **app/runtime** (`4000/codex-web`), changes to embedded assets require rebuilding/restarting the Rust app.

## What “Rust include” means

The app runtime serves Web Codex assets via Rust constants:

- `WEB_CODEX_INDEX_HTML = include_str!("../../../../codex-web.html")`
- `WEB_CODEX_APP_JS = include_str!("../../../../src/ui/codex-web-dev.js")`

`include_str!` embeds file contents into the compiled binary at build time.  
That is why runtime UI changes are not visible until you rebuild/restart.

## Development workflow (recommended)

1. Start API Router backend (gateway) on `4000`.
2. Start Vite dev server on `5173`.
3. Open `http://127.0.0.1:5173/codex-web` for hot-reload UI work.
4. When ready to ship, rebuild app/runtime and verify `http://127.0.0.1:4000/codex-web`.
