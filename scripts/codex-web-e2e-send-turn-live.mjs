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
        await driver.findElement(By.id('mobilePromptInput'))
        const ok = await driver.executeScript('return !!window.__webCodexE2E && !!window.__webCodexDebug;')
        return !!ok
      } catch {
        return false
      }
    }, 20000, '__webCodexE2E ready')

    const prepared = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.openThread !== 'function' || typeof h.installMockTurnStream !== 'function') {
          return done({ ok: false, error: 'missing e2e history hooks' });
        }
        const threadId = '019c8000-0000-7000-8000-0000000000a1';
        h.setThreadHistory(threadId, {
          id: threadId,
          modelName: 'gpt-5.3-codex',
          turns: [
            {
              id: 't1',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'older user' }] },
                { type: 'assistantMessage', text: 'older assistant' },
              ],
            },
          ],
        });
        await h.openThread(threadId);
        window.__e2eErrors = [];
        window.addEventListener('error', (event) => {
          window.__e2eErrors.push({
            type: 'error',
            message: String(event?.message || ''),
            stack: String(event?.error?.stack || ''),
          });
        });
        window.addEventListener('unhandledrejection', (event) => {
          window.__e2eErrors.push({
            type: 'unhandledrejection',
            message: String(event?.reason?.message || event?.reason || ''),
            stack: String(event?.reason?.stack || ''),
          });
        });
        done({ ok: true, threadId });
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)

    await waitFor(async () => {
      const count = await driver.executeScript(`return document.querySelectorAll('#chatBox .msg').length;`)
      return Number(count || 0) >= 2
    }, 10000, 'seeded thread render')

    const seededPending = await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      if (!h || typeof h.seedPendingTurn !== 'function') {
        return done({ ok: false, error: 'seedPendingTurn missing' });
      }
      done(h.seedPendingTurn({
        threadId: '019c8000-0000-7000-8000-0000000000a1',
        prompt: 'new live turn',
      }));
    `)
    if (!seededPending?.ok) throw new Error(`seed pending turn failed: ${seededPending?.error || 'unknown'}`)

    const refreshedStaleHistory = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        const threadId = '019c8000-0000-7000-8000-0000000000a1';
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.refreshActiveThread !== 'function') {
          return done({ ok: false, error: 'missing history refresh hooks' });
        }
        h.setThreadHistory(threadId, {
          id: threadId,
          modelName: 'gpt-5.3-codex',
          page: { incomplete: true },
          turns: [
            {
              id: 't-stale',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'older user' }] },
                { type: 'agentMessage', id: 'commentary-stale', phase: 'commentary', text: '构建已完成。' },
                { type: 'commandExecution', command: 'npm run build', status: 'running' },
              ],
            },
          ],
        });
        await h.refreshActiveThread();
        done({ ok: true });
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!refreshedStaleHistory?.ok) {
      throw new Error(`refresh stale history failed: ${refreshedStaleHistory?.error || 'unknown'}`)
    }

    try {
      await waitFor(async () => {
        const runtime = await driver.executeScript(`
          const dock = document.getElementById('runtimeDock');
          const activity = document.getElementById('runtimeActivityBar');
        return {
          dockDisplay: String(dock?.style?.display || ''),
          activityText: String(activity?.textContent || '').trim(),
          activityHtml: String(activity?.innerHTML || ''),
          thinkingText: String(document.getElementById('runtimeThinkingInline')?.textContent || '').trim(),
        };
      `)
        return runtime.dockDisplay !== 'none' &&
          runtime.activityText.includes('Thinking') &&
          !runtime.activityText.includes('构建已完成') &&
          runtime.activityHtml.includes('runtimeActivityDots') &&
          !runtime.thinkingText.includes('构建已完成')
      }, 5000, 'pending runtime dock placeholder')
    } catch (error) {
      const debug = await driver.executeScript(`
        return {
          active: window.__webCodexDebug?.getActiveState?.() || null,
          liveEvents: window.__webCodexDebug?.getRecentLiveEvents?.(30) || [],
          dump: window.__webCodexDebug?.dumpMessages?.(12) || [],
          errors: Array.isArray(window.__e2eErrors) ? window.__e2eErrors.slice() : [],
          runtimeDockHtml: String(document.getElementById('runtimeDock')?.outerHTML || ''),
          runtimeActivityHtml: String(document.getElementById('runtimeActivityBar')?.outerHTML || ''),
          chatHtml: String(document.getElementById('chatBox')?.innerHTML || ''),
        };
      `)
      throw new Error(`${error.message}; debug=${JSON.stringify(debug)}`)
    }

    await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      const threadId = '019c8000-0000-7000-8000-0000000000a1';
      if (!h || typeof h.emitWsPayload !== 'function') {
        return done({ ok: false, error: 'emitWsPayload missing' });
      }
      setTimeout(() => {
        h.emitWsPayload({
          type: 'rpc.notification',
          payload: {
            method: 'item.updated',
            params: {
              item: {
                type: 'agent_message_content_delta',
                thread_id: threadId,
                delta: 'live',
              },
            },
          },
        });
        h.emitWsPayload({
          type: 'rpc.notification',
          payload: {
            method: 'item.completed',
            params: {
              item: {
                type: 'agent_message',
                thread_id: threadId,
                text: 'live reply',
              },
            },
          },
        });
        h.emitWsPayload({
          type: 'rpc.notification',
          payload: {
            method: 'turn.completed',
            params: { threadId },
          },
        });
        done({ ok: true });
      }, 80);
    `)

    try {
      await waitFor(async () => {
        const dump = await driver.executeScript(`return window.__webCodexDebug.dumpMessages(8);`)
        return Array.isArray(dump) && dump.some((msg) =>
          String(msg?.rawText || msg?.bodyText || '').replace(/\s+/g, ' ').includes('live reply')
        )
      }, 5000, 'live assistant reply to appear')
    } catch (error) {
      const debug = await driver.executeScript(`
        return {
          status: String(document.getElementById('statusLine')?.textContent || '').trim(),
          promptValue: String(document.getElementById('mobilePromptInput')?.value || ''),
          sendDisabled: !!document.getElementById('mobileSendBtn')?.disabled,
          dump: window.__webCodexDebug?.dumpMessages?.(12) || [],
          liveEvents: window.__webCodexDebug?.getRecentLiveEvents?.(20) || [],
          errors: Array.isArray(window.__e2eErrors) ? window.__e2eErrors.slice() : [],
        };
      `)
      throw new Error(`Timeout waiting for live assistant reply to appear; debug=${JSON.stringify(debug)}`)
    }

    await sleep(2200)

    const finalDump = await driver.executeScript(`return window.__webCodexDebug.dumpMessages(12);`)
    const finalDebug = await driver.executeScript(`
      return {
        dump: window.__webCodexDebug.dumpMessages(12),
        liveEvents: window.__webCodexDebug.getRecentLiveEvents?.(40) || [],
        status: String(document.getElementById('statusLine')?.textContent || '').trim(),
        errors: Array.isArray(window.__e2eErrors) ? window.__e2eErrors.slice() : [],
      };
    `)
    const dumpText = JSON.stringify(finalDump).replace(/\s+/g, ' ')
    if (!dumpText.includes('new live turn')) {
      throw new Error(`expected pending user message to remain visible without refresh, got ${JSON.stringify(finalDebug)}`)
    }
    if (!dumpText.includes('live reply')) {
      throw new Error(`expected pending assistant reply to remain visible without refresh, got ${JSON.stringify(finalDebug)}`)
    }

    await waitFor(async () => {
      const runtime = await driver.executeScript(`
        const dock = document.getElementById('runtimeDock');
        const activity = document.getElementById('runtimeActivityBar');
        return {
          dockDisplay: String(dock?.style?.display || ''),
          activityText: String(activity?.textContent || '').trim(),
        };
      `)
      return runtime.dockDisplay === 'none' || runtime.activityText === ''
    }, 5000, 'runtime dock hidden after final answer')

    console.log('[codex-web-e2e-send-turn-live] ok')
  } finally {
    if (driver) await driver.quit().catch(() => {})
    if (devProc) killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[codex-web-e2e-send-turn-live] ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
