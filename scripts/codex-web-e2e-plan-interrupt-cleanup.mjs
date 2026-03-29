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

async function getSnapshot(driver) {
  return driver.executeScript(`
    const pending = document.getElementById('pendingInlineMount');
    const runtime = document.getElementById('runtimeActivityBar');
    const thinking = document.getElementById('runtimeThinkingInline');
    const plan = document.getElementById('runtimePlanInline');
    const tool = document.getElementById('runtimeToolInline');
    const dump = window.__webCodexDebug?.dumpMessages?.(16) || [];
    const active = window.__webCodexDebug?.getActiveState?.() || null;
    const live = window.__webCodexDebug?.getRecentLiveEvents?.(40) || [];
    return {
      pendingVisible: !!pending,
      pendingText: String(pending?.textContent || '').trim(),
      runtimeText: String(runtime?.textContent || '').trim(),
      runtimeHtml: String(runtime?.innerHTML || ''),
      thinkingText: String(thinking?.textContent || '').trim(),
      planText: String(plan?.textContent || '').trim(),
      toolText: String(tool?.textContent || '').trim(),
      dump,
      active,
      live,
    };
  `)
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
        return await driver.executeScript('return !!window.__webCodexE2E && !!window.__webCodexDebug;')
      } catch {
        return false
      }
    }, 20000, '__webCodexE2E ready')

    const prepared = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.openThread !== 'function') {
          return done({ ok: false, error: 'missing e2e history hooks' });
        }
        const threadId = '019c8000-0000-7000-8000-0000000000f1';
        h.setThreadHistory(threadId, {
          id: threadId,
          modelName: 'gpt-5.3-codex',
          turns: [
            {
              id: 'seed-turn',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'seed user' }] },
                { type: 'assistantMessage', text: 'seed assistant' },
              ],
            },
          ],
        });
        await h.openThread(threadId);
        done({ ok: true, threadId });
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)

    await waitFor(async () => {
      const snapshot = await getSnapshot(driver)
      return snapshot.dump.some((item) => String(item?.bodyText || item?.rawText || '').includes('seed assistant'))
    }, 10000, 'seeded thread render')

    const threadId = '019c8000-0000-7000-8000-0000000000f1'
    await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      const threadId = ${JSON.stringify(threadId)};
      if (!h || typeof h.emitWsPayload !== 'function') {
        return done({ ok: false, error: 'emitWsPayload missing' });
      }
      const emit = (payload) => h.emitWsPayload({ type: 'rpc.notification', payload });
      emit({
        method: 'turn/started',
        params: { threadId, turnId: 'turn-plan' },
      });
      emit({
        method: 'codex/event/agent_message',
        params: {
          payload: {
            id: 'commentary-1',
            type: 'agent_message',
            thread_id: threadId,
            phase: 'commentary',
            message: 'thinking before question',
          },
        },
      });
      emit({
        method: 'item/updated',
        params: {
          threadId,
          item: {
            id: 'input-tool-1',
            type: 'toolCall',
            tool: 'request_user_input',
            status: 'running',
            arguments: JSON.stringify({
              questions: [
                {
                  id: 'scope',
                  header: 'Question 1/1',
                  question: 'Where should preview appear?',
                  options: [
                    { label: 'Current chat', description: 'Bind to current thread.' },
                    { label: 'New chat', description: 'Open a dedicated preview thread.' },
                  ],
                },
              ],
            }),
          },
        },
      });
      setTimeout(() => done({ ok: true }), 180);
    `)

    await waitFor(async () => {
      const snapshot = await getSnapshot(driver)
      return snapshot.pendingVisible &&
        snapshot.pendingText.includes('Where should preview appear?') &&
        snapshot.thinkingText.includes('thinking before question') &&
        snapshot.runtimeText.toLowerCase().includes('working')
    }, 8000, 'question/commentary/working visible')

    await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      const threadId = ${JSON.stringify(threadId)};
      if (
        !h ||
        typeof h.emitWsPayload !== 'function' ||
        typeof h.setThreadHistory !== 'function' ||
        typeof h.refreshActiveThread !== 'function'
      ) {
        return done({ ok: false, error: 'missing interrupt/history hooks' });
      }
      h.emitWsPayload({
        type: 'rpc.notification',
        payload: {
          method: 'turn/cancelled',
          params: { threadId, status: 'interrupted' },
        },
      });
      h.setThreadHistory(threadId, {
        id: threadId,
        modelName: 'gpt-5.3-codex',
        page: { incomplete: false },
        turns: [
          {
            id: 'seed-turn',
            items: [
              { type: 'userMessage', content: [{ type: 'input_text', text: 'seed user' }] },
              { type: 'assistantMessage', text: 'seed assistant' },
            ],
          },
        ],
      });
      Promise.resolve(h.refreshActiveThread())
        .then(() => setTimeout(() => done({ ok: true }), 180))
        .catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)

    try {
      await waitFor(async () => {
        const snapshot = await getSnapshot(driver)
        return !snapshot.pendingVisible &&
          !snapshot.pendingText.includes('Where should preview appear?') &&
          !snapshot.thinkingText.includes('thinking before question') &&
          !snapshot.runtimeText.toLowerCase().includes('working') &&
          !snapshot.planText.includes('Updated Plan')
      }, 8000, 'interrupt cleanup visible')
    } catch (error) {
      const failureSnapshot = await getSnapshot(driver)
      console.error('[ui:e2e:codex-plan-interrupt-cleanup] snapshot before failure:')
      console.error(JSON.stringify(failureSnapshot, null, 2))
      throw error
    }

    await driver.navigate().refresh()
    await waitFor(async () => {
      try {
        await driver.findElement(By.id('mobilePromptInput'))
        return await driver.executeScript('return !!window.__webCodexE2E && !!window.__webCodexDebug;')
      } catch {
        return false
      }
    }, 20000, 'refresh __webCodexE2E ready')

    const reopened = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.openThread !== 'function') {
          return done({ ok: false, error: 'missing e2e history hooks after refresh' });
        }
        const threadId = ${JSON.stringify(threadId)};
        h.setThreadHistory(threadId, {
          id: threadId,
          modelName: 'gpt-5.3-codex',
          status: { type: 'interrupted' },
          page: { incomplete: true },
          turns: [
            {
              id: 'turn-plan-interrupted',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'seed user' }] },
                { type: 'agentMessage', id: 'commentary-2', phase: 'commentary', text: 'thinking before question' },
                {
                  id: 'input-tool-2',
                  type: 'toolCall',
                  tool: 'request_user_input',
                  status: 'running',
                  arguments: JSON.stringify({
                    questions: [
                      {
                        id: 'scope',
                        header: 'Question 1/1',
                        question: 'Where should preview appear?',
                        options: [
                          { label: 'Current chat', description: 'Bind to current thread.' },
                          { label: 'New chat', description: 'Open a dedicated preview thread.' },
                        ],
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        });
        await h.openThread(threadId);
        done({ ok: true });
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!reopened?.ok) throw new Error(`reopen after refresh failed: ${reopened?.error || 'unknown'}`)

    try {
      await waitFor(async () => {
        const snapshot = await getSnapshot(driver)
        return !snapshot.pendingVisible &&
          !snapshot.pendingText.includes('Where should preview appear?') &&
          !snapshot.thinkingText.includes('thinking before question') &&
          !snapshot.runtimeText.toLowerCase().includes('working') &&
          !snapshot.planText.includes('Updated Plan')
      }, 8000, 'refresh interrupt cleanup visible')
    } catch (error) {
      const failureSnapshot = await getSnapshot(driver)
      console.error('[ui:e2e:codex-plan-interrupt-cleanup] refresh snapshot before failure:')
      console.error(JSON.stringify(failureSnapshot, null, 2))
      throw error
    }

    const finalSnapshot = await getSnapshot(driver)
    console.log('[ui:e2e:codex-plan-interrupt-cleanup] PASS')
    console.log(JSON.stringify({
      pendingVisible: finalSnapshot.pendingVisible,
      runtimeText: finalSnapshot.runtimeText,
      thinkingText: finalSnapshot.thinkingText,
      planText: finalSnapshot.planText,
      liveCount: Array.isArray(finalSnapshot.live) ? finalSnapshot.live.length : 0,
    }, null, 2))
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-plan-interrupt-cleanup] FAIL: ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
