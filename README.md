<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="API Router logo" />
</p>

# API Router

**A professional desktop gateway for seamless AI provider orchestration.**

API Router is a lightweight desktop application designed to provide a stable, local gateway for various AI services (such as OpenAI, Claude, and others). It allows users to switch between different model providers without modifying application code or complex configuration files.

---

### Key Capabilities

- **Seamless Switching**: Change the active AI provider through the desktop interface; all connected tools update their routing instantly.
- **Automated Failover**: Built-in redundancy ensures that if a primary provider becomes unavailable, the router can automatically fallback to a secondary service.
- **Local-First Security**: API keys and sensitive credentials are stored exclusively on your local machine.
- **Background Operation**: Runs as a native system tray application for minimal workflow interruption.

---

### Quick Start Guide

1.  **Download**: Obtain the latest `API Router.exe` from the [GitHub Releases](https://github.com/yiyousiow000814/API-Router/releases) page.
2.  **Configuration**: Launch the application, select "Add Provider," and input your API credentials.
3.  **Integration**: Point your AI-enabled tool (such as Codex) to the local gateway address:  
    `http://127.0.0.1:4000/v1`

---

### For Developers and Advanced Users

To contribute to the project or build the executable from source, follow the instructions below.

#### Prerequisites
- Node.js and npm
- Rust and Tauri development environment

#### Local Build Process
```powershell
npm install
# Recommended: performs pre-build validation and utilizes smart caching
npm run build:root-exe:checked
```
The compiled executable will be located in the repository root as `API Router.exe`.

#### Project Structure
- `src-tauri/`: Core gateway logic and native integration (Rust).
- `src/ui/`: Desktop management interface (React/TypeScript).
- `providers/`: Configuration templates for supported AI services.

---

### Troubleshooting and Support

- **Connection Issues**: Verify that the application is running and that the port configuration matches your client's settings.
- **Authentication Errors**: Ensure that your `.codex/auth.json` is encoded in UTF-8 without BOM (Byte Order Mark).

For detailed technical documentation, including debugging interfaces and MCP integration, refer to [docs/debug-interfaces.md](docs/debug-interfaces.md).
