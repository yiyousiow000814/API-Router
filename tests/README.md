# Tests

This directory contains test assets, test runners, and test-only support code.

## Layout

- `e2e/build/`: end-to-end build and restart flows used for EXE validation.
- `ui/`: UI test entry points, shared helpers, and baselines.
- `ui/e2e/codex-web/`: Codex Web interaction scenarios.
- `ui/e2e/tauri/`: Tauri desktop interaction scenarios.
- `ui/support/`: reusable test helpers shared by UI suites.
- `ui/baselines/`: checked-in comparison data used by UI assertions.

## Main entry points

- `npm run ui:check`
- `npm run ui:tauri`
- `npm run ui:e2e:codex-threadlist-scroll`
- `npm run ui:e2e:requests-reload`
- `npm run e2e:build-root-exe-restart`

## Rules

- Keep fixtures and support code close to the suite that owns them.
- Shared helpers belong in `ui/support/` only when reused by multiple suites.
- Avoid rebuilding a catch-all directory. If a new class of tests appears, add a clearly named subfolder for it.
