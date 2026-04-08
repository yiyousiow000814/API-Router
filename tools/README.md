# Tools

This directory contains developer tooling only. Runtime code must stay under `src/` or `src-tauri/`.

## Layout

- `build/`: local packaging helpers for the repo-root Windows EXE workflow.
- `checks/`: repository checks that run from `npm` scripts and CI gates.
- `diagnostics/`: one-shot evidence collection helpers for local debugging.
- `benchmarks/`: ad hoc performance probes that are not part of CI.
- `windows/`: Windows-specific launch wrappers shared by other tooling.

## Main entry points

- `npm run build:root-exe`
- `npm run build:root-exe:checked`
- `npm run check:ci-local`
- `npm run debug:dump`
- `npm run bench:thread-open`

## Rules

- Do not add UI tests here. Put them under `tests/`.
- Do not add runtime diagnostics writers here. Put runtime code under `src-tauri/src/diagnostics/`.
- If a tool is only used by one test suite, keep it next to that suite instead of adding another generic helper here.
