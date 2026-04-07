import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(process.cwd())

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    ...options,
  })
  if (result.error) {
    throw result.error
  }
  return typeof result.status === 'number' ? result.status : 1
}

if (process.platform === 'win32') {
  const scriptPath = path.join(root, 'scripts', 'build-root-exe.ps1')
  const exitCode = run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ])
  process.exit(exitCode)
}

let exitCode = run('npm', ['run', 'tauri', '--', 'build', '--no-bundle'])
if (exitCode !== 0) {
  process.exit(exitCode)
}

exitCode = run(process.execPath, [path.join(root, 'scripts', 'copy-root-exe.mjs')])
if (exitCode !== 0) {
  process.exit(exitCode)
}

exitCode = run(process.execPath, [path.join(root, 'scripts', 'open-root-exe.mjs')])
process.exit(exitCode)
