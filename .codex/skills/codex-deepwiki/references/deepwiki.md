# DeepWiki References

Use these pages when you need authoritative details about project behavior. Prefer direct quotes or
precise summaries with citations in answers. Add new links here as needed.

## Codex (example)

- Authentication System (API key vs ChatGPT OAuth, token storage, refresh):  
  https://deepwiki.com/openai/codex/5.1-authentication-system
- Authentication & model integration (AuthManager, modes, lifecycle):  
  https://deepwiki.com/openai/codex/5-developer-guide

### Configuration

- Configuration System (CODEX_HOME, config.toml, auth.json locations):  
  https://deepwiki.com/openai/codex/2.2-configuration-system

### Sessions / History

- Session Resumption (where sessions live, JSONL format, resume behavior):  
  https://deepwiki.com/openai/codex/4.4-session-resumption
- Conversation History & Persistence (rollout file structure, item types):  
  https://deepwiki.com/openai/codex/3.3-conversation-history-and-persistence

### Providers / Wire API

- Model Provider Configuration (wire_api, built-in providers, requires_openai_auth):  
  https://deepwiki.com/openai/codex/5.2-mcp-client-integration

## Usage tips

- If a question is about “where a file is stored,” check the project’s configuration docs first.
- If a question is about “why context is missing,” check session/history docs.
- If a question is about “why auth keeps switching,” check authentication docs.
- Add new project sections here (e.g., `## RepoName`) and list the DeepWiki pages you used.
