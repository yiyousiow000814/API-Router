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
    options.addArguments('--window-size=390,720')
    options.addArguments('--force-device-scale-factor=1')
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
    // Keep them in one directory so expanding one group creates a tall drawer list.
    const seeded = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      const h = window.__webCodexE2E;
      const debug = window.__webCodexDebug;
      if (!h) {
        done({ ok: false, error: '__webCodexE2E missing' });
        return;
      }
      let refreshPaused = false;
      if (typeof h.pauseThreadRefreshForE2E === 'function') {
        try {
          h.pauseThreadRefreshForE2E(true);
          refreshPaused = true;
        } catch {}
      }
      const snapshot = debug && typeof debug.getThreadListSnapshot === 'function'
        ? debug.getThreadListSnapshot()
        : null;
      const workspace = snapshot && snapshot.workspaceTarget ? snapshot.workspaceTarget : 'windows';
      const pathFor = (name) => workspace === 'wsl2' ? '/home/yiyou/' + name : 'C:\\\\Users\\\\yiyou\\\\' + name;
      const items = [
        ...Array.from({ length: 6 }, (_, i) => ({
          id: 'e2e_api_router_' + i,
          title: 'API Router ' + i,
          updatedAt: Date.now() - i * 1000,
          workspace,
          cwd: pathFor('API-Router'),
        })),
        ...Array.from({ length: 180 }, (_, i) => ({
          id: 'e2e_scroll_' + i,
          title: 'Thread ' + i,
          updatedAt: Date.now() - (i + 6) * 1000,
          workspace,
          cwd: pathFor('XAUUSD-Calendar-Agent'),
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          id: 'e2e_automation_' + i,
          title: 'Automation ' + i,
          updatedAt: Date.now() - (i + 220) * 1000,
          workspace,
          cwd: pathFor('xauusd-calendar-automation'),
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          id: 'e2e_yiyou_' + i,
          title: 'Yiyou ' + i,
          updatedAt: Date.now() - (i + 260) * 1000,
          workspace,
          cwd: pathFor('yiyou'),
        })),
      ];
      const finish = (result) => {
        if (h && typeof h.setMobileTabForE2E === 'function') {
          try { h.setMobileTabForE2E('threads'); } catch {}
        }
        if (!refreshPaused && result && result.ok && typeof h.seedThreads === 'function' && typeof h.rerenderThreads === 'function') {
          try {
            if (window.__webCodexE2EThreadSeedTimer) clearInterval(window.__webCodexE2EThreadSeedTimer);
            window.__webCodexE2EThreadSeedTimer = setInterval(() => {
              try {
                h.seedThreads(items);
                h.rerenderThreads();
              } catch {}
            }, 120);
          } catch {}
        }
        done({ ...(result || {}), workspace, count: items.length });
      };
      const result = h.seedThreads ? h.seedThreads(items) : { ok: false, error: 'seedThreads missing' };
      if (result && result.ok && typeof h.rerenderThreads === 'function') {
        try { h.rerenderThreads(); } catch {}
      }
      finish(result);
    `)
    if (!seeded?.ok) throw new Error(`seed failed: ${seeded?.error || 'unknown'}`)
    const seedSnapshot = await driver.executeScript(`
      const list = document.getElementById('threadList');
      if (!list) return { ok: false, error: 'threadList missing' };
      return {
        ok: true,
        text: String(list.textContent || '').slice(0, 240),
        cards: list.querySelectorAll('.itemCard').length,
        groups: list.querySelectorAll('.groupCard').length,
        headers: Array.from(list.querySelectorAll('.groupHeader')).map((node) => String(node.textContent || '').trim()),
        bodies: list.querySelectorAll('.groupBody').length,
      };
    `)
    if (!seedSnapshot?.ok) throw new Error(`seed snapshot failed: ${seedSnapshot?.error || 'unknown'}`)

    await waitFor(async () => {
      try {
        return await driver.executeScript(`
          const list = document.getElementById('threadList');
          if (!list) return false;
          const headers = Array.from(list.querySelectorAll('.groupHeader'));
          const header = headers.find((node) => /XAUUSD-Calendar-Agent/i.test(node.textContent || '')) ||
            headers.find((node) => node.textContent && !node.textContent.includes('Favorites')) ||
            headers[0];
          const group = header ? header.closest('.groupCard') : null;
          const body = group ? group.querySelector('.groupBody') : null;
          const count = body ? body.querySelectorAll('.itemCard').length : 0;
          if (body && body.offsetHeight > 0 && count > 40) return true;
          if (header && (!body || header.classList.contains('is-collapsed') || count <= 40)) header.click();
          return false;
        `)
      } catch {
        return false
      }
    }, 5000, `expanded thread group after seed ${JSON.stringify(seedSnapshot)}`)

    const baseline = await driver.executeScript(`
      const list = document.getElementById('threadList');
      if (!list) return { ok: false, error: 'threadList missing' };
      const body = list.querySelector('.groupBody');
      if (!body) return { ok: false, error: 'groupBody missing' };
      const cards = list.querySelectorAll('.itemCard').length;
      const groups = list.querySelectorAll('.groupCard').length;
      const bodies = list.querySelectorAll('.groupBody').length;
      const openBodies = Array.from(list.querySelectorAll('.groupBody')).filter((node) => node.offsetHeight > 0).length;
      const bodyMax = Math.max(0, body.scrollHeight - body.clientHeight);
      const bodyOverflowY = getComputedStyle(body).overflowY;
      const max = Math.max(0, list.scrollHeight - list.clientHeight);
      const next = Math.max(0, Math.min(max, Math.floor(max * 0.6)));
      list.scrollTop = next;
      return {
        ok: true,
        max,
        bodyMax,
        scrollTop: list.scrollTop,
        gutter: Math.max(0, list.offsetWidth - list.clientWidth),
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        cards,
        groups,
        bodies,
        openBodies,
        bodyOverflowY,
      };
    `)
    if (!baseline?.ok) throw new Error(`baseline failed: ${baseline?.error || 'unknown'}`)
    if (!(Number(baseline.max || 0) > 40)) {
      throw new Error(
        `threadList not scrollable; max=${baseline.max} bodyMax=${baseline.bodyMax} scrollHeight=${baseline.scrollHeight} clientHeight=${baseline.clientHeight} cards=${baseline.cards} groups=${baseline.groups} bodies=${baseline.bodies} openBodies=${baseline.openBodies}`,
      )
    }
    if (/auto|scroll/i.test(String(baseline.bodyOverflowY || ''))) {
      throw new Error(`groupBody should not own scrolling; bodyMax=${baseline.bodyMax} overflowY=${baseline.bodyOverflowY}`)
    }

    // If a classic scrollbar gutter exists, keep it slim (we style it to ~8px).
    if (Number(baseline.gutter || 0) > 12) {
      throw new Error(`scrollbar gutter too large: ${String(baseline.gutter)}px (expected <= 12px)`)
    }

    // Trigger a re-render and ensure we don't snap back to top.
    await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      const h = window.__webCodexE2E;
      if (!h || typeof h.rerenderThreads !== 'function') {
        done({ ok: false, error: 'rerenderThreads missing' });
        return;
      }
      Promise.resolve(h.rerenderThreads()).then(done, (error) => {
        done({ ok: false, error: String(error && error.message ? error.message : error) });
      });
    `)
    await sleep(250)
    const afterWait = await driver.executeScript(`
      const list = document.getElementById('threadList');
      if (!list) return { ok: false, error: 'threadList missing' };
      return {
        ok: true,
        scrollTop: list.scrollTop,
        max: Math.max(0, list.scrollHeight - list.clientHeight),
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        cards: list.querySelectorAll('.itemCard').length,
        groups: list.querySelectorAll('.groupCard').length,
        bodies: list.querySelectorAll('.groupBody').length,
        openBodies: Array.from(list.querySelectorAll('.groupBody')).filter((node) => node.offsetHeight > 0).length,
        lastGroupText: String(Array.from(list.querySelectorAll('.groupHeader')).at(-1)?.textContent || '').trim(),
      };
    `)
    if (!afterWait?.ok) throw new Error(`afterWait failed: ${afterWait?.error || 'unknown'}`)
    if (Math.abs(Number(afterWait.scrollTop || 0) - Number(baseline.scrollTop || 0)) > 24) {
      throw new Error(
        `threadList scroll jumped during idle refresh: before=${baseline.scrollTop} after=${afterWait.scrollTop} max=${afterWait.max} scrollHeight=${afterWait.scrollHeight} clientHeight=${afterWait.clientHeight} cards=${afterWait.cards} groups=${afterWait.groups} bodies=${afterWait.bodies} openBodies=${afterWait.openBodies}`,
      )
    }
    await driver.executeScript(`
      const list = document.getElementById('threadList');
      if (list) list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    `)
    const bottom = await driver.executeScript(`
      const list = document.getElementById('threadList');
      if (!list) return { ok: false, error: 'threadList missing' };
      const headers = Array.from(list.querySelectorAll('.groupHeader'));
      const last = headers.at(-1);
      const rect = last ? last.getBoundingClientRect() : null;
      const listRect = list.getBoundingClientRect();
      return {
        ok: true,
        lastGroupText: String(last?.textContent || '').trim(),
        lastGroupVisible: !!rect && rect.bottom <= listRect.bottom + 2 && rect.top >= listRect.top - 2,
        scrollTop: list.scrollTop,
        max: Math.max(0, list.scrollHeight - list.clientHeight),
      };
    `)
    if (!bottom?.ok) throw new Error(`bottom failed: ${bottom?.error || 'unknown'}`)
    if (!/yiyou/i.test(String(bottom.lastGroupText || '')) || !bottom.lastGroupVisible) {
      throw new Error(`bottom group not reachable; text=${bottom.lastGroupText} visible=${bottom.lastGroupVisible} scrollTop=${bottom.scrollTop} max=${bottom.max}`)
    }

    const collapsed = await driver.executeScript(`
      const list = document.getElementById('threadList');
      if (!list) return { ok: false, error: 'threadList missing' };
      const headers = Array.from(list.querySelectorAll('.groupHeader'));
      const target = headers.find((node) => /XAUUSD-Calendar-Agent/i.test(node.textContent || '')) ||
        headers.find((node) => !node.classList.contains('is-collapsed')) ||
        headers[0];
      if (!target) return { ok: false, error: 'group header missing' };
      const group = target.closest('.groupCard');
      const body = group ? group.querySelector('.groupBody') : null;
      if (!body) return { ok: false, error: 'group body missing' };
      list.scrollTop = 0;
      if (!target.classList.contains('is-collapsed')) target.click();
      return new Promise((resolve) => {
        setTimeout(() => {
          const max = Math.max(0, list.scrollHeight - list.clientHeight);
          resolve({
            ok: true,
            bodyCollapsed: body.classList.contains('collapsed'),
            bodyOverflowY: getComputedStyle(body).overflowY,
            bodyHeight: body.getBoundingClientRect().height,
            max,
            scrollHeight: list.scrollHeight,
            clientHeight: list.clientHeight,
            cards: body.querySelectorAll('.itemCard').length,
          });
        }, 320);
      });
    `)
    if (!collapsed?.ok) throw new Error(`collapsed check failed: ${collapsed?.error || 'unknown'}`)
    if (!collapsed.bodyCollapsed || !/hidden/i.test(String(collapsed.bodyOverflowY || ''))) {
      throw new Error(`collapsed group body should hide overflowing cards; collapsed=${collapsed.bodyCollapsed} overflowY=${collapsed.bodyOverflowY}`)
    }
    if (Number(collapsed.cards || 0) > 40 && Number(collapsed.max || 0) > 600) {
      throw new Error(
        `collapsed group still inflates drawer scroll range; max=${collapsed.max} scrollHeight=${collapsed.scrollHeight} clientHeight=${collapsed.clientHeight} bodyHeight=${collapsed.bodyHeight} cards=${collapsed.cards}`,
      )
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
