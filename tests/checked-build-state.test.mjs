import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  captureCheckedBuildSnapshot,
  isCheckedBuildFresh,
  writeCheckedBuildStamp,
} from '../tools/build/checked-build-state.mjs'

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function makeProjectSkeleton(root) {
  writeFile(path.join(root, 'package.json'), '{"name":"api-router"}\n')
  writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
  writeFile(path.join(root, 'index.html'), '<!doctype html>\n')
  writeFile(path.join(root, 'codex-web.html'), '<!doctype html>\n')
  writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n')
  writeFile(path.join(root, 'vite.config.ts'), 'export default {}\n')
  writeFile(path.join(root, 'src', 'ui', 'App.tsx'), 'export const App = () => null\n')
  writeFile(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname="api_router"\n')
  writeFile(path.join(root, 'src-tauri', 'Cargo.lock'), '# lock\n')
  writeFile(path.join(root, 'src-tauri', 'build.rs'), 'fn main() {}\n')
  writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), '{"build":{}}\n')
  writeFile(path.join(root, 'src-tauri', 'src', 'main.rs'), 'fn main() {}\n')
  writeFile(path.join(root, 'src-tauri', 'icons', 'icon.png'), 'icon\n')
  writeFile(path.join(root, 'tests', 'ui', 'tauri-ui-check.mjs'), 'console.log("test");\n')
  writeFile(path.join(root, 'tools', 'build', 'build-root-exe-checked.mjs'), 'console.log("build");\n')
  writeFile(path.join(root, 'tools', 'windows', 'run-with-win-sdk.mjs'), 'console.log("sdk");\n')
  writeFile(path.join(root, 'src-tauri', 'target', 'release', 'api_router.exe'), 'exe\n')
  writeFile(path.join(root, 'API Router.exe'), 'root exe\n')
}

describe('checked build freshness', () => {
  it('is fresh when the stamp matches the current inputs and outputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-router-checked-build-'))
    makeProjectSkeleton(root)

    const snapshot = captureCheckedBuildSnapshot(root)
    writeCheckedBuildStamp(root, {
      ...snapshot,
      capturedAtUnixMs: Date.now(),
      skippedUiBuild: true,
    })

    const freshness = isCheckedBuildFresh(root)
    expect(freshness.stamp).not.toBeNull()
    expect(freshness.fresh).toBe(true)
  })

  it('goes stale when a relevant source file changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-router-checked-build-'))
    makeProjectSkeleton(root)

    const snapshot = captureCheckedBuildSnapshot(root)
    writeCheckedBuildStamp(root, snapshot)

    const file = path.join(root, 'src', 'ui', 'App.tsx')
    fs.writeFileSync(file, 'export const App = () => "changed"\n', 'utf8')

    const freshness = isCheckedBuildFresh(root)
    expect(freshness.fresh).toBe(false)
  })

  it('goes stale when the root exe is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-router-checked-build-'))
    makeProjectSkeleton(root)

    const snapshot = captureCheckedBuildSnapshot(root)
    writeCheckedBuildStamp(root, snapshot)
    fs.rmSync(path.join(root, 'API Router.exe'))

    const freshness = isCheckedBuildFresh(root)
    expect(freshness.fresh).toBe(false)
  })
})
