import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { Builder } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'

import { ensureMsEdgeDriver } from './ui-check/runtime-utils.mjs'

const BASE_URL = String(process.env.CODEX_WEB_URL || 'http://127.0.0.1:4000/codex-web?e2e=1').trim()
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
    await sleep(120)
  }
  throw new Error(`Timeout waiting for ${label}`)
}

function ymdParts(date = new Date()) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return { year: String(year), month, day }
}

function rolloutFileName(threadId, suffix = 'live-sync') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `rollout-${stamp}-${suffix}-${threadId}.jsonl`
}

async function appendLines(filePath, lines) {
  const text = Array.isArray(lines) ? `${lines.join('\n')}\n` : ''
  await fs.appendFile(filePath, text, 'utf8')
}

async function writeWindowsRollout(baseDir, cwd, threadId) {
  const { year, month, day } = ymdParts()
  const sessionsDir = path.join(baseDir, 'sessions', year, month, day)
  await fs.mkdir(sessionsDir, { recursive: true })
  const filePath = path.join(sessionsDir, rolloutFileName(threadId, 'windows'))
  const initialLines = [
    JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started', thread_id: threadId, turn_id: 'turn-initial' } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        thread_id: threadId,
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'initial assistant from rollout' }],
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_complete', thread_id: threadId, turn_id: 'turn-initial' } }),
  ]
  await fs.writeFile(filePath, `${initialLines.join('\n')}\n`, 'utf8')
  return filePath
}

async function runPwsh(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`pwsh failed (${code}): ${stderr || stdout}`))
    })
  })
}

async function runWsl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`wsl failed (${code}): ${stderr || stdout}`))
    })
  })
}

async function detectWslCodexHome() {
  const { stdout } = await runWsl(['-e', 'bash', '-lc', 'printf %s "$HOME/.codex"'])
  const home = String(stdout || '').trim()
  if (!home) throw new Error('failed to detect WSL CODEX_HOME')
  return home
}

async function writeWslRollout(codexHomeLinux, cwdLinux, threadId) {
  const { year, month, day } = ymdParts()
  const sessionsDir = `${codexHomeLinux}/sessions/${year}/${month}/${day}`
  const filePath = `${sessionsDir}/${rolloutFileName(threadId, 'wsl2')}`
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: cwdLinux } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started', thread_id: threadId, turn_id: 'turn-initial' } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        thread_id: threadId,
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'initial assistant from wsl rollout' }],
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_complete', thread_id: threadId, turn_id: 'turn-initial' } }),
  ]
  await runWsl([
    '-e',
    'python3',
    '-c',
    'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(sys.argv[2], encoding="utf-8")',
    filePath,
    `${lines.join('\n')}\n`,
  ])
  return filePath
}

async function appendWslLines(filePath, lines) {
  await runWsl([
    '-e',
    'python3',
    '-c',
    'import pathlib,sys; pathlib.Path(sys.argv[1]).open("a", encoding="utf-8").write(sys.argv[2])',
    filePath,
    `${lines.join('\n')}\n`,
  ])
}

async function removeWslFile(filePath) {
  await runWsl(['-e', 'rm', '-f', filePath]).catch(() => {})
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
          return done({ ok: false, error: 'missing e2e/debug hooks' });
        }
        await hooks.setWorkspaceTarget(workspace);
        await hooks.setStartCwdForWorkspace(workspace, startCwd);
        done(debug.getThreadListSnapshot(200));
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `,
    workspace,
    startCwd,
  )
}

async function forceRefreshThreads(driver, workspace) {
  return driver.executeAsyncScript(
    `
      const workspace = arguments[0];
      const done = arguments[arguments.length - 1];
      fetch('/codex/threads?workspace=' + encodeURIComponent(workspace) + '&force=true', {
        credentials: 'same-origin',
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          done({ ok: res.ok, status: res.status, count: Array.isArray(body?.items?.data) ? body.items.data.length : 0 });
        })
        .catch((error) => done({ ok: false, status: 0, error: String(error && error.message ? error.message : error) }));
    `,
    workspace,
  )
}

async function openThread(driver, threadId) {
  return driver.executeAsyncScript(
    `
      const threadId = arguments[0];
      const done = arguments[arguments.length - 1];
      (async () => {
        const hooks = window.__webCodexE2E;
        const debug = window.__webCodexDebug;
        if (!hooks || !debug || typeof hooks.openThread !== 'function' || typeof debug.dumpMessages !== 'function') {
          return done({ ok: false, error: 'missing openThread hooks' });
        }
        const result = await hooks.openThread(threadId);
        done({
          ok: !!result?.ok,
          dump: debug.dumpMessages(16),
          info: debug.getScriptInfo?.() || null,
        });
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `,
    threadId,
  )
}

async function getDebugState(driver) {
  return driver.executeScript(`
    return {
      dump: window.__webCodexDebug?.dumpMessages?.(20) || [],
      active: window.__webCodexDebug?.getActiveState?.() || null,
      info: window.__webCodexDebug?.getScriptInfo?.() || null,
      live: window.__webCodexDebug?.getRecentLiveEvents?.(40) || [],
      status: String(document.getElementById('statusLine')?.textContent || '').trim(),
      runtime: String(document.getElementById('runtimeActivityBar')?.textContent || '').trim(),
    };
  `)
}

async function getBackendLiveDebug(driver) {
  return driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    fetch('/codex/debug/live', { credentials: 'same-origin' })
      .then(async (res) => done(await res.json().catch(() => ({ status: res.status }))))
      .catch((error) => done({ error: String(error && error.message ? error.message : error) }));
  `)
}

function dumpContainsText(dump, needle) {
  return Array.isArray(dump) && dump.some((item) => {
    const text = `${String(item?.rawText || '')}\n${String(item?.bodyText || '')}`.replace(/\s+/g, ' ')
    return text.includes(needle)
  })
}

async function verifyWorkspace(driver, config) {
  const { workspace, startCwd, threadId, appendLiveLines } = config

  const refresh = await forceRefreshThreads(driver, workspace)
  if (!refresh?.ok) {
    throw new Error(`${workspace} force refresh failed: ${refresh?.error || refresh?.status || 'unknown'}`)
  }
  const setResult = await setWorkspaceAndFolder(driver, workspace, startCwd)
  if (!setResult?.ok) {
    throw new Error(`${workspace} setWorkspaceAndFolder failed: ${setResult?.error || 'unknown'}`)
  }
  await waitFor(async () => {
    const snapshot = await driver.executeScript('return window.__webCodexDebug?.getThreadListSnapshot?.(200) || null')
    return snapshot?.workspaceTarget === workspace &&
      snapshot?.startCwd === startCwd &&
      Array.isArray(snapshot?.visibleItems) &&
      snapshot.visibleItems.some((item) => item.id === threadId)
  }, 15000, `${workspace} thread in filtered list`)

  const openResult = await openThread(driver, threadId)
  if (!openResult?.ok) {
    throw new Error(`${workspace} openThread failed: ${openResult?.error || 'unknown'}`)
  }
  await waitFor(async () => {
    const state = await getDebugState(driver)
    return state?.info?.activeThreadId === threadId && dumpContainsText(state?.dump, 'initial assistant')
  }, 15000, `${workspace} initial history render`)

  await appendLiveLines()

  try {
    await waitFor(async () => {
      const state = await getDebugState(driver)
      return state?.live?.some((event) => String(event?.method || '').includes('turn/started'))
    }, 15000, `${workspace} live turn started notification`)
  } catch (error) {
    const state = await getDebugState(driver)
    const backend = await getBackendLiveDebug(driver)
    throw new Error(`${error.message}; debug=${JSON.stringify({ state, backend })}`)
  }

  await waitFor(async () => {
    const state = await getDebugState(driver)
    return dumpContainsText(state?.dump, 'live final from') &&
      state?.live?.some((event) => String(event?.method || '').includes('item/completed')) &&
      state?.live?.some((event) => String(event?.method || '').includes('turn/completed'))
  }, 20000, `${workspace} final live message`)

  const finalState = await getDebugState(driver)
  return {
    workspace,
    activeThreadId: finalState?.info?.activeThreadId || '',
    messageCount: Number(finalState?.info?.messageCount || 0),
    liveMethodCount: Array.isArray(finalState?.live) ? finalState.live.length : 0,
    finalStatus: finalState?.status || '',
  }
}

async function main() {
  const windowsCodexHome = path.join(os.homedir(), '.codex')
  const windowsStartCwd = path.join(process.cwd(), '.tmp-codex-web-live-sync-win')
  const wslStartCwd = `/home/${os.userInfo().username}/.tmp-codex-web-live-sync-wsl`
  const windowsThreadId = randomUUID()
  const wslThreadId = randomUUID()
  const cleanup = []

  await fs.mkdir(windowsStartCwd, { recursive: true })
  const windowsRollout = await writeWindowsRollout(windowsCodexHome, windowsStartCwd, windowsThreadId)
  cleanup.push(() => fs.unlink(windowsRollout).catch(() => {}))

  const wslCodexHome = await detectWslCodexHome()
  await runWsl(['-e', 'mkdir', '-p', wslStartCwd])
  const wslRollout = await writeWslRollout(wslCodexHome, wslStartCwd, wslThreadId)
  cleanup.push(() => removeWslFile(wslRollout))

  let driver = null
  try {
    const msedgedriverPath = ensureMsEdgeDriver()
    const options = new edge.Options()
    options.addArguments('--window-size=1280,960')
    if (!KEEP_VISIBLE) {
      options.addArguments('--headless=new')
      options.addArguments('--disable-gpu')
    }
    driver = await new Builder()
      .forBrowser('MicrosoftEdge')
      .setEdgeOptions(options)
      .setEdgeService(new edge.ServiceBuilder(msedgedriverPath))
      .build()
    await driver.manage().setTimeouts({ script: 120000, pageLoad: 120000, implicit: 0 })

    await driver.get(BASE_URL)
    await waitFor(async () => {
      const ready = await driver.executeScript(`
        return !!window.__webCodexDebug && !!window.__webCodexE2E && !!document.getElementById('chatBox');
      `)
      return !!ready
    }, 20000, 'codex web ready')

    const windowsResult = await verifyWorkspace(driver, {
      workspace: 'windows',
      startCwd: windowsStartCwd,
      threadId: windowsThreadId,
      appendLiveLines: async () => {
        const lines = [
          JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started', thread_id: windowsThreadId, turn_id: 'turn-live' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', thread_id: windowsThreadId, text: 'thinking from windows rollout' } }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'function_call',
              thread_id: windowsThreadId,
              name: 'exec_command',
              call_id: 'call-live-1',
              arguments: JSON.stringify({ cmd: 'npm test' }),
            },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              thread_id: windowsThreadId,
              call_id: 'call-live-1',
              output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }),
            },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              thread_id: windowsThreadId,
              phase: 'final_answer',
              content: [{ type: 'output_text', text: 'live final from windows rollout' }],
            },
          }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'turn_complete', thread_id: windowsThreadId, turn_id: 'turn-live' } }),
        ]
        await appendLines(windowsRollout, lines)
      },
    })

    const wslResult = await verifyWorkspace(driver, {
      workspace: 'wsl2',
      startCwd: wslStartCwd,
      threadId: wslThreadId,
      appendLiveLines: async () => {
        const lines = [
          JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started', thread_id: wslThreadId, turn_id: 'turn-live' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', thread_id: wslThreadId, text: 'thinking from wsl rollout' } }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'function_call',
              thread_id: wslThreadId,
              name: 'exec_command',
              call_id: 'call-live-1',
              arguments: JSON.stringify({ cmd: 'ls -la' }),
            },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              thread_id: wslThreadId,
              call_id: 'call-live-1',
              output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }),
            },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              thread_id: wslThreadId,
              phase: 'final_answer',
              content: [{ type: 'output_text', text: 'live final from wsl rollout' }],
            },
          }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'turn_complete', thread_id: wslThreadId, turn_id: 'turn-live' } }),
        ]
        await appendWslLines(wslRollout, lines)
      },
    })

    console.log('[ui:e2e:codex-real-rollout-live-sync] PASS')
    console.log(JSON.stringify({ windows: windowsResult, wsl2: wslResult }, null, 2))
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    for (const fn of cleanup.reverse()) {
      await fn()
    }
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-real-rollout-live-sync] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})
