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
        const ok = await driver.executeScript(
          'return !!window.__webCodexE2E && !!window.__webCodexDebug;'
        )
        return !!ok
      } catch {
        return false
      }
    }, 20000, '__webCodexE2E and composer')

    const result = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        const dump = () => (window.__webCodexDebug && typeof window.__webCodexDebug.dumpMessages === 'function')
          ? window.__webCodexDebug.dumpMessages(8)
          : [];
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.openThread !== 'function' || typeof h.emitWsPayload !== 'function') {
          return done({ ok: false, error: 'missing e2e hooks', messages: dump() });
        }
        const threadId = '019c8000-0000-7000-8000-0000000000f4';
        const calls = [];
        const origFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : String(input?.url || '');
          calls.push({ url, method: String(init?.method || 'GET').toUpperCase() });
          return origFetch(input, init);
        };
        h.setThreadHistory(threadId, {
          id: threadId,
          modelName: 'gpt-5.3-codex',
          turns: [
            {
              id: 'turn-old',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'old question' }] },
                { type: 'assistantMessage', text: 'old answer' },
              ],
            },
          ],
        });
        await h.openThread(threadId);
        const beforeCalls = calls.slice();
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
        let messages = dump();
        for (let i = 0; i < 30; i += 1) {
          if (messages.some((entry) => String(entry?.rawText || entry?.bodyText || '').includes('live reply'))) break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 100));
          messages = dump();
        }
        done({
          ok: true,
          beforeCalls,
          afterCalls: calls,
          messages,
        });
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)

    if (!result?.ok) throw new Error(`probe failed: ${result?.error || 'unknown'}`)

    const beforeCalls = Array.isArray(result.beforeCalls) ? result.beforeCalls : []
    const afterCalls = Array.isArray(result.afterCalls) ? result.afterCalls : []
    const resumeCalls = afterCalls.filter((call) => String(call.url || '').includes('/resume'))
    const hasLiveReply = Array.isArray(result.messages) && result.messages.some((entry) => String(entry?.rawText || entry?.bodyText || '').includes('live reply'))

    if (resumeCalls.length !== 0) {
      throw new Error(`expected 0 resume fetches, got ${resumeCalls.length}: ${JSON.stringify(afterCalls)}`)
    }
    if (!hasLiveReply) {
      throw new Error(`expected live reply without refresh, got ${JSON.stringify(result.messages)}`)
    }
    if (beforeCalls.some((call) => String(call.url || '').includes('/resume'))) {
      throw new Error(`unexpected resume fetch during openThread: ${JSON.stringify(beforeCalls)}`)
    }

    console.log('[ui:e2e:codex-terminal-turn-live-without-refresh] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-terminal-turn-live-without-refresh] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})
