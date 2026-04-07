import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { Builder, By, until } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'
import { ensureMsEdgeDriver, repoRoot } from '../../support/runtime-utils.mjs'

const BASE_URL = String(process.env.CODEX_WEB_URL || 'http://127.0.0.1:5173/codex-web?animdebug=1').trim()
const KEEP_VISIBLE = String(process.env.UI_TAURI_VISIBLE || '').trim() === '1'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await predicate()
    if (ok) return true
    // eslint-disable-next-line no-await-in-loop
    await sleep(80)
  }
  throw new Error(`Timeout waiting for ${label}`)
}

async function canReach(url) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    clearTimeout(timer)
    return res.ok || res.status === 401 || res.status === 403
  } catch {
    return false
  }
}

function killProcessTree(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {}
}

async function ensureDevServerReady() {
  if (await canReach(BASE_URL)) return null
  const devProc = spawn(
    'cmd.exe',
    ['/d', '/s', '/c', 'npm.cmd', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'],
    {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      stdio: KEEP_VISIBLE ? 'inherit' : 'ignore',
      env: { ...process.env, BROWSER: 'none' },
    },
  )
  await waitFor(() => canReach(BASE_URL), 45000, `dev server ${BASE_URL}`)
  return devProc
}

async function main() {
  const devProc = await ensureDevServerReady()
  let driver = null
  try {
    const msedgedriverPath = ensureMsEdgeDriver()
    const options = new edge.Options()
    options.addArguments('--window-size=390,900')
    if (!KEEP_VISIBLE) {
      options.addArguments('--headless=new')
      options.addArguments('--disable-gpu')
    }

    driver = await new Builder()
      .forBrowser('MicrosoftEdge')
      .setEdgeOptions(options)
      .setEdgeService(new edge.ServiceBuilder(msedgedriverPath))
      .build()

    const rounds = []
    for (let round = 0; round < 8; round += 1) {
      await driver.get(BASE_URL)
      await waitFor(async () => {
        try {
          await driver.findElement(By.id('mobileMenuBtn'))
          return true
        } catch {
          return false
        }
      }, 20000, 'mobile menu button')

      await driver.executeScript(`localStorage.setItem('web_codex_workspace_target_v1', 'windows')`)
      await driver.navigate().refresh()
      await waitFor(async () => {
        try {
          await driver.findElement(By.id('mobileMenuBtn'))
          return true
        } catch {
          return false
        }
      }, 20000, 'mobile menu button after refresh')

      await sleep(500)
      await driver.executeScript(`
        const btn = document.getElementById('mobileMenuBtn');
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      `)
      await waitFor(async () => {
        const state = await driver.executeScript(`
          return {
            drawerOpen: document.body.classList.contains('drawer-left-open'),
            hasGroups: !!document.querySelector('#threadList .groupCard'),
            windowsActive: !!document.getElementById('drawerWorkspaceWindowsBtn')?.classList.contains('active'),
            opening: document.body.classList.contains('drawer-left-opening'),
            activeAnimations: Array.from(document.querySelectorAll('#threadList .groupCard'))
              .reduce((count, node) => count + (typeof node.getAnimations === 'function'
                ? node.getAnimations().filter((anim) => anim.playState === 'running').length
                : 0), 0),
          };
        `)
        return !!state?.drawerOpen && !!state?.hasGroups && !!state?.windowsActive && !state?.opening && Number(state?.activeAnimations || 0) === 0
      }, 5000, 'settled drawer open with windows groups')
      await driver.executeScript(`window.__webCodexAnimDebug.clear()`)
      await driver.executeScript(`
        const btn = document.getElementById('drawerWorkspaceWslBtn');
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      `)
      await sleep(1200)

      const result = await driver.executeScript(`
        const events = window.__webCodexAnimDebug.getEvents();
        return {
          activeWorkspace: document.getElementById('drawerWorkspaceWindowsBtn')?.classList.contains('active')
            ? 'windows'
            : (document.getElementById('drawerWorkspaceWslBtn')?.classList.contains('active') ? 'wsl2' : 'unknown'),
          starts: events.filter((x) => x.type === 'animation:start').length,
          cancels: events.filter((x) => x.type === 'animation:cancel').length,
          types: events.map((x) => x.type),
        };
      `)
      rounds.push({ round, ...result })
      if (result.activeWorkspace !== 'wsl2' || result.starts !== 1 || result.cancels !== 0) {
        throw new Error(`unexpected switch animation result: ${JSON.stringify(rounds)}`)
      }
    }

    console.log('[ui:e2e:codex-threadlist-real-switch] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-threadlist-real-switch] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

