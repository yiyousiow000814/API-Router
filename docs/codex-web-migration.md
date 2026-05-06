# Codex Web Migration

## Current Direction

`0xcaff/codex-web` has been imported into this repository as the new baseline at:

- `third_party/codex-web`

This is not meant to stay as an untouched external dependency forever. It is the new starting point for replacing the old self-built Web Codex implementation.

## What This Means

- Keep `/codex-web` as the public path.
- Stop growing the old self-built `codex-web.html` + `src/ui/modules/codex-web/*` implementation.
- Use `third_party/codex-web` as the new code base that will be rewired into API Router.
- Add Router-specific behavior later by modifying this imported code in-place.

## Phase 1 Status

Phase 1 is intentionally limited:

- Imported upstream code into `third_party/codex-web`
- Added a sync helper: `npm run vendor:codex-web:sync`
- Updated checked-build freshness logic so changes under `third_party/codex-web` invalidate the cached build state

Phase 1 does not yet:

- Replace the current runtime `/codex-web` handler
- Remove the old embedded Rust asset path
- Add provider UI to the imported code

## Next Required Integration Steps

1. Decide how API Router will host the imported app at runtime.
2. Replace the current Rust-embedded `/codex-web` asset serving path.
3. Connect imported Codex Web to API Router's existing `/codex/*` backend routes.
4. Add Router-owned UI only where upstream does not already provide an equivalent.

## Why This Is Split Into Phases

The imported upstream app currently assumes its own asset preparation flow and Electron/WebSocket bridge. The existing API Router runtime serves a completely different self-built asset graph embedded into Rust with `include_str!`.

Those are different systems. Replacing the runtime path safely requires explicit integration work, not just copying files.
