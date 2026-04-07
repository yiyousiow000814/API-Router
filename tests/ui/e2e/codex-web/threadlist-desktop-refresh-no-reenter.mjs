import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { Builder, By } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'
import { ensureMsEdgeDriver, repoRoot } from '../../support/runtime-utils.mjs'

const BASE_URL = String(process.env.CODEX_WEB_URL || 'http://127.0.0.1:5173/codex-web?e2e=1&animdebug=1').trim()
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
    options.addArguments('--window-size=1440,900')
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
        await driver.findElement(By.id('threadList'))
        return true
      } catch {
        return false
      }
    }, 20000, 'threadList element')

    await driver.executeScript(`
      localStorage.setItem('web_codex_workspace_target_v1', 'windows');
      localStorage.setItem('web_codex_threads_cache_v1', JSON.stringify({
        windows: [
          { id: 'win_1', title: 'win_1', preview: 'win_1', cwd: 'API-Router', workspace: 'windows', updatedAt: 1001, createdAt: 1001 },
          { id: 'win_2', title: 'win_2', preview: 'win_2', cwd: 'beta', workspace: 'windows', updatedAt: 1000, createdAt: 1000 },
        ],
        wsl2: [
          { id: 'wsl_1', title: 'wsl_1', preview: 'wsl_1', cwd: '/home/yiyou/app', workspace: 'wsl2', updatedAt: 1003, createdAt: 1003 },
          { id: 'wsl_2', title: 'wsl_2', preview: 'wsl_2', cwd: '/home/yiyou/lib', workspace: 'wsl2', updatedAt: 1002, createdAt: 1002 },
        ],
        updatedAt: Date.now(),
      }));
    `)
    await driver.navigate().refresh()
    await waitFor(async () => {
      try {
        await driver.findElement(By.id('threadList'))
        return true
      } catch {
        return false
      }
    }, 20000, 'threadList element after cache refresh')

    const startupReplay = await driver.executeScript(`
      const events = window.__webCodexAnimDebug?.getEvents?.() || [];
      return {
        starts: events.filter((entry) => entry.type === 'animation:start').length,
        renderEvents: events.filter((entry) => entry.type === 'renderThreads').map((entry) => ({
          animateEnter: !!entry.animateEnter,
          pendingVisibleAnimation: !!entry.pendingVisibleAnimation,
          animateNextRender: !!entry.animateNextRender,
          listActuallyVisible: !!entry.listActuallyVisible,
          sourceCount: Number(entry.sourceCount || 0),
        })),
        groupEnterCount: document.querySelectorAll('#threadList .groupCard.groupEnter').length,
        threadEnterCount: document.querySelectorAll('#threadList .itemCard.threadEnter').length,
      };
    `)
    if (!Array.isArray(startupReplay?.renderEvents) || !startupReplay.renderEvents.some((entry) => entry.animateEnter && entry.listActuallyVisible && entry.sourceCount > 0)) {
      throw new Error(`expected cached desktop refresh render to mark animateEnter: ${JSON.stringify(startupReplay)}`)
    }
    if (Number(startupReplay?.groupEnterCount || 0) <= 0 && Number(startupReplay?.threadEnterCount || 0) <= 0) {
      throw new Error(`expected cached desktop refresh DOM to contain enter-animation classes: ${JSON.stringify(startupReplay)}`)
    }

    const seeded = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.setWorkspaceTarget !== 'function') {
          return done({ ok: false, error: 'setWorkspaceTarget missing' });
        }
        if (!window.__webCodexAnimDebug || typeof window.__webCodexAnimDebug.clear !== 'function') {
          return done({ ok: false, error: 'animdebug hook missing' });
        }
        window.__webCodexAnimDebug.clear();
        const switched = await h.setWorkspaceTarget('wsl2');
        if (!switched || !switched.ok) return done({ ok: false, error: switched?.error || 'workspace switch failed' });
        setTimeout(() => {
          const events = window.__webCodexAnimDebug.getEvents();
          done({
            ok: true,
            starts: events.filter((entry) => entry.type === 'animation:start').length,
            renderEvents: events.filter((entry) => entry.type === 'renderThreads').map((entry) => ({
              animateEnter: !!entry.animateEnter,
              pendingVisibleAnimation: !!entry.pendingVisibleAnimation,
            })),
          });
        }, 420);
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!seeded?.ok) throw new Error(`seed failed: ${seeded?.error || 'unknown'}`)
    if (!Array.isArray(seeded?.renderEvents) || !seeded.renderEvents.some((entry) => entry.animateEnter)) {
      throw new Error(`expected initial desktop workspace render to animate once: ${JSON.stringify(seeded)}`)
    }

    const refresh = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        const wslItems = [
          { id: 'wsl_1', title: 'wsl_1', preview: 'wsl_1', cwd: '/home/yiyou/app', workspace: 'wsl2', updatedAt: 1003, createdAt: 1003 },
          { id: 'wsl_2', title: 'wsl_2', preview: 'wsl_2', cwd: '/home/yiyou/lib', workspace: 'wsl2', updatedAt: 1002, createdAt: 1002 },
        ];
        if (!h || typeof h.refreshThreadsWithMock !== 'function') {
          return done({ ok: false, error: 'refreshThreadsWithMock missing' });
        }
        window.__webCodexAnimDebug.clear();
        const result = await h.refreshThreadsWithMock('wsl2', wslItems);
        if (!result || !result.ok) return done({ ok: false, error: result?.error || 'refresh failed' });
        setTimeout(() => {
          const events = window.__webCodexAnimDebug.getEvents();
          done({
            ok: true,
            starts: events.filter((entry) => entry.type === 'animation:start').length,
            renderEvents: events.filter((entry) => entry.type === 'renderThreads').map((entry) => ({
              animateEnter: !!entry.animateEnter,
              pendingVisibleAnimation: !!entry.pendingVisibleAnimation,
              animateNextRender: !!entry.animateNextRender,
            })),
            refreshData: events.filter((entry) => entry.type === 'refreshThreads:data').map((entry) => ({
              sigSame: !!entry.sigSame,
              pendingVisibleAnimation: !!entry.pendingVisibleAnimation,
              canAnimatePendingVisibleNow: !!entry.canAnimatePendingVisibleNow,
            })),
          });
        }, 160);
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!refresh?.ok) throw new Error(`refresh failed: ${refresh?.error || 'unknown'}`)

    const replay = await driver.executeScript(`
      const events = window.__webCodexAnimDebug.getEvents();
      return {
        starts: events.filter((entry) => entry.type === 'animation:start').length,
        renderEvents: events.filter((entry) => entry.type === 'renderThreads').map((entry) => ({
          animateEnter: !!entry.animateEnter,
          pendingVisibleAnimation: !!entry.pendingVisibleAnimation,
          animateNextRender: !!entry.animateNextRender,
        })),
        refreshData: events.filter((entry) => entry.type === 'refreshThreads:data').map((entry) => ({
          sigSame: !!entry.sigSame,
          pendingVisibleAnimation: !!entry.pendingVisibleAnimation,
          canAnimatePendingVisibleNow: !!entry.canAnimatePendingVisibleNow,
        })),
      };
    `)

    if (Number(replay?.starts || 0) !== 0) {
      throw new Error(`desktop same-data refresh replayed sidebar animation: ${JSON.stringify(replay)}`)
    }

    console.log('[ui:e2e:codex-threadlist-desktop-refresh-no-reenter] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-threadlist-desktop-refresh-no-reenter] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

