import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  captureCheckedBuildSnapshot,
  isCheckedBuildFresh,
  writeCheckedBuildStamp,
} from './checked-build-state.mjs'

const root = path.resolve(process.cwd())
const freshness = isCheckedBuildFresh(root)
const skipUiBuild = freshness.fresh

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

if (skipUiBuild) {
  console.log('[build-root-exe:checked] Fresh build artifacts detected; reusing the existing Tauri binary.')
}

const uiCheckEnv = {
  ...process.env,
  ...(skipUiBuild ? { UI_TAURI_SKIP_BUILD: '1' } : {}),
}

const uiCheckStatus = run(process.execPath, [path.join(root, 'tests', 'ui', 'run-tauri-if-windows.mjs')], {
  env: uiCheckEnv,
})
if (uiCheckStatus !== 0) {
  process.exit(uiCheckStatus)
}

const buildRootExeEnv = {
  ...process.env,
  API_ROUTER_BUILD_SKIP_RELEASE_BUILD: '1',
}

const buildStatus = run(process.execPath, [path.join(root, 'tools', 'build', 'build-root-exe.mjs')], {
  env: buildRootExeEnv,
})
if (buildStatus === 0) {
  writeCheckedBuildStamp(root, {
    ...captureCheckedBuildSnapshot(root),
    capturedAtUnixMs: Date.now(),
    skippedUiBuild: skipUiBuild,
  })
}
process.exit(buildStatus)
