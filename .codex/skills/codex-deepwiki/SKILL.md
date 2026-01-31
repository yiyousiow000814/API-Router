---
name: codex-deepwiki
description: "Use when you need authoritative details about how Codex CLI works (auth modes, config precedence, session storage/resume, rollout JSONL format, CODEX_HOME paths). Look up DeepWiki pages for openai/codex and summarize behavior with citations."
---

# Codex DeepWiki Reference

## Overview

Use this skill to answer questions about Codex internals by consulting DeepWiki. It provides
links to the most relevant DeepWiki pages and a minimal workflow to verify behaviors.

## Workflow

1. Identify the question category (auth, config, sessions/resume, rollout JSONL, provider config).
2. Open the relevant DeepWiki page(s) listed in `references/deepwiki.md`.
3. Extract the exact behavior/paths/precedence from the page and quote/summarize it.
4. If the local repo behavior differs, check local code and note the difference explicitly.
5. Respond with concise, factual guidance and cite the DeepWiki source.

## Guidance

- Prefer DeepWiki for authoritative Codex behavior instead of memory.
- Include explicit paths (e.g., `$CODEX_HOME`, `auth.json`, `sessions/*.jsonl`) only when sourced.
- When asked to confirm “latest” behavior, verify the page and cite the relevant section.

## References

Use `references/deepwiki.md` to locate the correct DeepWiki pages quickly.
