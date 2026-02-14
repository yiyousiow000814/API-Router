import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const ALLOW_CRLF_EXT = new Set(['.bat', '.cmd', '.ps1'])

function extname(path) {
  const idx = path.lastIndexOf('.')
  return idx >= 0 ? path.slice(idx).toLowerCase() : ''
}

function gitLines(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function gitLinesChecked(args) {
  try {
    const lines = execFileSync('git', args, { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    return { ok: true, lines }
  } catch {
    return { ok: false, lines: [] }
  }
}

function unique(items) {
  return [...new Set(items)]
}

const baseRef = process.env.LINE_ENDINGS_BASE || 'origin/main'
const primary = gitLinesChecked(['diff', '--name-only', '--diff-filter=ACMRTUXB', `${baseRef}...HEAD`])
let files = primary.lines
if (files.length === 0) {
  files = unique([
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD']),
    ...gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ])
}

if (!primary.ok && files.length === 0) {
  console.error(
    `Line ending check could not determine changed files (base ref "${baseRef}" not reachable and fallback empty).`,
  )
  console.error('Ensure CI fetches a base branch (for example checkout with fetch-depth: 0).')
  process.exit(2)
}

const offenders = []
for (const file of files) {
  if (!existsSync(file)) continue
  const ext = extname(file)
  if (ALLOW_CRLF_EXT.has(ext)) continue
  const buf = readFileSync(file)
  // Skip binary files (for example png/ico) so only text content is checked.
  if (buf.includes(0)) continue
  if (buf.includes('\r\n')) offenders.push(file)
}

if (offenders.length) {
  console.error('CRLF detected in changed files that must use LF:')
  offenders.forEach((f) => console.error(`- ${f}`))
  process.exit(1)
}

console.log('Line ending check passed (LF policy for changed files).')
