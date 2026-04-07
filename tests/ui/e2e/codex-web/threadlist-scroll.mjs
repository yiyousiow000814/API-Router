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
    await sleep(200)
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
    // Make scrollbar sizing deterministic on Windows by disabling overlay scrollbars.
    // Otherwise, Chromium may report 0px gutter and hide differences between styled/un-styled scrollbars.
    options.addArguments('--disable-features=OverlayScrollbar,OverlayScrollbars,OverlayScrollbarFlashAfterAnyScrollUpdate')
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
        const el = await driver.findElement(By.id('threadList'))
        return !!el
      } catch {
        return false
      }
    }, 20000, 'threadList element')

    // Ensure we don't have multiple scrollbar styles: all scrollable elements should use the
    // same thin scrollbar (Image #1). We verify this by creating a generic scroll container
    // and measuring the classic scrollbar gutter. Without global styling this will be ~15-17px.
    const sbProbe = await driver.executeScript(`
      const probe = document.createElement('div');
      probe.id = '__e2e_scroll_probe';
      probe.style.cssText = 'position:fixed; left:10px; top:10px; width:220px; height:160px; overflow:scroll; background:rgba(0,0,0,0.01); z-index:999999;';
      const inner = document.createElement('div');
      inner.style.cssText = 'width:600px; height:520px;';
      probe.appendChild(inner);
      document.body.appendChild(probe);
      return {
        ok: true,
        gutter: Math.max(0, probe.offsetWidth - probe.clientWidth),
        overflowY: getComputedStyle(probe).overflowY,
      };
    `)
    if (!sbProbe?.ok) throw new Error('scroll probe failed')
    if (Number(sbProbe.gutter || 0) > 12) {
      throw new Error(`global scrollbar gutter too large: ${String(sbProbe.gutter)}px (expected <= 12px)`)
    }

    // Seed deterministic threads in-page (no gateway dependency).
    const seeded = await driver.executeScript(`
      const h = window.__webCodexE2E;
      if (!h) return { ok: false, error: '__webCodexE2E missing' };
      return h.seedThreads(260);
    `)
    if (!seeded?.ok) throw new Error(`seed failed: ${seeded?.error || 'unknown'}`)

    // Expand the first workspace group so groupBody becomes scrollable.
    await driver.executeScript(`
      const headers = Array.from(document.querySelectorAll('#threadList .groupHeader'));
      const header = headers.find((node) => node.textContent && !node.textContent.includes('Favorites')) || headers[0];
      if (header) header.click();
    `)

    const baseline = await driver.executeScript(`
      const list = document.getElementById('threadList');
      if (!list) return { ok: false, error: 'threadList missing' };
      const body = list.querySelector('.groupBody');
      if (!body) return { ok: false, error: 'groupBody missing' };
      const cards = body.querySelectorAll('.itemCard').length;
      const max = Math.max(0, body.scrollHeight - body.clientHeight);
      const next = Math.max(0, Math.min(max, Math.floor(max * 0.6)));
      body.scrollTop = next;
      return {
        ok: true,
        max,
        scrollTop: body.scrollTop,
        gutter: Math.max(0, body.offsetWidth - body.clientWidth),
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
        cards,
      };
    `)
    if (!baseline?.ok) throw new Error(`baseline failed: ${baseline?.error || 'unknown'}`)
    if (!(Number(baseline.max || 0) > 40)) {
      throw new Error(
        `threadList not scrollable; max=${baseline.max} scrollHeight=${baseline.scrollHeight} clientHeight=${baseline.clientHeight} cards=${baseline.cards} groups=${baseline.groups} bodies=${baseline.bodies} openBodies=${baseline.openBodies}`,
      )
    }

    // If a classic scrollbar gutter exists, keep it slim (we style it to ~8px).
    if (Number(baseline.gutter || 0) > 12) {
      throw new Error(`scrollbar gutter too large: ${String(baseline.gutter)}px (expected <= 12px)`)
    }

    // Trigger a re-render and ensure we don't snap back to top.
    await driver.executeScript(`window.__webCodexE2E.rerenderThreads();`)
    await sleep(250)
    const afterWait = await driver.executeScript(`
      const list = document.getElementById('threadList');
      if (!list) return { ok: false, error: 'threadList missing' };
      const body = list.querySelector('.groupBody');
      if (!body) return { ok: false, error: 'groupBody missing' };
      return { ok: true, scrollTop: body.scrollTop };
    `)
    if (!afterWait?.ok) throw new Error(`afterWait failed: ${afterWait?.error || 'unknown'}`)
    if (Math.abs(Number(afterWait.scrollTop || 0) - Number(baseline.scrollTop || 0)) > 24) {
      throw new Error(`threadList scroll jumped during idle refresh: before=${baseline.scrollTop} after=${afterWait.scrollTop}`)
    }

    console.log('[ui:e2e:codex-threadlist-scroll] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-threadlist-scroll] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

