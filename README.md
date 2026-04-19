<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="API Router logo" />
</p>

# API Router

**A local gateway for managing OpenAI-compatible endpoints for Codex.**

API Router is a Windows desktop application that provides a stable local endpoint for your AI development workflow. It allows you to switch between different OpenAI-compatible backends without modifying your Codex configuration or source code.

---

### Key Features

*   🔄 **Endpoint Routing**: Switch between active backends through the desktop interface; connected tools update instantly.
*   🛡️ **Automatic Failover**: If a primary backend becomes unavailable, the router can fallback to a secondary service.
*   🔒 **Local-Only Security**: API keys and credentials are stored exclusively on your local machine.
*   💻 **Windows Integration**: Runs as a native background application with a system tray icon for quick access.

---

### Quick Start Guide

1.  **Download**: Obtain the latest `API Router.exe` for Windows from [GitHub Releases](https://github.com/yiyousiow000814/API-Router/releases).
2.  **Setup**: Launch the application, select **Add Provider**, and enter your OpenAI-compatible API key.
3.  **Connect**: Point your Codex tool to the gateway:
    *   **Windows native**: `http://127.0.0.1:4000/v1`
    *   **WSL2 Environment**: `http://172.26.144.1:4000/v1` (Connect to the Windows Host IP)

---

### For Developers

To build from source or contribute to the project:

#### Prerequisites
*   Windows OS (Native support only)
*   Node.js & npm
*   Rust & Tauri environment

#### Build Locally
```powershell
npm install
# Recommended: performs pre-build validation and utilizing smart caching
npm run build:root-exe:checked
```
The compiled executable is generated in the repository root as `API Router.exe`.

---

### Troubleshooting

*   **Connection issues**: Ensure the application is running and the port matches your client's settings.
*   **Authentication errors**: Verify that your `.codex/auth.json` is encoded in UTF-8 without BOM.

For technical documentation and MCP integration, see [docs/debug-interfaces.md](docs/debug-interfaces.md).
