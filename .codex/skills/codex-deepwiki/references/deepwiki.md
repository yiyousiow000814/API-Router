# DeepWiki References for Codex

Use these pages when you need authoritative details about Codex behavior. Prefer direct quotes or
precise summaries with citations in answers.

## Authentication

- Authentication System (API key vs ChatGPT OAuth, token storage, refresh):  
  https://deepwiki.com/openai/codex/5.1-authentication-system
- Authentication & model integration (AuthManager, modes, lifecycle):  
  https://deepwiki.com/openai/codex/5-developer-guide

## Configuration

- Configuration System (CODEX_HOME, config.toml, auth.json locations):  
  https://deepwiki.com/openai/codex/2.2-configuration-system

## Sessions / History

- Session Resumption (where sessions live, JSONL format, resume behavior):  
  https://deepwiki.com/openai/codex/4.4-session-resumption
- Conversation History & Persistence (rollout file structure, item types):  
  https://deepwiki.com/openai/codex/3.3-conversation-history-and-persistence

## Providers / Wire API

- Model Provider Configuration (wire_api, built-in providers, requires_openai_auth):  
  https://deepwiki.com/openai/codex/5.2-mcp-client-integration

## Usage Tips

- If a question is about “where the file is stored,” check Configuration System first.
- If a question is about “why context is missing,” check Session Resumption and Conversation History.
- If a question is about “why auth keeps switching,” check Authentication System and developer guide.
