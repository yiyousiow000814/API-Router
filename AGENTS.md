# API Router - Agents Documentation

## Agent Defaults (Repository-Wide)
- **Document language**: Write instructions in English. Examples may include other languages when clarity improves.
- **Replies**: Default to Simplified Chinese. If a request is prefixed with `[EN]`, respond in English.
- **Terminology**: Do not translate proper nouns such as `Tauri`, `Rust`, `Codex`, `OpenAI`, or provider names.
- **Date/Time format**: Always use day-month-year ordering; never use month-day-year in outputs or docs.
- **Agent capacity fallback**: If spawning a new agent fails because capacity is full, first clean up agents that are not actively in progress/in use, then retry spawning.

## Git / GitHub Workflow
- **Branch-first**: Never commit directly to `main`. Use branches such as `feat/*`, `fix/*`, `docs/*`, `chore/*`.
- **PR-first**: Ship changes through a pull request (default to draft).
- **No PR comments** unless explicitly requested.
- **Titles**: PR and issue titles stay in English. Descriptions and regular comments default to Simplified Chinese (unless `[EN]`).
- **PR title prefix**: PR titles must start with one of `feat:`, `fix:`, `docs:`, `chore:`.
- **PR title length**: Keep PR titles at 8 words or fewer. Avoid symbols like `+` in titles.
- **PR body format**: PR bodies must include `## What`, `## Why`, `## Changes`, `## Verify`. If the PR is long, add `## TL;DR` at the very top.
- **PR summary scope**: Titles and bodies must describe the overall changes relative to `main`, not just the latest commit.
- **Resolve review threads**: After addressing review comments, resolve the corresponding review conversations (click "Resolve conversation").
- **Format before commit**: Ensure formatting checks pass before committing.
- **PowerShell gotcha**: When using `gh pr create` / `gh pr edit` in PowerShell, avoid Markdown inline code using backticks (PowerShell uses backtick as an escape). Prefer plain text, single-quoted strings, or a here-string (`@' ... '@`).

## Safety & Data Handling
- **Never commit secrets**: API keys, OAuth tokens, cookies, browser profiles, or raw conversation logs.
- **Key storage**: Provider API keys must be stored in `user-data/secrets.json` (gitignored), not in `config.toml`.
- **Artifacts**: Do not commit binaries (`.exe`, `.msi`, installers). Publish binaries via GitHub Releases assets.
- **Do not run**: `Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force` (interrupts Codex).
- **Auth JSON encoding**: `.codex/auth.json` must be UTF-8 without BOM; BOM causes JSON parse errors like "expected value at line 1 column 1".

## Engineering Constraints
- **Cross-platform**: Keep the gateway and tooling compatible with Windows + Linux (WSL2) at minimum.
- **Evidence requirement**: Back conclusions with reproducible commands or steps (state A → change → state B).
- **Test-first fix flow**: When adding tests or fixing bugs, always follow this sequence: (1) create a reproducible test, (2) verify it fails on current code, (3) implement the fix, (4) verify the test passes.
- **Line endings**: Use LF as the repository standard. CRLF is only allowed for Windows script files (`.bat`, `.cmd`, `.ps1`).
- **File size guideline (industry style)**: Prefer small, focused files (roughly 200-500 lines) when practical.
- **Hard cap**: For non-lock source files, 800 lines is the maximum. If a file goes over 800 lines, split it into coherent modules/files in the same PR unless there is a clear, documented reason not to.
- **Exceptions**: Lock/generated files are excluded from this rule (for example `Cargo.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`).


## Canonical Implementation Policy (Breaking Changes Allowed)

- **No retrofit smell**: after the change, the codebase MUST appear as if the feature existed from day one—consistent naming, structure, ownership boundaries, and data flow; no scaffolding, transitional glue, or compatibility artifacts.
- **Single canonical path:** All changes MUST be implemented in the **primary codepath** as the **only** canonical implementation.
- **Remove legacy:** Delete any **legacy / dead / duplicate** implementations. Do not keep parallel codepaths.
- **No long-term compatibility:** Do NOT keep parallel implementations or long-lived compatibility layers. If external inputs vary, normalize them into one canonical internal shape and remove legacy handling as soon as possible.
- **Breaking data changes are OK:** Destructive data changes are permitted. If the data model changes, **re-seed or migrate**; do NOT parse or support legacy formats.
- **First-class integrations preferred:** Use direct, first-class integrations where feasible. Avoid shims/wrappers/glue/adapter layers; if an adapter is unavoidable, keep it minimal and make the canonical internal interface explicit.
