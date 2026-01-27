# Agent Orchestrator — Agents Documentation

## Agent Defaults (Repository-Wide)
- **Document language**: Write instructions in English. Examples may include other languages when clarity improves.
- **Replies**: Default to Simplified Chinese. If a request is prefixed with `[EN]`, respond in English.
- **Terminology**: Do not translate proper nouns such as `Tauri`, `Rust`, `Codex`, `OpenAI`, or provider names.
- **Date/Time format**: Always use day-month-year ordering; never use month-day-year in outputs or docs.

## Git / GitHub Workflow
- **Branch-first**: Never commit directly to `main`. Use branches such as `feat/*`, `fix/*`, `docs/*`, `chore/*`.
- **PR-first**: Ship changes through a pull request (default to draft).
- **No PR comments** unless explicitly requested.
- **Titles**: PR and issue titles stay in English. Descriptions and regular comments default to Simplified Chinese (unless `[EN]`).

## Safety & Data Handling
- **Never commit secrets**: API keys, OAuth tokens, cookies, browser profiles, or raw conversation logs.
- **Key storage**: Provider API keys must be stored in the OS credential store (Windows Credential Manager / macOS Keychain / Linux Secret Service), not in `config.toml`.
- **Artifacts**: Do not commit binaries (`.exe`, `.msi`, installers). Publish binaries via GitHub Releases assets.

## Engineering Constraints
- **Cross-platform**: Keep the gateway and tooling compatible with Windows + Linux (WSL2) at minimum.
- **Evidence requirement**: Back conclusions with reproducible commands or steps (state A → change → state B).

