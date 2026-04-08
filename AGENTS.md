# API Router - Agents Documentation

## Agent Defaults (Repository-Wide)
- **Document language**: Write instructions in English. Examples may include other languages when clarity improves.
- **Replies**: Match the primary language the user is using in the current conversation. If the conversation is mixed-language, follow the language used for the actionable part; if still unclear, mirror the user's current conversational language.
- **Terminology**: Do not translate proper nouns such as `Tauri`, `Rust`, `Codex`, `OpenAI`, or provider names.
- **Term clarification**: Whenever using a specific term or phrase that may be unclear, add a short bracketed explanation beside it on first use (for example, `worktree` [separate checkout] or `canonical path` [single official implementation route]). Keep the explanation concise and skip obvious terms.
- **Date/Time format**: Always use day-month-year ordering; never use month-day-year in outputs or docs.
- **Agent capacity fallback**: If spawning a new agent fails because capacity is full, first clean up agents that are not actively in progress/in use, then retry spawning.

## Git / GitHub Workflow
- **Branch-first**: Never commit directly to `main`. Use branches such as `feat/*`, `fix/*`, `docs/*`, `chore/*`.
- **PR-first**: Ship changes through a pull request (default to draft).
- **User-specified PR number rule (required)**: If the user references a specific PR number (for example "push to PR 165" or "open PR 165"), first verify whether that PR already exists and report the result before taking action. If that PR number is already taken, do not silently open a different PR number. Ask whether to update the existing PR, close/reuse another PR, or proceed with a new PR.
- **No PR comments** unless explicitly requested.
- **Titles**: PR and issue titles stay in English. PR descriptions and regular comments should match the primary language of the surrounding conversation or thread.
- **PR title prefix**: PR titles must start with one of `feat:`, `fix:`, `docs:`, `chore:`.
- **PR title length**: Keep PR titles at 8 words or fewer. Avoid symbols like `+` in titles.
- **PR body format**: PR bodies must include `## What`, `## Why`, `## Changes`, `## Verify`. If the PR is long, add `## TL;DR` at the very top.
- **PR summary scope**: Titles and bodies must describe the overall changes relative to `main`, not just the latest commit.
- **Resolve review threads**: After addressing review comments, resolve the corresponding review conversations (click "Resolve conversation").
- **Format before commit**: Ensure formatting checks pass before committing.
- **Pre-commit/push gate (required)**: Before every `git commit` and `git push`, run `npm run check:ci-local` (or at minimum run `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`). Do not commit/push when these fail.
- **Conflict-resolution rule (required)**: Never resolve merge conflicts by dropping one side wholesale. Preserve both branch intent and incoming `main` functionality unless there is a documented reason to change behavior. After conflict resolution, run targeted checks/tests for the touched behavior before committing.
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
- **EXE build workflow**: For local Windows EXE output, prefer `npm run build:root-exe:checked`. Use `npm run build:root-exe` only when UI check is intentionally skipped.
- **EXE launch path policy (required)**: For manual open/restart requests, launch only repo-root executables: `API Router.exe` (or `API Router [TEST].exe` for test runs). Do not launch `src-tauri/target/release/api_router.exe` directly unless the user explicitly asks for the raw Tauri build artifact.
- **EXE naming policy (required)**: Treat repo-root `API Router.exe` as the canonical runtime binary name. `api_router.exe` is a build artifact under `src-tauri/target/...` and should not be used as the default launch target.
- **Line endings**: Use LF as the repository standard. CRLF is only allowed for Windows script files (`.bat`, `.cmd`, `.ps1`).
- **File size guideline (industry style)**: Prefer small, focused files (roughly 200-500 lines) when practical.
- **Modularization rule (required)**: Prefer splitting code by clear responsibility boundaries instead of enforcing an arbitrary line cap. When a file grows large, refactor it into coherent modules organized by ownership and data flow (for example parsing, rendering, transport, state, tests), even if some resulting files are still larger than 500 lines.
- **Large-file policy**: There is no automatic hard cap such as 800 lines. Large files are allowed only when the structure is still responsibility-driven and easy to navigate. If a file feels hard to reason about, hard to test, or mixes multiple concerns, split it by responsibility in the same PR unless there is a clear documented reason not to.
- **Exceptions**: Lock/generated files are excluded from this rule (for example `Cargo.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`).


## Canonical Implementation Policy (Breaking Changes Allowed)

- **No retrofit smell**: after the change, the codebase MUST appear as if the feature existed from day one—consistent naming, structure, ownership boundaries, and data flow; no scaffolding, transitional glue, or compatibility artifacts.
- **Single canonical path:** All changes MUST be implemented in the **primary codepath** as the **only** canonical implementation.
- **Remove legacy:** Delete any **legacy / dead / duplicate** implementations. Do not keep parallel codepaths.
- **No long-term compatibility:** Do NOT keep parallel implementations or long-lived compatibility layers. If external inputs vary, normalize them into one canonical internal shape and remove legacy handling as soon as possible.
- **Breaking data changes are OK:** Destructive data changes are permitted. If the data model changes, **re-seed or migrate**; do NOT parse or support legacy formats.
- **First-class integrations preferred:** Use direct, first-class integrations where feasible. Avoid shims/wrappers/glue/adapter layers; if an adapter is unavoidable, keep it minimal and make the canonical internal interface explicit.

## Global Priorities
1) **Root-cause first.** Do not use strong guards/forced rules/fallbacks/clamps/retries to *mask* an unknown root cause.
2) **Evidence required.** Every fix must include: minimal repro, logs/assertion evidence, and a regression test.
3) **Two-commit rule (preferred):**
   - **Commit A:** diagnostics only (logs/assertions/metrics/minimal repro). No behavior change.
   - **Commit B:** fix based on evidence + regression test.

## Mandatory Self-Check Loop (Before Proposing a Fix)
You MUST do this in order:

A. **Reproduce**
- Describe the failure mode and expected behavior.
- Provide minimal repro steps (commands + inputs).

B. **Observe**
- Add targeted logging/assertions to capture the suspected invariants.
- Show the exact logs/output that confirm the root cause.

C. **Verify**
- Add/extend a regression test that fails before fix and passes after fix.
- Run: unit tests + lint/typecheck (if available) + relevant integration/e2e tests.

D. **Guardrails (Allowed Only With Proof)**
Guards/fallbacks are only allowed if:
1) root cause is fixed OR proven external (e.g., flaky dependency)
2) guard is paired with metrics/logging + an alertable signal
3) a test covers the guard behavior

## "Band-Aid" Red Flags (Require Explicit Justification + Tests)
- try/catch swallowing errors, default returns, `except: pass`
- clamp/max/min without invariant proof
- retries/timeouts without concurrency/root-cause analysis
- skipping inputs/files to make tests pass
- weakening assertions or deleting failing tests

## CSS Layering (z-index) Policy
- Use the global sequential z-index scale (e.g. `--z-*` tokens) for cross-component layering.
- **No scattered magic numbers** (e.g. 20/30/60/120). Keep the scale sequential without gaps.
- If a new layer is required, add a new `--z-*` token and update the table/comments near `:root`.
