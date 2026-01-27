import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd())
const src = path.join(root, 'src-tauri', 'target', 'release', 'agent_orchestrator.exe')
const dst = path.join(root, 'Agent Orchestrator.exe')

if (!fs.existsSync(src)) {
  console.error(`Missing built exe: ${src}`)
  process.exit(1)
}

// On Windows the destination can still be running; copy via a temp file then replace.
const tmp = path.join(root, 'Agent Orchestrator.exe.tmp')
try {
  fs.copyFileSync(src, tmp)
  fs.renameSync(tmp, dst)
} finally {
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  } catch {
    // ignore
  }
}
console.log(`Wrote: ${dst}`)
