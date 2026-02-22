import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import {
  ensureMsEdgeDriver,
  repoRoot,
  resolveTauriAppPath,
  runCapture,
  runOrThrow,
  runQuietOrThrow,
  startHiddenDesktopProcess,
} from './ui-check/runtime-utils.mjs'
import {
  runRequestsGraphProviderHydrationCase,
  waitSectionHeading,
  waitVisible,
} from './ui-check/cases.mjs'
import { Builder, By } from 'selenium-webdriver'

async function waitForPort(host, port, timeoutMs) {
  const net = await import('node:net')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection({ host, port })
      const done = (v) => {
        try {
          sock.destroy()
        } catch {}
        resolve(v)
      }
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
      sock.setTimeout(400, () => done(false))
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function main() {
  process.env.NODE_NO_WARNINGS = '1'
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' ')

  const keepVisible = String(process.env.UI_TAURI_VISIBLE || '').trim() === '1'
  const buildMode = keepVisible ? 'debug' : 'release'
  const npmArgs = ['run', 'tauri', '--', 'build', ...(buildMode === 'debug' ? ['--debug'] : []), '--no-bundle']
  if (keepVisible) {
    runOrThrow('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...npmArgs], { cwd: repoRoot })
  } else {
    runQuietOrThrow('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...npmArgs], { cwd: repoRoot })
  }

  const appPath = resolveTauriAppPath(buildMode)
  const msedgedriverPath = ensureMsEdgeDriver()
  const driversDir = path.dirname(msedgedriverPath)
  const msedgedriverWrapperPath = path.join(driversDir, 'msedgedriver-wrapper.cmd')
  const msedgedriverLogPath = path.join(driversDir, 'msedgedriver.log')
  fs.writeFileSync(
    msedgedriverWrapperPath,
    [
      '@echo off',
      'setlocal',
      `set LOG=${msedgedriverLogPath}`,
      `"${msedgedriverPath}" %* --log-path="%LOG%" >nul 2>&1`,
      'endlocal',
      '',
    ].join('\r\n'),
    'utf-8',
  )
  const driverHost = '127.0.0.1'
  const driverPort = 4444
  const tauriDriverExe =
    process.platform === 'win32'
      ? runCapture('where.exe', ['tauri-driver'], { cwd: repoRoot }).split(/\r?\n/).find(Boolean)
      : 'tauri-driver'
  if (!tauriDriverExe) throw new Error('tauri-driver not found in PATH.')

  const tauriDriver = startHiddenDesktopProcess({
    exe: tauriDriverExe,
    args: ['--port', String(driverPort), '--native-port', '4445', '--native-driver', msedgedriverWrapperPath],
    cwd: repoRoot,
    keepVisible,
    env: { ...process.env, UI_TAURI: '1' },
  })

  let driver
  try {
    const ok = await waitForPort(driverHost, driverPort, 20000)
    if (!ok) throw new Error(`tauri-driver not ready on ${driverHost}:${driverPort}`)

    driver = await new Builder()
      .usingServer(`http://${driverHost}:${driverPort}/`)
      .withCapabilities({
        browserName: 'wry',
        'tauri:options': {
          application: appPath,
        },
      })
      .build()
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 60000, script: 60000 })
    await waitSectionHeading(driver, 'Providers', 45000)
    await waitVisible(driver, By.xpath(`//button[contains(@class,'aoTopNavBtn')][.//span[normalize-space()='Analytics']]`), 15000)
    await runRequestsGraphProviderHydrationCase(
      driver,
      path.join(repoRoot, 'user-data', 'ui-artifacts', 'tauri', `requests-graph-hydration-${Date.now()}.png`),
    )
    console.log('[ui:requests-graph-hydration] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    try {
      if (tauriDriver && tauriDriver.pid && process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(tauriDriver.pid), '/T', '/F'], {
          cwd: repoRoot,
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
      } else if (tauriDriver) {
        tauriDriver.kill()
      }
    } catch {}
  }
}

main().catch((e) => {
  console.error(`[ui:requests-graph-hydration] FAIL: ${e?.stack || e}`)
  process.exitCode = 1
})

