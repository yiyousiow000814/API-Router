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
    options.addArguments('--window-size=1366,900')
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
        await driver.findElement(By.id('mobilePromptInput'))
        return await driver.executeScript('return !!window.__webCodexE2E')
      } catch {
        return false
      }
    }, 20000, '__webCodexE2E ready')

    const prepared = await driver.executeAsyncScript(`
      const done = arguments[0];
      void (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.seedHistory !== 'function' || typeof h.openThread !== 'function') {
          return done({ ok: false, error: 'missing e2e hooks' });
        }
        const threadId = 'e2e_scroll_to_bottom_btn';
        h.seedHistory(threadId, 48, 2, 160);
        await h.openThread(threadId);
        done({ ok: true, threadId });
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)
    if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)

    await waitFor(async () => {
      const metrics = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        if (!box) return null;
        return {
          messageCount: document.querySelectorAll('#chatBox .msg').length,
          scrollHeight: box.scrollHeight,
          clientHeight: box.clientHeight,
        };
      `)
      return Number(metrics?.messageCount || 0) >= 40 && Number(metrics?.scrollHeight || 0) > Number(metrics?.clientHeight || 0) + 200
    }, 15000, 'long chat history render')

    const farUpVisible = await driver.executeScript(`
      const box = document.getElementById('chatBox');
      const btn = document.getElementById('scrollToBottomBtn');
      if (!box || !btn) return { ok: false, error: 'missing box or button' };
      box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      box.scrollTop = 0;
      box.dispatchEvent(new Event('scroll'));
      const br = btn.getBoundingClientRect();
      const cr = box.getBoundingClientRect();
      return {
        ok: true,
        shown: btn.classList.contains('show'),
        intersects: br.bottom >= cr.top && br.top <= cr.bottom && br.right >= cr.left && br.left <= cr.right,
        btnTop: Math.round(br.top),
        btnBottom: Math.round(br.bottom),
        btnLeft: Math.round(br.left),
        btnRight: Math.round(br.right),
        chatTop: Math.round(cr.top),
        chatBottom: Math.round(cr.bottom),
        chatLeft: Math.round(cr.left),
        chatRight: Math.round(cr.right),
        scrollTop: Math.round(box.scrollTop),
      };
    `)
    if (!farUpVisible?.ok) throw new Error(`far-up probe failed: ${farUpVisible?.error || 'unknown'}`)
    if (!farUpVisible.shown) {
      throw new Error(`expected scroll-to-bottom button to show after scrolling to top, got ${JSON.stringify(farUpVisible)}`)
    }
    if (!farUpVisible.intersects) {
      throw new Error(`expected scroll-to-bottom button to remain in the visible chat viewport, got ${JSON.stringify(farUpVisible)}`)
    }

    console.log('[ui:e2e:codex-scroll-to-bottom-btn] PASS')
    console.log(JSON.stringify({ farUpVisible }))
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-scroll-to-bottom-btn] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

