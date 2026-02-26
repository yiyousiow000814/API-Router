import { spawnSync } from 'node:child_process'

const STRICT_UI_CHECK =
  String(process.env.UI_TAURI_STRICT || '').trim() === '1' ||
  String(process.env.CI || '').trim().toLowerCase() === 'true'

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

if ((res.status ?? 1) !== 0) {
  if (STRICT_UI_CHECK) {
    process.exit(res.status ?? 1)
  }
  console.warn('[ui:tauri] non-strict mode: continue build despite UI check failure.')
  process.exit(0)
}

process.exit(0)
