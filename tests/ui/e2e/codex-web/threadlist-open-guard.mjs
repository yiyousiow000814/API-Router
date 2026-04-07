import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { Builder, By } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'
import { ensureMsEdgeDriver, repoRoot } from '../../support/runtime-utils.mjs'

const BASE_URL = String(process.env.CODEX_WEB_URL || 'http://127.0.0.1:5173/codex-web?e2e=1').trim()
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

    await driver.get(BASE_URL)
    await waitFor(async () => {
      try {
        await driver.findElement(By.id('mobileMenuBtn'))
        return true
      } catch {
        return false
      }
    }, 20000, 'mobile menu button')

    const result = await driver.executeScript(`
      const btn = document.getElementById('mobileMenuBtn');
      if (!btn) return { ok: false, error: 'mobileMenuBtn missing' };
      document.body.classList.remove('drawer-left-open', 'drawer-right-open', 'drawer-left-opening', 'drawer-right-opening');
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }));
      const afterPointerdown = {
        open: document.body.classList.contains('drawer-left-open'),
        opening: document.body.classList.contains('drawer-left-opening'),
      };
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const afterClick = {
        open: document.body.classList.contains('drawer-left-open'),
        opening: document.body.classList.contains('drawer-left-opening'),
      };
      return { ok: true, afterPointerdown, afterClick };
    `)

    if (!result?.ok) throw new Error(`probe failed: ${result?.error || 'unknown'}`)
    if (!result.afterPointerdown?.opening) {
      throw new Error(`expected pointerdown to start drawer opening, got ${JSON.stringify(result)}`)
    }
    if (!result.afterClick?.opening) {
      throw new Error(`expected follow-up click to be ignored and preserve drawer opening state, got ${JSON.stringify(result)}`)
    }

    console.log('[ui:e2e:codex-threadlist-open-guard] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-threadlist-open-guard] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

