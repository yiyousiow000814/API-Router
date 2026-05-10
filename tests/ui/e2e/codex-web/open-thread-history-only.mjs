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

    const prepared = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.installFetchRecorder !== 'function' || typeof h.refreshThreadsWithMock !== 'function') {
          return done({ ok: false, error: 'missing e2e hooks' });
        }
        h.installFetchRecorder();
        if (typeof h.createShadowThreadForE2E !== 'function') {
          return done({ ok: false, error: 'missing createShadowThreadForE2E hook' });
        }
        const created = await h.createShadowThreadForE2E({
          threadId: 'safe-thread-open-1',
          workspace: 'windows',
          cwd: 'C:\\Users\\yiyou\\API-Router',
          prompt: 'seed thread for open history only',
          waitMs: 7200,
        });
        const threadId = String(created.threadId || 'safe-thread-open-1').trim();
        const rolloutPath = String(created.rolloutPath || '').trim();
        if (!threadId) return done({ ok: false, error: 'create thread failed' });
        const items = [
          {
            id: threadId,
            title: 'Review mock transport flow',
            preview: 'Review mock transport flow',
            cwd: 'C:\\Users\\yiyou\\API-Router',
            path: rolloutPath,
            workspace: 'windows',
            updatedAt: 1000,
            createdAt: 1000,
          }
        ];
        const seeded = await h.refreshThreadsWithMock('windows', items);
        if (!seeded || !seeded.ok) return done({ ok: false, error: 'seed threads failed' });
        done({ ok: true, threadId, rolloutPath });
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)
    const threadId = String(prepared.threadId || '').trim()
    if (!threadId) throw new Error('prepare did not return a threadId')
    const snapshot = await driver.executeScript(`
      const d = window.__webCodexDebug;
      return d && typeof d.getThreadListSnapshot === 'function' ? d.getThreadListSnapshot() : null;
    `)

    await driver.findElement(By.id('mobileMenuBtn')).click()
    const drawerOpen = await waitFor(async () => {
      const open = await driver.executeScript(`return document.body.classList.contains('drawer-left-open');`)
      return !!open
    }, 1200, 'drawer open').catch(() => false)
    if (!drawerOpen) {
      const fallback = await driver.executeScript(`
        const h = window.__webCodexE2E;
        if (!h || typeof h.setMobileTabForE2E !== 'function') {
          return { ok: false, error: 'setMobileTabForE2E missing' };
        }
        return h.setMobileTabForE2E('threads');
      `)
      if (!fallback?.ok) throw new Error(`drawer open fallback failed: ${fallback?.error || 'unknown'}`)
      await waitFor(async () => {
        const open = await driver.executeScript(`return document.body.classList.contains('drawer-left-open');`)
        return !!open
      }, 3000, 'drawer open')
    }

    const opened = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.openThread !== 'function') {
          return done({ ok: false, error: 'missing openThread hook' });
        }
        const result = await h.openThread(${JSON.stringify(threadId)});
        done(result);
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!opened?.ok) throw new Error(`open thread failed: ${opened?.error || 'unknown'}; snapshot=${JSON.stringify(snapshot)}`)

    await waitFor(async () => {
      const calls = await driver.executeScript(`
        const h = window.__webCodexE2E;
        return h && typeof h.getFetchCalls === 'function' ? h.getFetchCalls() : [];
      `)
      return Array.isArray(calls) && calls.some((call) => String(call.url || '').includes('/history'))
    }, 3000, 'history fetch')

    const calls = await driver.executeScript(`
      const h = window.__webCodexE2E;
      return h && typeof h.getFetchCalls === 'function' ? h.getFetchCalls() : [];
    `)
    const historyCalls = calls.filter((call) => String(call.url || '').includes('/history'))
    const resumeCalls = calls.filter((call) => String(call.url || '').includes('/resume'))
    if (historyCalls.length !== 1) {
      throw new Error(`expected exactly 1 history fetch, got ${historyCalls.length}: ${JSON.stringify(calls)}`)
    }
    if (resumeCalls.length !== 0) {
      throw new Error(`expected 0 resume fetches on thread open, got ${resumeCalls.length}: ${JSON.stringify(calls)}`)
    }

    console.log('[ui:e2e:codex-open-thread-history-only] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-open-thread-history-only] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})
