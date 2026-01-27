import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd())
const src = path.join(root, 'src-tauri', 'target', 'release', 'agent_orchestrator.exe')
const dst = path.join(root, 'Agent Orchestrator.exe')

if (!fs.existsSync(src)) {
  console.error(`Missing built exe: ${src}`)
  process.exit(1)
}

fs.copyFileSync(src, dst)
console.log(`Wrote: ${dst}`)

