import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(process.cwd())
const skipReleaseBuild = String(process.env.API_ROUTER_BUILD_SKIP_RELEASE_BUILD || '').trim() === '1'

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
  const scriptPath = path.join(root, 'tools', 'build', 'build-root-exe.ps1')
  const exitCode = run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ])
  process.exit(exitCode)
}

if (skipReleaseBuild) {
  const copyExitCode = run(process.execPath, [path.join(root, 'tools', 'build', 'copy-root-exe.mjs')])
  if (copyExitCode !== 0) {
    process.exit(copyExitCode)
  }

  const openExitCode = run(process.execPath, [path.join(root, 'tools', 'build', 'open-root-exe.mjs')])
  process.exit(openExitCode)
}

let exitCode = run('npm', ['run', 'tauri', '--', 'build', '--no-bundle'])
if (exitCode !== 0) {
  process.exit(exitCode)
}

exitCode = run(process.execPath, [path.join(root, 'tools', 'build', 'copy-root-exe.mjs')])
if (exitCode !== 0) {
  process.exit(exitCode)
}

exitCode = run(process.execPath, [path.join(root, 'tools', 'build', 'open-root-exe.mjs')])
process.exit(exitCode)
