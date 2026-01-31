---
name: codex-deepwiki
description: "Use when you need authoritative details about how a project works by consulting DeepWiki (design, internals, config, workflows). Find the relevant DeepWiki pages, summarize behavior with citations, and compare against local code if needed."
---

# DeepWiki Reference

## Overview

Use this skill to answer questions about project internals by consulting DeepWiki. It provides
links and a minimal workflow to verify behavior against documentation and local code.

## Workflow

1. Identify the question category (auth, config, sessions/resume, workflows, APIs).
2. Open the relevant DeepWiki page(s) listed in `references/deepwiki.md` (add new links as needed).
3. Extract the exact behavior/paths/precedence from the page and quote/summarize it.
4. If the local repo behavior differs, check local code and note the difference explicitly.
5. Respond with concise, factual guidance and cite the DeepWiki source.

## Guidance

- Prefer DeepWiki for authoritative behavior instead of memory.
- Include explicit paths (e.g., `$CODEX_HOME`, `auth.json`, `sessions/*.jsonl`) only when sourced.
- When asked to confirm “latest” behavior, verify the page and cite the relevant section.

## References

Use `references/deepwiki.md` to locate the correct DeepWiki pages quickly.
