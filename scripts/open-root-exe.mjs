import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(process.cwd())
const exePath = path.join(root, 'API Router.exe')

if (!fs.existsSync(exePath)) {
  console.error(`Missing root exe: ${exePath}`)
  process.exit(1)
}

if (process.platform !== 'win32') {
  console.log(`Skip auto-open on ${process.platform}. Built exe at: ${exePath}`)
  process.exit(0)
}

const result = await new Promise((resolve) => {
  const child = spawn(exePath, [], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })

  child.once('spawn', () => {
    child.unref()
    resolve({ ok: true })
  })
  child.once('error', (error) => {
    resolve({ ok: false, error })
  })
})

if (!result.ok) {
  console.warn(`Skip auto-open root exe: ${String(result.error)}`)
  process.exit(0)
}

console.log(`Opened: ${exePath}`)
