import fs from 'node:fs'
import path from 'node:path'

const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vite',
  '.cache',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'user-data',
])

const CHECKED_BUILD_INPUTS = [
  'package.json',
  'package-lock.json',
  'codex-web.html',
  'index.html',
  'tsconfig.json',
  'vite.config.ts',
  'src',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/icons',
  'src-tauri/src',
  'tests/ui',
  'tools/build',
  'tools/windows/run-with-win-sdk.mjs',
]

const STAMP_RELATIVE_PATH = path.join('user-data', 'tmp', 'build-root-exe-checked-state.json')

function safeStat(absPath) {
  try {
    return fs.statSync(absPath)
  } catch {
    return null
  }
}

function latestMtimeMsForPath(absPath) {
  const stat = safeStat(absPath)
  if (!stat) return 0
  let latest = stat.mtimeMs
  if (!stat.isDirectory()) {
    return latest
  }
  const baseName = path.basename(absPath).toLowerCase()
  if (IGNORED_DIR_NAMES.has(baseName)) {
    return 0
  }
  const entries = safeReaddir(absPath)
  for (const entry of entries) {
    latest = Math.max(latest, latestMtimeMsForPath(path.join(absPath, entry.name)))
  }
  return latest
}

function safeReaddir(absPath) {
  try {
    return fs.readdirSync(absPath, { withFileTypes: true })
  } catch {
    return []
  }
}

export function checkedBuildStampPath(root) {
  return path.join(root, STAMP_RELATIVE_PATH)
}

export function checkedBuildArtifactPaths(root) {
  return {
    releaseExe: path.join(root, 'src-tauri', 'target', 'release', 'api_router.exe'),
    rootExe: path.join(root, 'API Router.exe'),
  }
}

export function checkedBuildInputLatestMtimeMs(root) {
  let latest = 0
  for (const rel of CHECKED_BUILD_INPUTS) {
    latest = Math.max(latest, latestMtimeMsForPath(path.join(root, rel)))
  }
  return latest
}

export function readCheckedBuildStamp(root) {
  const stampPath = checkedBuildStampPath(root)
  const stat = safeStat(stampPath)
  if (!stat) return null
  try {
    const payload = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
    if (!payload || typeof payload !== 'object') return null
    return payload
  } catch {
    return null
  }
}

export function writeCheckedBuildStamp(root, snapshot) {
  const stampPath = checkedBuildStampPath(root)
  fs.mkdirSync(path.dirname(stampPath), { recursive: true })
  fs.writeFileSync(stampPath, JSON.stringify(snapshot, null, 2), 'utf8')
}

export function captureCheckedBuildSnapshot(root) {
  const { releaseExe, rootExe } = checkedBuildArtifactPaths(root)
  const releaseStat = safeStat(releaseExe)
  const rootStat = safeStat(rootExe)
  return {
    latestInputMtimeMs: checkedBuildInputLatestMtimeMs(root),
    releaseExeMtimeMs: releaseStat ? releaseStat.mtimeMs : 0,
    rootExeMtimeMs: rootStat ? rootStat.mtimeMs : 0,
    releaseExeExists: Boolean(releaseStat),
    rootExeExists: Boolean(rootStat),
  }
}

export function isCheckedBuildFresh(root) {
  const snapshot = captureCheckedBuildSnapshot(root)
  const stamp = readCheckedBuildStamp(root)
  if (!stamp) {
    return { fresh: false, snapshot, stamp: null }
  }
  const fresh =
    snapshot.releaseExeExists &&
    snapshot.rootExeExists &&
    Number(stamp.latestInputMtimeMs || 0) >= snapshot.latestInputMtimeMs &&
    Number(stamp.releaseExeMtimeMs || 0) <= snapshot.releaseExeMtimeMs &&
    Number(stamp.rootExeMtimeMs || 0) <= snapshot.rootExeMtimeMs
  return { fresh, snapshot, stamp }
}
