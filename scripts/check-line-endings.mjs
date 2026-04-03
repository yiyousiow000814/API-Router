import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ALLOW_CRLF_EXT = new Set(['.bat', '.cmd', '.ps1'])
const DEFAULT_BASE_CANDIDATES = ['origin/main', 'origin/HEAD', 'main']

function extname(path) {
  const idx = path.lastIndexOf('.')
  return idx >= 0 ? path.slice(idx).toLowerCase() : ''
}

function gitExec(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function gitLines(args) {
  try {
    return gitExec(args)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function gitLinesChecked(args) {
  try {
    const lines = gitExec(args)
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

function gitRefExists(ref) {
  try {
    gitExec(['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

export function resolveBaseRef(env = process.env, options = {}) {
  const refExists = options.refExists || gitRefExists
  const preferred = (env.LINE_ENDINGS_BASE || '').trim()
  const candidates = unique([preferred, ...DEFAULT_BASE_CANDIDATES].filter(Boolean))
  for (const candidate of candidates) {
    if (refExists(candidate)) return candidate
  }
  return null
}

function workingTreeFallbackFiles(gitLinesImpl = gitLines) {
  return unique([
    ...gitLinesImpl(['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD']),
    ...gitLinesImpl(['diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB']),
    ...gitLinesImpl(['ls-files', '--others', '--exclude-standard']),
  ])
}

function lastCommitFallbackFiles(gitLinesImpl = gitLines) {
  return unique(gitLinesImpl(['show', '--pretty=format:', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD']))
}

export function collectChangedFiles(env = process.env, options = {}) {
  const resolveBaseRefImpl = options.resolveBaseRef || resolveBaseRef
  const gitLinesCheckedImpl = options.gitLinesChecked || gitLinesChecked
  const gitLinesImpl = options.gitLines || gitLines
  const baseRef = resolveBaseRefImpl(env, options)
  if (baseRef) {
    const primary = gitLinesCheckedImpl(['diff', '--name-only', '--diff-filter=ACMRTUXB', `${baseRef}...HEAD`])
    if (primary.ok && primary.lines.length > 0) {
      return { files: primary.lines, baseRef, source: 'base-diff' }
    }
    const fallback = workingTreeFallbackFiles(gitLinesImpl)
    if (fallback.length > 0) {
      return { files: fallback, baseRef, source: 'working-tree-fallback' }
    }
    return { files: primary.lines, baseRef, source: 'base-diff-empty' }
  }

  const fallback = workingTreeFallbackFiles(gitLinesImpl)
  if (fallback.length > 0) {
    return { files: fallback, baseRef: null, source: 'working-tree-fallback' }
  }

  const lastCommit = lastCommitFallbackFiles(gitLinesImpl)
  if (lastCommit.length > 0) {
    return { files: lastCommit, baseRef: null, source: 'last-commit-fallback' }
  }

  return { files: [], baseRef: null, source: 'no-changes' }
}

export function findCrLfOffenders(files) {
  const offenders = []
  for (const file of files) {
    if (!existsSync(file)) continue
    const ext = extname(file)
    if (ALLOW_CRLF_EXT.has(ext)) continue
    const buf = readFileSync(file)
    if (buf.includes(0)) continue
    if (buf.includes('\r\n')) offenders.push(file)
  }
  return offenders
}

export function runLineEndingCheck(env = process.env) {
  const result = collectChangedFiles(env)
  const offenders = findCrLfOffenders(result.files)
  return { ...result, offenders }
}

function isEntrypoint() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
}

if (isEntrypoint()) {
  const result = runLineEndingCheck(process.env)
  if (result.offenders.length) {
    console.error('CRLF detected in changed files that must use LF:')
    result.offenders.forEach((f) => console.error(`- ${f}`))
    process.exit(1)
  }
  if (result.baseRef) {
    console.log(`Line ending check passed (${result.source}, base ${result.baseRef}).`)
  } else {
    console.log(`Line ending check passed (${result.source}).`)
  }
}
