# API Router MCP (minimal)

This is a minimal MCP server (stdio) for API Router.

It provides a small set of tools to:
- check gateway `/health` and `/status`
- read/update `user-data/config.toml`
- run safe, predefined build/test commands

## Build

```powershell
cargo build --release --manifest-path mcp/Cargo.toml
```

## Run (stdio)

Most MCP clients launch the server directly. If you need to point to a specific `user-data` folder:

```powershell
$env:AO_USER_DATA_DIR = "C:\path\to\user-data"
```

## Tools

- `ao.health`
- `ao.status`
- `ao.config.get`
- `ao.config.setProviderBaseUrl`
- `ao.config.setUsageBaseUrl`
- `ao.config.setSessionPreferredProvider`
- `ao.config.clearSessionPreferredProvider`
- `ao.dev.run` (`npm_build`, `cargo_test`, `cargo_clippy`)
