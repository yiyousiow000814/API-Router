import path from 'node:path'
import process from 'node:process'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Builder, By, Key, until } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'

import { ensureMsEdgeDriver, repoRoot } from '../../support/runtime-utils.mjs'

const BASE_URL = String(process.env.CODEX_WEB_URL || 'http://127.0.0.1:4000/codex-web?e2e=1').trim()
const KEEP_VISIBLE = String(process.env.UI_TAURI_VISIBLE || '').trim() === '1'
const REAL_SEND_TIMEOUT_MS = Math.max(45000, Number(process.env.CODEX_WEB_REAL_SEND_TIMEOUT_MS || 120000) || 120000)

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
    await sleep(150)
  }
  throw new Error(`Timeout waiting for ${label}`)
}

async function canReach(url) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    clearTimeout(timer)
    return res.ok || res.status === 401 || res.status === 403
  } catch {
    return false
  }
}

async function ensureDesktopReady() {
  const ok = await canReach(BASE_URL)
  if (!ok) {
    throw new Error(`Codex Web desktop is not reachable at ${BASE_URL}. Start API Router.exe first.`)
  }
}

async function waitForCodexReady(driver) {
  await driver.wait(async () => {
    try {
      return await driver.executeScript(`
        return !!window.__webCodexDebug
          && !!window.__webCodexE2E
          && !!document.getElementById('mobilePromptInput')
          && !!document.getElementById('mobileSendBtn');
      `)
    } catch {
      return false
    }
  }, 25000, 'codex web ready')
}

async function setWorkspaceAndFolder(driver, workspace, startCwd) {
  return driver.executeAsyncScript(
    `
      const workspace = arguments[0];
      const startCwd = arguments[1];
      const done = arguments[arguments.length - 1];
      (async () => {
        const hooks = window.__webCodexE2E;
        const debug = window.__webCodexDebug;
        if (!hooks || !debug || typeof hooks.setWorkspaceTarget !== 'function' || typeof hooks.setStartCwdForWorkspace !== 'function') {
          return done({ ok: false, error: 'missing e2e hooks' });
        }
        await hooks.setWorkspaceTarget(workspace);
        await hooks.setStartCwdForWorkspace(workspace, startCwd);
        try {
          const input = document.getElementById('mobilePromptInput');
          if (input) {
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } catch {}
        done({
          ok: true,
          threadList: debug.getThreadListSnapshot?.(200) || null,
          active: debug.getActiveState?.() || null,
          info: debug.getScriptInfo?.() || null,
        });
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `,
    workspace,
    startCwd,
  )
}

async function setPromptAndSend(driver, prompt) {
  return driver.executeAsyncScript(
    `
      const prompt = arguments[0];
      const done = arguments[arguments.length - 1];
      try {
        const input = document.getElementById('mobilePromptInput');
        const sendBtn = document.getElementById('mobileSendBtn');
        if (!input || !sendBtn) return done({ ok: false, error: 'missing composer controls' });
        input.focus();
        input.value = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        requestAnimationFrame(() => {
          sendBtn.click();
          done({ ok: true, sendLabel: String(sendBtn.getAttribute('aria-label') || '') });
        });
      } catch (error) {
        done({ ok: false, error: String(error && error.message ? error.message : error) });
      }
    `,
    prompt,
  )
}

async function getDebugState(driver) {
  return driver.executeScript(`
    return {
      info: window.__webCodexDebug?.getScriptInfo?.() || null,
      active: window.__webCodexDebug?.getActiveState?.() || null,
      pipeline: window.__webCodexDebug?.getLivePipelineSnapshot?.(40) || null,
      dump: window.__webCodexDebug?.dumpMessages?.(20) || [],
      status: String(document.getElementById('statusLine')?.textContent || '').trim(),
      runtime: String(document.getElementById('runtimeActivityBar')?.textContent || '').trim(),
      promptValue: String(document.getElementById('mobilePromptInput')?.value || ''),
      sendLabel: String(document.getElementById('mobileSendBtn')?.getAttribute('aria-label') || ''),
      welcomeVisible: (() => {
        const node = document.getElementById('welcomeCard');
        if (!node) return false;
        const style = getComputedStyle(node);
        return style.display !== 'none' && node.hidden !== true;
      })(),
    };
  `)
}

async function fetchHistory(driver, threadId, workspace, rolloutPath = '') {
  return driver.executeAsyncScript(
    `
      const threadId = arguments[0];
      const workspace = arguments[1];
      const rolloutPath = arguments[2];
      const done = arguments[arguments.length - 1];
      const params = new URLSearchParams();
      if (workspace) params.set('workspace', workspace);
      if (rolloutPath) params.set('rolloutPath', rolloutPath);
      fetch('/codex/threads/' + encodeURIComponent(threadId) + '/history?' + params.toString(), {
        credentials: 'same-origin',
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          done({ ok: res.ok, status: res.status, body });
        })
        .catch((error) => done({ ok: false, status: 0, error: String(error && error.message ? error.message : error) }));
    `,
    threadId,
    workspace,
    rolloutPath,
  )
}

function countVisibleUserMessages(dump, prompt) {
  return (Array.isArray(dump) ? dump : []).filter((item) => {
    return String(item?.role || '') === 'user' && String(item?.rawText || '').trim() === prompt
  }).length
}

function latestAssistantText(dump) {
  const items = Array.isArray(dump) ? dump : []
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (String(item?.role || '') === 'assistant') {
      return String(item?.rawText || item?.bodyText || '').trim()
    }
  }
  return ''
}

function collectFailureSnapshot(state, history) {
  return {
    info: state?.info || null,
    active: state?.active || null,
    status: state?.status || '',
    runtime: state?.runtime || '',
    sendLabel: state?.sendLabel || '',
    promptValue: state?.promptValue || '',
    welcomeVisible: !!state?.welcomeVisible,
    pipeline: state?.pipeline || null,
    dump: state?.dump || [],
    history: history || null,
  }
}

async function main() {
  await ensureDesktopReady()

  const msedgedriverPath = ensureMsEdgeDriver()
  const options = new edge.Options()
  options.addArguments('--window-size=1280,960')
  if (!KEEP_VISIBLE) {
    options.addArguments('--headless=new')
    options.addArguments('--disable-gpu')
  }

  const driver = await new Builder()
    .forBrowser('MicrosoftEdge')
    .setEdgeOptions(options)
    .setEdgeService(new edge.ServiceBuilder(msedgedriverPath))
    .build()
  await driver.manage().setTimeouts({ script: 120000, pageLoad: 120000, implicit: 0 })

  const runId = randomUUID().slice(0, 8)
  const startCwd = path.join(repoRoot, `.tmp-codex-web-real-send-${runId}`)
  const prompt = `Reply with OK only. [codex-web-real-send ${runId}]`

  try {
    await fs.mkdir(startCwd, { recursive: true })

    await driver.get(BASE_URL)
    await waitForCodexReady(driver)

    const prepared = await setWorkspaceAndFolder(driver, 'windows', startCwd)
    if (!prepared?.ok) {
      throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)
    }

    await waitFor(async () => {
      const state = await getDebugState(driver)
      return (
        String(state?.info?.activeThreadId || '') === '' &&
        state?.welcomeVisible === true
      )
    }, 10000, 'new chat reset state')

    const sent = await setPromptAndSend(driver, prompt)
    if (!sent?.ok) {
      throw new Error(`send failed: ${sent?.error || 'unknown'}`)
    }

    await waitFor(async () => {
      const state = await getDebugState(driver)
      return (
        String(state?.active?.activeThreadId || '').trim().length > 0 &&
        state?.active?.activeThreadPendingTurnRunning === true &&
        countVisibleUserMessages(state?.dump, prompt) === 1
      )
    }, 30000, 'pending user turn render')

    await waitFor(async () => {
      const state = await getDebugState(driver)
      const assistant = latestAssistantText(state?.dump)
      return (
        state?.active?.activeThreadPendingTurnRunning === false &&
        countVisibleUserMessages(state?.dump, prompt) === 1 &&
        !!assistant &&
        !/working/i.test(String(state?.status || '')) &&
        !/thinking/i.test(String(state?.runtime || ''))
      )
    }, REAL_SEND_TIMEOUT_MS, 'assistant final answer')

    const finalState = await getDebugState(driver)
    const threadId = String(finalState?.info?.activeThreadId || '').trim()
    const workspace = String(finalState?.info?.activeThreadWorkspace || 'windows').trim() || 'windows'
    const rolloutPath = String(finalState?.info?.activeThreadRolloutPath || '').trim()
    if (!threadId) {
      throw new Error(`missing active thread id after final answer: ${JSON.stringify(finalState?.info || null)}`)
    }

    const history = await fetchHistory(driver, threadId, workspace, rolloutPath)
    if (!history?.ok) {
      throw new Error(`history fetch failed: ${history?.status || 0} ${history?.error || JSON.stringify(history?.body || {})}`)
    }

    const historyTurns = Array.isArray(history?.body?.page?.turns)
      ? history.body.page.turns
      : (Array.isArray(history?.body?.thread?.turns) ? history.body.thread.turns : [])
    const finalAssistant = latestAssistantText(finalState?.dump)
    const userCount = countVisibleUserMessages(finalState?.dump, prompt)
    if (userCount !== 1 || !finalAssistant) {
      throw new Error(`unexpected final dump: ${JSON.stringify(collectFailureSnapshot(finalState, history))}`)
    }

    console.log('[ui:e2e:codex-real-send-turn] PASS')
    console.log(JSON.stringify({
      runId,
      threadId,
      workspace,
      rolloutPath,
      userCount,
      assistantPreview: finalAssistant.slice(0, 160),
      messageCount: Number(finalState?.info?.messageCount || 0),
      historyTurnCount: historyTurns.length,
      pendingRunning: !!finalState?.active?.activeThreadPendingTurnRunning,
      status: finalState?.status || '',
      runtime: finalState?.runtime || '',
    }, null, 2))
  } catch (error) {
    let failureState = null
    let failureHistory = null
    try {
      failureState = await getDebugState(driver)
      const threadId = String(failureState?.info?.activeThreadId || '').trim()
      if (threadId) {
        failureHistory = await fetchHistory(
          driver,
          threadId,
          String(failureState?.info?.activeThreadWorkspace || 'windows').trim() || 'windows',
          String(failureState?.info?.activeThreadRolloutPath || '').trim(),
        )
      }
    } catch {}
    console.error('[ui:e2e:codex-real-send-turn] FAIL')
    console.error(error?.stack || error)
    console.error(JSON.stringify(collectFailureSnapshot(failureState, failureHistory), null, 2))
    process.exitCode = 1
  } finally {
    try {
      await driver.quit()
    } catch {}
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-real-send-turn] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

