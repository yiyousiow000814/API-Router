<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="API Router logo" />
</p>

# API Router

**A local gateway for managing and switching between AI model providers.**

API Router is a desktop application that provides a stable, local endpoint for various AI services. It allows you to switch between providers (such as OpenAI or Claude) without modifying your tool configurations or source code.

---

### Key Features

*   🔄 **Model Routing**: Change your active AI provider in the app interface; all connected clients update instantly.
*   🛡️ **Automatic Failover**: If a primary provider is unavailable, the router can fallback to a secondary service.
*   🔒 **Local Security**: API keys and credentials are stored exclusively on your local machine.
*   💻 **System Integration**: Runs as a background application with a system tray icon for quick access.

---

### Quick Start

1.  **Download**: Get the latest `API Router.exe` from [GitHub Releases](https://github.com/yiyousiow000814/API-Router/releases).
2.  **Setup**: Launch the app, select **Add Provider**, and enter your API key.
3.  **Connect**: Point your AI tool (e.g., Codex) to: `http://127.0.0.1:4000/v1`

---

### Developer Information

To build from source or contribute, follow these steps:

#### Prerequisites
*   Node.js & npm
*   Rust & Tauri environment

#### Local Build
```powershell
npm install
# Performs pre-build checks and utilizes caching
npm run build:root-exe:checked
```
The executable is generated at the repository root as `API Router.exe`.

#### Project Layout
*   `src-tauri/`: Core gateway logic (Rust).
*   `src/`: Desktop management UI (React/TypeScript).
*   `providers/`: Configuration templates for AI services.

---

### Support & Troubleshooting

*   **Connection**: Ensure the application is running and the port matches your tool's settings.
*   **Authentication**: Verify that `.codex/auth.json` is UTF-8 encoded without BOM.

For technical details, debugging, and MCP integration, see [docs/debug-interfaces.md](docs/debug-interfaces.md).
