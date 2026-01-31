import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(process.cwd())
const src = path.join(root, 'src-tauri', 'target', 'release', 'api_router.exe')
const dst = path.join(root, 'API Router.exe')

if (!fs.existsSync(src)) {
  console.error(`Missing built exe: ${src}`)
  process.exit(1)
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function tryKillRunningExe() {
  if (process.platform !== 'win32') return
  // Best-effort: if the root EXE is running, replacing it will fail with EPERM.
  // This is a local convenience helper; we never commit the EXE.
  spawnSync('taskkill', ['/F', '/IM', 'API Router.exe'], { stdio: 'ignore' })
  spawnSync('taskkill', ['/F', '/IM', 'api_router.exe'], { stdio: 'ignore' })
}

function copyOverwriting(srcPath, dstPath) {
  fs.copyFileSync(srcPath, dstPath)
}

try {
  copyOverwriting(src, dst)
} catch (e) {
  if (e && (e.code === 'EPERM' || e.code === 'EBUSY')) {
    tryKillRunningExe()
    sleep(500)
    copyOverwriting(src, dst)
  } else {
    throw e
  }
}
console.log(`Wrote: ${dst}`)
