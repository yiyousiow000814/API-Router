import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  captureCheckedBuildSnapshot,
  isCheckedBuildFresh,
  writeCheckedBuildStamp,
} from './checked-build-state.mjs'

const root = path.resolve(process.cwd())
const freshnessStartedAt = Date.now()
const freshness = isCheckedBuildFresh(root)
const freshnessDurationMs = Date.now() - freshnessStartedAt
const skipUiBuild = freshness.fresh

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

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

function runAsync(label, command, args, options = {}) {
  const startedAt = Date.now()
  console.log(`[build-root-exe:checked] Starting ${label}...`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      ...options,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${label} exited with signal ${signal}`))
        return
      }
      const exitCode = code ?? 1
      if (exitCode !== 0) {
        reject(new Error(`${label} failed with exit code ${exitCode}`))
        return
      }
      console.log(`[build-root-exe:checked] Finished ${label} in ${formatDuration(Date.now() - startedAt)}.`)
      resolve()
    })
  })
}

console.log(
  `[build-root-exe:checked] Freshness scan finished in ${formatDuration(freshnessDurationMs)} (fresh=${skipUiBuild ? 'yes' : 'no'}).`,
)

if (skipUiBuild) {
  console.log('[build-root-exe:checked] Fresh build artifacts detected; reusing the existing Tauri binary.')
}

async function main() {
  const totalStartedAt = Date.now()
  const parallelStageStartedAt = Date.now()
  const parallelTasks = []

  const uiCheckEnv = {
    ...process.env,
    ...(skipUiBuild ? { UI_TAURI_SKIP_BUILD: '1' } : {}),
  }
  parallelTasks.push(
    runAsync('UI check', process.execPath, [path.join(root, 'tests', 'ui', 'run-tauri-if-windows.mjs')], {
      env: uiCheckEnv,
    }),
  )

  if (!skipUiBuild) {
    parallelTasks.push(
      runAsync('pre-build checks', process.execPath, [path.join(root, 'tools', 'build', 'run-root-exe-checks.mjs')]),
    )
  }

  await Promise.all(parallelTasks)
  console.log(
    `[build-root-exe:checked] Parallel stage finished in ${formatDuration(Date.now() - parallelStageStartedAt)}.`,
  )

  const finalizeStartedAt = Date.now()
  const buildRootExeEnv = {
    ...process.env,
    API_ROUTER_BUILD_SKIP_RELEASE_BUILD: '1',
    API_ROUTER_BUILD_SKIP_PRERELEASE_CHECKS: skipUiBuild ? '0' : '1',
  }

  const buildStatus = run(process.execPath, [path.join(root, 'tools', 'build', 'build-root-exe.mjs')], {
    env: buildRootExeEnv,
  })
  console.log(
    `[build-root-exe:checked] Finalize stage finished in ${formatDuration(Date.now() - finalizeStartedAt)}.`,
  )
  if (buildStatus === 0) {
    writeCheckedBuildStamp(root, {
      ...captureCheckedBuildSnapshot(root),
      capturedAtUnixMs: Date.now(),
      skippedUiBuild: skipUiBuild,
      freshnessDurationMs,
    })
    console.log(`[build-root-exe:checked] Total checked build time: ${formatDuration(Date.now() - totalStartedAt)}.`)
  }
  process.exit(buildStatus)
}

main().catch((error) => {
  console.error(`[build-root-exe:checked] ${error?.message || error}`)
  process.exit(1)
})
