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
        await driver.findElement(By.id('mobilePromptInput'))
        return await driver.executeScript('return !!window.__webCodexE2E && !!window.__webCodexDebug')
      } catch {
        return false
      }
    }, 20000, '__webCodexE2E ready')

    const prepared = await driver.executeAsyncScript(`
      const done = arguments[0];
      void (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.openThread !== 'function') {
          return done({ ok: false, error: 'missing e2e history hooks' });
        }
        const threadId = '019c8000-0000-7000-8000-0000000000c1';
        h.setThreadHistory(threadId, {
          id: threadId,
          modelName: 'gpt-5.3-codex',
          page: { incomplete: true },
          turns: [
            {
              id: 'turn-1',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'show runtime panels' }] },
              ],
            },
          ],
        });
        await h.openThread(threadId);
        done({ ok: true, threadId });
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)
    if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)

    await waitFor(async () => {
      const count = await driver.executeScript(`return document.querySelectorAll('#chatBox .msg').length;`)
      return Number(count || 0) >= 1
    }, 10000, 'seeded thread render')

    const seededPanels = await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      if (!h || typeof h.seedRuntimePanels !== 'function') {
        return done({ ok: false, error: 'seedRuntimePanels missing' });
      }
      done(h.seedRuntimePanels({
        threadId: '019c8000-0000-7000-8000-0000000000c1',
        commands: [
          {
            key: 'live-tool-1',
            text: 'rg -n "runtimeDock|runtimeActivityBar|runtimeToolItemText|runtimeActivityText|chatOpeningOverlay" codex-web.html src/ui/modules/codex-web',
            state: 'running',
            icon: 'command',
            title: 'Running command',
            detail: 'rg -n "runtimeDock|runtimeActivityBar|runtimeToolItemText|runtimeActivityText|chatOpeningOverlay" codex-web.html src/ui/modules/codex-web',
            label: 'rg -n "runtimeDock|runtimeActivityBar|runtimeToolItemText|runtimeActivityText|chatOpeningOverlay" codex-web.html src/ui/modules/codex-web',
            presentation: 'code',
          },
        ],
        plan: {
          turnId: 'turn-live',
          title: 'Updated Plan',
          explanation: 'Inspect runtime jitter',
          steps: [{ step: 'Track plan re-entry', status: 'in_progress' }],
          deltaText: '',
        },
      }));
    `)
    if (!seededPanels?.ok) throw new Error(`seed runtime panels failed: ${seededPanels?.error || 'unknown'}`)

    try {
      await waitFor(async () => {
        const state = await driver.executeScript(`
          return {
            toolHtml: document.querySelector('#runtimeToolInline')?.innerHTML || '',
            planHtml: document.querySelector('#runtimePlanInline')?.innerHTML || '',
          };
        `)
        return state.toolHtml.includes('live-tool-1') &&
          state.toolHtml.includes('runtimeToolItemEnter') &&
          state.planHtml.includes('runtimePlanCardEnter')
      }, 5000, 'initial live runtime card and plan enter classes')
    } catch (error) {
      const debug = await driver.executeScript(`
        return {
          toolHtml: document.querySelector('#runtimeToolInline')?.outerHTML || '',
          planHtml: document.querySelector('#runtimePlanInline')?.outerHTML || '',
          runtimeDockHtml: document.querySelector('#runtimeDock')?.outerHTML || '',
          active: window.__webCodexDebug?.getActiveState?.() || null,
          liveEvents: window.__webCodexDebug?.getRecentLiveEvents?.(30) || [],
        };
      `)
      throw new Error(`${error.message}; debug=${JSON.stringify(debug)}`)
    }

    const beforeHistory = await driver.executeScript(`
      const node = document.querySelector('#runtimeToolInline');
      const planNode = document.querySelector('#runtimePlanInline');
      const items = Array.from(document.querySelectorAll('#runtimeToolInline .runtimeToolItem')).map((item) => ({
        key: item.getAttribute('data-command-key') || '',
        className: item.className,
        text: String(item.textContent || '').trim(),
      }));
      return {
        toolHtml: node?.innerHTML || '',
        planHtml: planNode?.innerHTML || '',
        items,
        liveEvents: window.__webCodexDebug?.getRecentLiveEvents?.(20) || [],
      };
    `)

    await driver.executeAsyncScript(`
      const done = arguments[0];
      void (async () => {
        const h = window.__webCodexE2E;
        const threadId = '019c8000-0000-7000-8000-0000000000c1';
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.refreshActiveThread !== 'function') {
          return done({ ok: false, error: 'missing refresh hooks' });
        }
        h.setThreadHistory(threadId, {
          id: threadId,
          modelName: 'gpt-5.3-codex',
          page: { incomplete: true },
          turns: [
            {
              id: 'turn-1',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'show runtime panels' }] },
                {
                  id: 'history-tool-77',
                  type: 'commandExecution',
                  command: 'rg -n "runtimeDock|runtimeActivityBar|runtimeToolItemText|runtimeActivityText|chatOpeningOverlay" codex-web.html src/ui/modules/codex-web',
                  status: 'running',
                },
                {
                  id: 'plan-history-77',
                  type: 'plan',
                  text: 'Track plan re-entry',
                },
              ],
            },
          ],
        });
        await h.refreshActiveThread();
        done({ ok: true });
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)

    await waitFor(async () => {
      const state = await driver.executeScript(`
        return {
          toolHtml: document.querySelector('#runtimeToolInline')?.innerHTML || '',
          planHtml: document.querySelector('#runtimePlanInline')?.innerHTML || '',
        };
      `)
      return state.toolHtml.includes('history-tool-77') && state.planHtml.includes('Track plan re-entry')
    }, 5000, 'history remapped runtime card')

    const afterHistory = await driver.executeScript(`
      const node = document.querySelector('#runtimeToolInline');
      const planNode = document.querySelector('#runtimePlanInline');
      const items = Array.from(document.querySelectorAll('#runtimeToolInline .runtimeToolItem')).map((item) => ({
        key: item.getAttribute('data-command-key') || '',
        className: item.className,
        text: String(item.textContent || '').trim(),
      }));
      return {
        toolHtml: node?.innerHTML || '',
        planHtml: planNode?.innerHTML || '',
        items,
        liveEvents: window.__webCodexDebug?.getRecentLiveEvents?.(30) || [],
        active: window.__webCodexDebug?.getActiveState?.() || null,
      };
    `)

    if (String(afterHistory.toolHtml || '').includes('runtimeToolItemEnter')) {
      throw new Error(`runtime tool card re-entered after history refresh: ${JSON.stringify({ beforeHistory, afterHistory })}`)
    }

    if (String(afterHistory.planHtml || '').includes('runtimePlanCardEnter')) {
      throw new Error(`runtime plan card re-entered after history refresh: ${JSON.stringify({ beforeHistory, afterHistory })}`)
    }

    const mobileClamp = await driver.executeScript(`
      const toolText = document.querySelector('#runtimeToolInline .runtimeToolItemText');
      const activityText = document.querySelector('#runtimeActivityBar .runtimeActivityText');
      const read = (node) => {
        if (!node) return null;
        const style = getComputedStyle(node);
        const lineHeight = Number.parseFloat(style.lineHeight || '0') || 0;
        const rect = node.getBoundingClientRect();
        return {
          text: String(node.textContent || '').trim(),
          lineHeight,
          height: rect.height,
          lineClamp: style.webkitLineClamp || '',
          whiteSpace: style.whiteSpace || '',
        };
      };
      return {
        tool: read(toolText),
        activity: read(activityText),
      };
    `)
    const toolHeight = Number(mobileClamp?.tool?.height || 0)
    const toolLineHeight = Number(mobileClamp?.tool?.lineHeight || 0)
    const activityHeight = Number(mobileClamp?.activity?.height || 0)
    const activityLineHeight = Number(mobileClamp?.activity?.lineHeight || 0)
    if (!(toolHeight > toolLineHeight * 1.35 && toolHeight <= toolLineHeight * 2.7)) {
      throw new Error(`expected mobile runtime tool text to use up to two readable lines, got ${JSON.stringify(mobileClamp)}`)
    }
    if (!(activityHeight > 0 && activityHeight <= activityLineHeight * 1.35)) {
      throw new Error(`expected mobile runtime activity text to stay single-line, got ${JSON.stringify(mobileClamp)}`)
    }

    console.log('[ui:e2e:codex-runtime-panels-no-reenter] PASS')
    console.log(JSON.stringify({ beforeHistory, afterHistory, mobileClamp }))
  } finally {
    if (driver) await driver.quit().catch(() => {})
    if (devProc) killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-runtime-panels-no-reenter] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

