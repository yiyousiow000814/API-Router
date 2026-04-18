import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(process.cwd())
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const CHECKS = [
  { label: 'provider ids', args: ['run', 'check:gateway-provider-id'] },
  { label: 'line endings', args: ['run', 'check:line-endings'] },
  { label: 'web assets', args: ['run', 'check:web-codex-assets'] },
]

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

function runStep({ label, args }) {
  const startedAt = Date.now()
  console.log(`[build-root-exe:checks] Starting ${label}...`)
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'cmd.exe' : npmCommand
    const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', npmCommand, ...args] : args
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      env: process.env,
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${label} exited with signal ${signal}`))
        return
      }
      if ((code ?? 1) !== 0) {
        reject(new Error(`${label} failed with exit code ${code ?? 1}`))
        return
      }
      console.log(`[build-root-exe:checks] Finished ${label} in ${formatDuration(Date.now() - startedAt)}.`)
      resolve()
    })
  })
}

async function main() {
  const startedAt = Date.now()
  for (const check of CHECKS) {
    await runStep(check)
  }
  console.log(`[build-root-exe:checks] All checks passed in ${formatDuration(Date.now() - startedAt)}.`)
}

main().catch((error) => {
  console.error(`[build-root-exe:checks] ${error?.message || error}`)
  process.exit(1)
})
