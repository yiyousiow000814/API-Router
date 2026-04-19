<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="API Router logo" />
</p>

# 🚀 API Router

**Switch between AI models as easily as changing TV channels.**

API Router is a simple desktop app that lets you use different AI providers (like OpenAI, Claude, and more) without ever having to edit your code or configuration files again.

---

### ✨ Why use API Router?

- **🔄 One-Click Switching**: Change your active AI provider in the app, and all your tools instantly follow.
- **🛡️ Rock-Solid Reliability**: If one provider goes down, API Router automatically switches to your backup.
- **🔒 Private & Secure**: Your API Keys stay on your computer. We never see them.
- **☁️ Runs in the Background**: Stays out of your way in the system tray.

---

### 📥 Quick Start (3 Steps)

1.  **Download**: Get the latest `API Router.exe` from [GitHub Releases](https://github.com/yiyousiow000814/API-Router/releases).
2.  **Add Keys**: Open the app, click "Add Provider," and paste your API Key.
3.  **Connect**: Point your AI tool (like Codex) to:  
    `http://127.0.0.1:4000/v1`

---

### 🛠️ For Developers & Advanced Users

If you want to build from source or contribute, follow these steps:

#### Prerequisites
- Node.js & npm
- Rust & Tauri environment

#### Build Locally
```powershell
npm install
# Recommended: automatic pre-build checks & smart caching
npm run build:root-exe:checked
```
The built app will be saved to the repo root as `API Router.exe`.

#### Project Layout
- `src-tauri/`: The core engine (Rust).
- `src/ui/`: The user interface (React).
- `providers/`: Configuration for various AI services.

---

### ❓ Troubleshooting

- **Connection Refused?** Make sure the app is running and the port matches your tool's config.
- **Invalid Auth?** Check your `.codex/auth.json` formatting (ensure it's UTF-8 without BOM).

For more deep-dives into debugging and MCP access, see [docs/debug-interfaces.md](docs/debug-interfaces.md).
