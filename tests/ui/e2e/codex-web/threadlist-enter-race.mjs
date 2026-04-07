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
    await sleep(60)
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

    const result = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.refreshThreadsWithMockDelay !== 'function' || typeof h.setMobileTabForE2E !== 'function') {
          return done({ ok: false, error: 'refreshThreadsWithMockDelay/setMobileTabForE2E missing' });
        }
        const backdrop = document.getElementById('mobileDrawerBackdrop');
        const items = [
          { id: 'b1', title: 'b1', preview: 'b1', cwd: 'Zulu', workspace: 'windows', updatedAt: 1000, createdAt: 1000 },
          { id: 'a1', title: 'a1', preview: 'a1', cwd: 'API-Router', workspace: 'windows', updatedAt: 1001, createdAt: 1001 },
          { id: 'c1', title: 'c1', preview: 'c1', cwd: 'beta', workspace: 'windows', updatedAt: 1002, createdAt: 1002 }
        ];
        const failures = [];
        const waitForDrawerOpen = () => new Promise((resolve) => {
          const started = Date.now();
          const tick = () => {
            if (document.body.classList.contains('drawer-left-open')) {
              resolve(true);
              return;
            }
            if (Date.now() - started > 400) {
              resolve(false);
              return;
            }
            setTimeout(tick, 16);
          };
          tick();
        });
        const scenarios = [
          { delayMs: 0, clickDelayMs: 0 },
          { delayMs: 20, clickDelayMs: 0 },
          { delayMs: 60, clickDelayMs: 0 },
          { delayMs: 120, clickDelayMs: 0 },
          { delayMs: 20, clickDelayMs: 20 },
          { delayMs: 60, clickDelayMs: 20 },
          { delayMs: 120, clickDelayMs: 20 },
          { delayMs: 20, clickDelayMs: 60 },
          { delayMs: 60, clickDelayMs: 60 },
          { delayMs: 120, clickDelayMs: 60 }
        ];
        for (let i = 0; i < scenarios.length; i += 1) {
          const scenario = scenarios[i];
          document.body.classList.remove('drawer-left-open', 'drawer-right-open', 'drawer-left-opening', 'drawer-right-opening');
          if (backdrop) backdrop.classList.remove('show');
          document.getElementById('threadList').innerHTML = '';
          await new Promise((resolve) => setTimeout(resolve, 30));
          let firstVisibleSample = null;
          const list = document.getElementById('threadList');
          const sampleFirstGroup = () => {
            if (!document.body.classList.contains('drawer-left-open')) return null;
            const first = document.querySelector('#threadList .groupCard');
            if (!first) return null;
            const style = getComputedStyle(first);
            const animations = typeof first.getAnimations === 'function'
              ? first.getAnimations().map((anim) => ({
                  playState: String(anim.playState || ''),
                  currentTime: Number(anim.currentTime || 0),
                }))
              : [];
            return {
              opacity: Number.parseFloat(String(style.opacity || '1')),
              className: first.className,
              animationName: String(style.animationName || ''),
              animationPlayState: String(style.animationPlayState || ''),
              animations,
              opening: document.body.classList.contains('drawer-left-opening'),
              open: document.body.classList.contains('drawer-left-open'),
            };
          };
          const observer = new MutationObserver(() => {
            const first = document.querySelector('#threadList .groupCard');
            if (!first || firstVisibleSample) return;
            firstVisibleSample = sampleFirstGroup();
          });
          observer.observe(list, { childList: true, subtree: true });
          const refreshTask = h.refreshThreadsWithMockDelay('windows', items, scenario.delayMs);
          await new Promise((resolve) => setTimeout(resolve, scenario.clickDelayMs));
          h.setMobileTabForE2E('threads');
          await waitForDrawerOpen();
          await refreshTask;
          const firstVisible = await new Promise((resolve) => {
            const started = Date.now();
            const tick = () => {
              const current = sampleFirstGroup();
              if (current) {
                requestAnimationFrame(() => {
                  resolve({
                    ...(firstVisibleSample || current),
                  });
                });
                return;
              }
              if (Date.now() - started > 1600) {
                resolve({
                  opacity: 1,
                  className: '',
                  animationName: '',
                  animationPlayState: '',
                  animations: [],
                  opening: document.body.classList.contains('drawer-left-opening'),
                  open: document.body.classList.contains('drawer-left-open'),
                });
                return;
              }
              setTimeout(tick, 20);
            };
            tick();
          });
          const restartSample = await new Promise((resolve) => {
            const started = Date.now();
            let sawPlainAfterEnter = false;
            const watch = () => {
              const current = sampleFirstGroup();
              if (current?.className?.includes('groupEnter')) {
                if (sawPlainAfterEnter) {
                  resolve({
                    restarted: true,
                    current,
                  });
                  return;
                }
              } else if (firstVisible.className?.includes('groupEnter')) {
                sawPlainAfterEnter = true;
              }
              if (Date.now() - started > 520) {
                resolve({ restarted: false, current });
                return;
              }
              setTimeout(watch, 16);
            };
            watch();
          });
          observer.disconnect();
          failures.push({
            iteration: i,
            delayMs: scenario.delayMs,
            clickDelayMs: scenario.clickDelayMs,
            opacity: firstVisible.opacity,
            opening: firstVisible.opening,
            open: firstVisible.open,
            loading: !!document.querySelector('#threadList .threadListState'),
            className: firstVisible.className,
            animationName: firstVisible.animationName,
            animationPlayState: firstVisible.animationPlayState,
            animations: firstVisible.animations,
            restarted: !!restartSample?.restarted,
          });
          if (firstVisible.opacity >= 0.98) {
            return done({ ok: false, error: 'missing-enter-animation', samples: failures });
          }
          if (restartSample?.restarted) {
            return done({ ok: false, error: 'enter-animation-restarted', samples: failures });
          }
          document.body.classList.remove('drawer-left-open', 'drawer-right-open', 'drawer-left-opening', 'drawer-right-opening');
          if (backdrop) backdrop.classList.remove('show');
        }
        done({ ok: true, samples: failures });
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)

    if (!result?.ok) {
      throw new Error(`race repro caught missing animation: ${JSON.stringify(result?.samples || result)}`)
    }

    const workspaceSwitchResult = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.refreshThreadsWithMock !== 'function' || typeof h.setMobileTabForE2E !== 'function') {
          return done({ ok: false, error: 'refreshThreadsWithMock/setMobileTabForE2E missing' });
        }
        const backdrop = document.getElementById('mobileDrawerBackdrop');
        const windowsItems = [
          { id: 'w1', title: 'w1', preview: 'w1', cwd: 'API-Router', workspace: 'windows', updatedAt: 1001, createdAt: 1001 },
          { id: 'w2', title: 'w2', preview: 'w2', cwd: 'beta', workspace: 'windows', updatedAt: 1000, createdAt: 1000 }
        ];
        const wslItems = [
          { id: 'l1', title: 'l1', preview: 'l1', cwd: '/home/yiyou/Automated-Supertrend-Trading', workspace: 'wsl2', updatedAt: 1003, createdAt: 1003 }
        ];
        await h.refreshThreadsWithMock('windows', windowsItems);
        await h.refreshThreadsWithMock('wsl2', wslItems);
        document.body.classList.remove('drawer-left-open', 'drawer-right-open', 'drawer-left-opening', 'drawer-right-opening');
        if (backdrop) backdrop.classList.remove('show');
        const list = document.getElementById('threadList');
        if (list) list.innerHTML = '';
        if (typeof h.setWorkspaceTarget === 'function') {
          await h.setWorkspaceTarget('windows');
          await h.setWorkspaceTarget('wsl2');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        h.setMobileTabForE2E('threads');
        await new Promise((resolve) => {
          const started = Date.now();
          const tick = () => {
            if (document.body.classList.contains('drawer-left-open')) {
              resolve();
              return;
            }
            if (Date.now() - started > 400) {
              resolve();
              return;
            }
            setTimeout(tick, 16);
          };
          tick();
        });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const first = document.querySelector('#threadList .groupCard');
        if (!first) return done({ ok: false, error: 'group missing after workspace switch' });
        const style = getComputedStyle(first);
        done({
          ok: Number.parseFloat(String(style.opacity || '1')) < 0.98,
          opacity: Number.parseFloat(String(style.opacity || '1')),
          className: first.className,
        });
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!workspaceSwitchResult?.ok) {
      throw new Error(`workspace switch repro caught missing animation: ${JSON.stringify(workspaceSwitchResult)}`)
    }

    console.log('[ui:e2e:codex-threadlist-enter-race] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-threadlist-enter-race] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

