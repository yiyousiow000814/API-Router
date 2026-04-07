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
          return done({ ok: false, error: 'missing e2e hooks' });
        }
        const threadId = '019c8000-0000-7000-8000-0000000000b1';
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
            {
              id: 't2',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'follow up' }] },
              ],
            },
          ],
        });
        await h.openThread(threadId);
        h.installMockTurnStream({ threadId });
        h.emitWsPayload({ type: 'subscribed' });
        setTimeout(() => {
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
              {
                id: 't2',
                items: [
                  { type: 'userMessage', content: [{ type: 'input_text', text: 'follow up' }] },
                  { type: 'assistantMessage', text: 'poll reply' },
                ],
              },
            ],
          });
        }, 200);
        done({ ok: true, threadId });
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)
    if (!prepared?.ok) {
      throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)
    }

    await waitFor(async () => {
      const dump = await driver.executeScript('return window.__webCodexDebug.dumpMessages(10)')
      return Array.isArray(dump) && dump.some((msg) => String(msg?.rawText || '').includes('poll reply'))
    }, 7000, 'fallback history polling to surface updated thread content')

    const debug = await driver.executeScript(`
      return {
        dump: window.__webCodexDebug.dumpMessages(10),
        liveEvents: window.__webCodexDebug.getRecentLiveEvents(30),
        state: window.__webCodexDebug.getActiveState(),
      };
    `)
    console.log('[codex-web-e2e-active-thread-poll] ok')
    console.log(JSON.stringify(debug))
  } finally {
    if (driver) await driver.quit().catch(() => {})
    if (devProc) killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[codex-web-e2e-active-thread-poll] ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})

