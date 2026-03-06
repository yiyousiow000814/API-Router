import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { Builder, By } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'
import { ensureMsEdgeDriver, repoRoot } from './ui-check/runtime-utils.mjs'

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
    await sleep(100)
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

    const seeded = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.refreshThreadsWithMock !== 'function') {
          return done({ ok: false, error: 'refreshThreadsWithMock missing' });
        }
        const items = [
          { id: 'b1', title: 'b1', preview: 'b1', cwd: 'Zulu', workspace: 'windows', updatedAt: 1000, createdAt: 1000 },
          { id: 'a1', title: 'a1', preview: 'a1', cwd: 'API-Router', workspace: 'windows', updatedAt: 1001, createdAt: 1001 },
          { id: 'c1', title: 'c1', preview: 'c1', cwd: 'beta', workspace: 'windows', updatedAt: 1002, createdAt: 1002 }
        ];
        const r = await h.refreshThreadsWithMock('windows', items);
        done(r);
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!seeded?.ok) throw new Error(`seed failed: ${seeded?.error || 'unknown'}`)

    await driver.findElement(By.id('mobileMenuBtn')).click()

    await waitFor(async () => {
      const open = await driver.executeScript(`return document.body.classList.contains('drawer-left-open');`)
      return !!open
    }, 3000, 'drawer open')

    const earlyFrame = await driver.executeScript(`
      const first = document.querySelector('#threadList .groupCard');
      if (!first) return { ok: false, error: 'first group missing' };
      const style = getComputedStyle(first);
      return {
        ok: true,
        opacity: Number.parseFloat(String(style.opacity || '1')),
        classes: first.className,
        groups: Array.from(document.querySelectorAll('#threadList .groupHeader .itemTitle')).map((node) => String(node.textContent || '').trim()),
      };
    `)
    if (!earlyFrame?.ok) throw new Error(`early frame failed: ${earlyFrame?.error || 'unknown'}`)
    if (!(Number(earlyFrame.opacity) < 0.98)) {
      throw new Error(`expected sidebar-open group enter animation to still be in progress; opacity=${earlyFrame.opacity}, classes=${earlyFrame.classes}`)
    }
    const expectedOrder = ['API-Router', 'beta', 'Zulu']
    if (JSON.stringify(earlyFrame.groups) !== JSON.stringify(expectedOrder)) {
      throw new Error(`expected alphabetical groups ${JSON.stringify(expectedOrder)}; got ${JSON.stringify(earlyFrame.groups)}`)
    }

    await waitFor(async () => {
      const settled = await driver.executeScript(`
        const first = document.querySelector('#threadList .groupCard');
        if (!first) return { ok: false };
        const style = getComputedStyle(first);
        return { ok: true, opacity: Number.parseFloat(String(style.opacity || '0')) };
      `)
      return !!settled?.ok && Number(settled.opacity) >= 0.99
    }, 1500, 'group enter animation settle')

    console.log('[ui:e2e:codex-threadlist-enter] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-threadlist-enter] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})
