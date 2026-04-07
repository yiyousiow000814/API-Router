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
    if (await predicate()) return true
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
  if (!child?.pid) return
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
    return {
      statusLine: String(document.getElementById('statusLine')?.textContent || '').trim(),
      dump: window.__webCodexDebug?.dumpMessages?.(16) || [],
      active: window.__webCodexDebug?.getActiveState?.() || null,
      pendingUi: window.__webCodexDebug?.getPendingUiSnapshot?.(20) || null,
      live: window.__webCodexDebug?.getRecentLiveEvents?.(40) || [],
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

    const threadId = '019c8000-0000-7000-8000-0000000000f2'
    const prepared = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.openThread !== 'function') {
          return done({ ok: false, error: 'missing e2e history hooks' });
        }
        h.setThreadHistory(${JSON.stringify(threadId)}, {
          id: ${JSON.stringify(threadId)},
          modelName: 'gpt-5.3-codex',
          page: { incomplete: true },
          turns: [
            {
              id: 'turn-live',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: '我们继续上次未完成的 plan' }] },
                { type: 'assistantMessage', phase: 'final_answer', text: '这是未完成 turn 里残留的 assistant 片段' },
                {
                  type: 'toolCall',
                  tool: 'request_user_input',
                  status: 'running',
                  arguments: JSON.stringify({
                    questions: [
                      {
                        id: 'scope',
                        header: 'Question 1/1',
                        question: 'Where should preview appear?',
                        options: [{ label: 'Current chat', description: 'Bind to current thread.' }],
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        });
        await h.openThread(${JSON.stringify(threadId)});
        done({ ok: true });
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)
    if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)

    await waitFor(async () => {
      const snapshot = await getSnapshot(driver)
      return snapshot.dump.some((item) => String(item?.bodyText || '').includes('这是未完成 turn 里残留的 assistant 片段'))
    }, 8000, 'incomplete assistant visible before interrupt suppression')

    const marked = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.markLocalInterrupt !== 'function' || typeof h.emitWsPayload !== 'function' || typeof h.refreshActiveThread !== 'function') {
          return done({ ok: false, error: 'missing local interrupt hooks' });
        }
        h.markLocalInterrupt(${JSON.stringify(threadId)});
        h.emitWsPayload({
          type: 'rpc.notification',
          payload: {
            method: 'thread/status/changed',
            params: {
              threadId: ${JSON.stringify(threadId)},
              status: 'running',
              message: 'Running...',
            },
          },
        });
        await h.refreshActiveThread();
        setTimeout(() => done({ ok: true }), 180);
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)
    if (!marked?.ok) throw new Error(`interrupt mark failed: ${marked?.error || 'unknown'}`)

    try {
      await waitFor(async () => {
        const snapshot = await getSnapshot(driver)
        const hasResidualAssistant = snapshot.dump.some((item) =>
          String(item?.bodyText || '').includes('这是未完成 turn 里残留的 assistant 片段')
        )
        return !hasResidualAssistant && !String(snapshot.statusLine || '').toLowerCase().includes('working')
      }, 8000, 'suppressed incomplete assistant removed after refresh')
    } catch (error) {
      const failureSnapshot = await getSnapshot(driver)
      console.error('[ui:e2e:interrupt-incomplete-history-assistant] snapshot before failure:')
      console.error(JSON.stringify(failureSnapshot, null, 2))
      throw error
    }

    const finalSnapshot = await getSnapshot(driver)
    console.log('[ui:e2e:interrupt-incomplete-history-assistant] PASS')
    console.log(JSON.stringify({
      statusLine: finalSnapshot.statusLine,
      messageCount: Array.isArray(finalSnapshot.dump) ? finalSnapshot.dump.length : 0,
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
  console.error(`[ui:e2e:interrupt-incomplete-history-assistant] FAIL: ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})

