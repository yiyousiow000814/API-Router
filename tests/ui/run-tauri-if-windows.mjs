import { spawnSync } from 'node:child_process'

// Cross-platform helper: run `npm run ui:tauri` only on Windows.
// This keeps `build:root-exe:checked` usable on Linux/WSL2 while still enforcing
// the Windows-only Tauri UI automation on win32.
if (process.platform !== 'win32') {
  console.log('[ui:tauri] skipped (Windows only)')
  process.exit(0)
}

const res = spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'run', 'ui:tauri'], {
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
})

if (res.error) {
  console.error(`[ui:tauri] wrapper failed: ${res.error.message}`)
  process.exit(1)
}

process.exit(res.status ?? 1)
