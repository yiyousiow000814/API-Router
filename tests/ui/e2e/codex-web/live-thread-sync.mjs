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

    const seeded = await driver.executeAsyncScript(`
      const done = arguments[0];
      (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.openThread !== 'function') {
          return done({ ok: false, error: 'missing e2e history hooks' });
        }
        const threadId = '019c8000-0000-7000-8000-0000000000a2';
        h.setThreadHistory(threadId, {
          id: threadId,
          modelName: 'gpt-5.3-codex',
          turns: [
            {
              id: 't1',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'old question' }] },
                { type: 'assistantMessage', text: 'old answer' },
              ],
            },
          ],
        });
        await h.openThread(threadId);
        done({ ok: true, threadId });
      })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!seeded?.ok) throw new Error(`seed/open failed: ${seeded?.error || 'unknown'}`)

    await waitFor(async () => {
      const count = await driver.executeScript(`return document.querySelectorAll('#chatBox .msg').length;`)
      return Number(count || 0) >= 2
    }, 10000, 'initial chat render')

    const liveProbe = await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      const dump = () => (window.__webCodexDebug && typeof window.__webCodexDebug.dumpMessages === 'function')
        ? window.__webCodexDebug.dumpMessages(8)
        : [];
      if (!h || typeof h.emitWsPayload !== 'function') {
        return done({ ok: false, error: 'emitWsPayload missing', before: dump() });
      }
      const threadId = '019c8000-0000-7000-8000-0000000000a2';
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
      requestAnimationFrame(() => {
        const afterLive = dump();
        setTimeout(() => {
          done({
            ok: true,
            afterLive,
            afterRefresh: dump(),
          });
        }, 1100);
      });
    `)
    if (!liveProbe?.ok) throw new Error(`live probe failed: ${liveProbe?.error || 'unknown'}`)

    const containsReply = (messages) =>
      Array.isArray(messages) &&
      messages.some((msg) => String(msg?.rawText || msg?.bodyText || '').includes('live reply'))

    if (!containsReply(liveProbe.afterLive)) {
      throw new Error(`expected live reply to appear immediately, got ${JSON.stringify(liveProbe.afterLive)}`)
    }
    if (!containsReply(liveProbe.afterRefresh)) {
      throw new Error(`expected live reply to survive active-thread refresh, got ${JSON.stringify(liveProbe.afterRefresh)}`)
    }

    console.log('[codex-web-e2e-live-thread-sync] ok')
  } finally {
    if (driver) await driver.quit().catch(() => {})
    if (devProc) killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[codex-web-e2e-live-thread-sync] ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})

