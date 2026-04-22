import path from 'node:path'
import process from 'node:process'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { Builder } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'

import { ensureMsEdgeDriver, repoRoot, resolveTauriAppPath } from '../../support/runtime-utils.mjs'

const EXTERNAL_BASE_URL = String(process.env.CODEX_WEB_URL || '').trim()
const KEEP_VISIBLE = String(process.env.UI_TAURI_VISIBLE || '').trim() === '1'
const FLOW_TIMEOUT_MS = Math.max(45000, Number(process.env.CODEX_WEB_REAL_SEND_TIMEOUT_MS || 120000) || 120000)
const REOPEN_TIMEOUT_MS = 20000
const FLOW_SAMPLE_INTERVAL_MS = 40
const ERROR_TEXT = 'no routable providers available; preferred=aigateway; tried='
const ISOLATED_GATEWAY_TOKEN = 'ao_e2e_gateway_token'
const USE_DISABLED_PROVIDER = String(process.env.CODEX_WEB_E2E_DISABLED_PROVIDER || '1').trim() !== '0'

function quotePs(value) {
  return String(value || '').replaceAll("'", "''")
}

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

async function waitForState(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const result = await predicate()
    if (result) return result
    // eslint-disable-next-line no-await-in-loop
    await sleep(120)
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

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}

function isolatedConfigToml(port) {
  return [
    '[listen]',
    'host = "127.0.0.1"',
    `port = ${Number(port)}`,
    '',
    '[routing]',
    'preferred_provider = "aigateway"',
    'route_mode = "follow_preferred_auto"',
    'auto_return_to_preferred = true',
    'preferred_stable_seconds = 30',
    'failure_threshold = 2',
    'cooldown_seconds = 600',
    'request_timeout_seconds = 30',
    '',
    '[providers.aigateway]',
    `display_name = "AIGateway (isolated ${USE_DISABLED_PROVIDER ? 'disabled' : 'connection-failed'})"`,
    'base_url = "http://127.0.0.1:1/v1"',
    `disabled = ${USE_DISABLED_PROVIDER ? 'true' : 'false'}`,
    'supports_websockets = false',
    '',
    'provider_order = ["aigateway"]',
    '',
  ].join('\n')
}

async function copyIfExists(source, target) {
  try {
    await fs.cp(source, target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function isolatedCodexConfigToml(port, sourceConfigText = '') {
  const projectSections = String(sourceConfigText || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*\[projects\./.test(line) || /^\s*trust_level\s*=/.test(line))
    .join('\n')
    .trim()
  const parts = [
    'model_provider = "api_router"',
    'model = "gpt-5.3-codex"',
    '',
    '[model_providers."api_router"]',
    'name = "api_router"',
    `base_url = "http://127.0.0.1:${Number(port)}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
    'personality = "pragmatic"',
  ]
  if (projectSections) {
    parts.push('', projectSections)
  }
  parts.push('')
  return parts.join('\n')
}

async function writeIsolatedSecrets(userDataDir, gatewayToken) {
  const secretsPath = path.join(userDataDir, 'secrets.json')
  const payload = {
    providers: {
      __gateway_token__: gatewayToken,
    },
  }
  await fs.writeFile(secretsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

async function prepareIsolatedCodexHome(userDataDir, port, gatewayToken) {
  const sourceRoot = path.join(repoRoot, 'user-data', 'codex-home')
  const targetRoot = path.join(userDataDir, 'codex-home')
  await fs.mkdir(targetRoot, { recursive: true })
  for (const relative of ['installation_id', 'skills']) {
    await copyIfExists(path.join(sourceRoot, relative), path.join(targetRoot, relative))
  }
  let sourceConfigText = ''
  try {
    sourceConfigText = await fs.readFile(path.join(sourceRoot, 'config.toml'), 'utf8')
  } catch {}
  await fs.writeFile(
    path.join(targetRoot, 'auth.json'),
    `${JSON.stringify({ OPENAI_API_KEY: gatewayToken }, null, 2)}\n`,
    'utf8',
  )
  await fs.writeFile(
    path.join(targetRoot, 'config.toml'),
    isolatedCodexConfigToml(port, sourceConfigText),
    'utf8',
  )
  return targetRoot
}

async function startIsolatedDesktop() {
  const runId = randomUUID().slice(0, 8)
  const port = await allocatePort()
  const runtimeRoot = path.join(repoRoot, 'user-data', 'tmp', `codex-web-reconnect-e2e-${runId}`)
  const userDataDir = path.join(runtimeRoot, 'user-data')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.writeFile(path.join(userDataDir, 'config.toml'), isolatedConfigToml(port), 'utf8')
  await writeIsolatedSecrets(userDataDir, ISOLATED_GATEWAY_TOKEN)
  const codexHome = await prepareIsolatedCodexHome(userDataDir, port, ISOLATED_GATEWAY_TOKEN)
  const exePath = process.env.CODEX_WEB_E2E_APP_PATH
    ? path.resolve(process.env.CODEX_WEB_E2E_APP_PATH)
    : resolveTauriAppPath('debug')
  const stdoutPath = path.join(runtimeRoot, 'app.stdout.log')
  const stderrPath = path.join(runtimeRoot, 'app.stderr.log')
  const stdoutHandle = await fs.open(stdoutPath, 'w')
  const stderrHandle = await fs.open(stderrPath, 'w')
  const child = spawn(
    exePath,
    ['--start-hidden'],
    {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      env: {
        ...process.env,
        API_ROUTER_USER_DATA_DIR: userDataDir,
        API_ROUTER_CODEX_HOME: codexHome,
        API_ROUTER_WEB_CODEX_CODEX_HOME: codexHome,
        API_ROUTER_PROFILE: 'e2e-reconnect-isolated',
      },
    },
  )
  child.on('exit', () => {
    stdoutHandle.close().catch(() => {})
    stderrHandle.close().catch(() => {})
  })
  const baseUrl = `http://127.0.0.1:${port}/codex-web?e2e=1`
  const statusUrl = `http://127.0.0.1:${port}/status`
  const started = Date.now()
  while (Date.now() - started < 45000) {
    if (await canReach(statusUrl)) {
      return { baseUrl, port, userDataDir, runtimeRoot, child, exePath }
    }
    if (child.exitCode != null) {
      break
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(250)
  }
  let stdout = ''
  let stderr = ''
  try { stdout = await fs.readFile(stdoutPath, 'utf8') } catch {}
  try { stderr = await fs.readFile(stderrPath, 'utf8') } catch {}
  throw new Error(`isolated API Router failed to start on port ${port}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

async function stopProcessTree(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => {
    const killer = spawn(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    )
    killer.on('exit', () => resolve())
    killer.on('error', () => resolve())
  })
}

async function ensureDesktopReady(baseUrl) {
  const ok = await canReach(baseUrl)
  if (!ok) {
    throw new Error(`Codex Web desktop is not reachable at ${baseUrl}.`)
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
      (async () => {
        try {
          const hooks = window.__webCodexE2E;
          if (hooks && typeof hooks.sendPrompt === 'function') {
            const result = await hooks.sendPrompt(prompt);
            return done(result && typeof result === 'object' ? result : { ok: !!result });
          }
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
      })();
    `,
    prompt,
  )
}

async function getDebugState(driver) {
  return driver.executeScript(`
    const debug = window.__webCodexDebug;
    const dump = debug?.dumpMessages?.(40) || [];
    const statusLine = document.getElementById('statusLine');
    const runtime = document.getElementById('runtimeActivityBar');
    const sendBtn = document.getElementById('mobileSendBtn');
    const liveEvents = debug?.getRecentLiveEvents?.(240) || [];
    const traceEvents = debug?.getRecentLiveTraceEvents?.(240) || [];
    return {
      info: debug?.getScriptInfo?.() || null,
      active: debug?.getActiveState?.() || null,
      pipeline: debug?.getLivePipelineSnapshot?.(60) || null,
      liveEvents,
      traceEvents,
      dump,
      status: String(statusLine?.textContent || '').trim(),
      runtime: String(runtime?.textContent || '').trim(),
      sendLabel: String(sendBtn?.getAttribute('aria-label') || '').trim(),
      promptValue: String(document.getElementById('mobilePromptInput')?.value || ''),
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

async function collectLiveLogSlice(logRootDir, threadIds = [], limit = 220) {
  const ids = [...new Set((Array.isArray(threadIds) ? threadIds : []).map((value) => String(value || '').trim()).filter(Boolean))]
  if (!ids.length) return []
  const logPath = path.join(logRootDir, 'logs', 'codex-web-live.ndjson')
  try {
    const raw = await fs.readFile(logPath, 'utf8')
    const lines = raw.split(/\r?\n/).filter(Boolean)
    const matched = []
    for (const line of lines) {
      if (!ids.some((threadId) => line.includes(threadId))) continue
      try {
        matched.push(JSON.parse(line))
      } catch {
        matched.push({ parseError: true, line })
      }
    }
    return matched.slice(Math.max(0, matched.length - Math.max(1, Number(limit || 220) | 0)))
  } catch (error) {
    return [{ logReadError: String(error && error.message ? error.message : error), path: logPath }]
  }
}

function findMessagesByText(dump, text) {
  return (Array.isArray(dump) ? dump : []).filter((item) => {
    const body = String(item?.rawText || item?.bodyText || '').trim()
    return body === text
  })
}

function lastMessageIndexContaining(dump, needle) {
  const items = Array.isArray(dump) ? dump : []
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const body = String(items[i]?.rawText || items[i]?.bodyText || '').trim()
    if (body.includes(needle)) return Number(items[i]?.index ?? i)
  }
  return -1
}

function getReconnectCard(dump) {
  const items = Array.isArray(dump) ? dump : []
  return items.find((item) => String(item?.rawText || item?.bodyText || '').includes('Reconnecting...')) || null
}

function getErrorCards(dump) {
  const items = Array.isArray(dump) ? dump : []
  return items.filter((item) => String(item?.rawText || item?.bodyText || '').includes(ERROR_TEXT))
}

function countHistoryPromptOccurrences(historyResponse, prompt) {
  const turns = Array.isArray(historyResponse?.body?.thread?.turns) ? historyResponse.body.thread.turns : []
  let count = 0
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : []
    for (const item of items) {
      if (String(item?.type || '').trim() !== 'userMessage') continue
      const content = Array.isArray(item?.content) ? item.content : []
      const text = content
        .map((part) => String(part?.text || ''))
        .join('\n')
        .trim()
      if (text === prompt) count += 1
    }
  }
  return count
}

function countHistoryAssistantTextOccurrences(historyResponse, text) {
  const turns = Array.isArray(historyResponse?.body?.thread?.turns) ? historyResponse.body.thread.turns : []
  let count = 0
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : []
    for (const item of items) {
      const type = String(item?.type || '').trim()
      if (type === 'assistantMessage' || type === 'agentMessage') {
        if (String(item?.text || '').trim() === text) count += 1
        continue
      }
      if (type === 'message' && String(item?.role || '').trim() === 'assistant') {
        const content = Array.isArray(item?.content) ? item.content : []
        const messageText = content
          .map((part) => String(part?.text || ''))
          .join('\n')
          .trim()
        if (messageText === text) count += 1
      }
    }
  }
  return count
}

function latestHistoryTurnId(historyResponse) {
  const turns = Array.isArray(historyResponse?.body?.thread?.turns) ? historyResponse.body.thread.turns : []
  const last = turns.length ? turns[turns.length - 1] : null
  return String(last?.id || '').trim()
}

async function appendLateAssistantToFailedTurn(rolloutPath, threadId, turnId, text) {
  if (!rolloutPath || !threadId || !turnId || !text) {
    throw new Error(`appendLateAssistantToFailedTurn missing inputs: ${JSON.stringify({ rolloutPath, threadId, turnId, text })}`)
  }
  const lines = [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        thread_id: threadId,
        turn_id: turnId,
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        thread_id: threadId,
        turn_id: turnId,
      },
    }),
    '',
  ].join('\n')
  await fs.appendFile(rolloutPath, lines, 'utf8')
}

function stageShape(sample, prompt) {
  const dump = Array.isArray(sample?.dump) ? sample.dump : []
  const promptMatches = findMessagesByText(dump, prompt)
  const reconnectCard = getReconnectCard(dump)
  const errorCards = getErrorCards(dump)
  return {
    promptCount: promptMatches.length,
    promptSources: promptMatches.map((item) => String(item?.source || '')),
    reconnectText: String(reconnectCard?.rawText || reconnectCard?.bodyText || '').trim(),
    reconnectIndex: reconnectCard ? Number(reconnectCard?.index ?? -1) : -1,
    errorCount: errorCards.length,
    errorIndex: errorCards.length ? Number(errorCards[errorCards.length - 1]?.index ?? -1) : -1,
    status: String(sample?.status || '').trim(),
    runtime: String(sample?.runtime || '').trim(),
    sendLabel: String(sample?.sendLabel || '').trim(),
  }
}

function assertStage(condition, label, details = {}) {
  if (!condition) {
    throw new Error(`${label}: ${JSON.stringify(details)}`)
  }
}

function syntheticSampleFromTimelineEvent(event, fallbackSample = {}) {
  const timelineMessages = Array.isArray(event?.timeline?.messages) ? event.timeline.messages : []
  return {
    status: String(fallbackSample?.status || ''),
    runtime: /working/i.test(String(fallbackSample?.runtime || ''))
      ? String(fallbackSample?.runtime || '')
      : 'working...',
    sendLabel: String(fallbackSample?.sendLabel || '').trim() === 'Stop current turn'
      ? 'Stop current turn'
      : 'Stop current turn',
    dump: timelineMessages.map((message, index) => ({
      index: Number(message?.index ?? index),
      role: String(message?.role || ''),
      kind: String(message?.kind || ''),
      source: String(message?.source || ''),
      rawText: String(message?.text || ''),
      bodyText: String(message?.text || ''),
    })),
  }
}

function maxEventAt(...eventLists) {
  let maxAt = 0
  for (const list of eventLists) {
    for (const event of Array.isArray(list) ? list : []) {
      maxAt = Math.max(maxAt, Math.max(0, Number(event?.at || 0)))
    }
  }
  return maxAt
}

function findEventAfter(minEventAt = 0, predicate = () => false, ...eventLists) {
  let best = null
  for (const list of eventLists) {
    for (const event of Array.isArray(list) ? list : []) {
      const at = Math.max(0, Number(event?.at || 0))
      if (at <= minEventAt) continue
      if (!predicate(event)) continue
      if (!best || at > Math.max(0, Number(best?.at || 0))) best = event
    }
  }
  return best
}

function summarizeObservedFlow(samples, prompt, expectedPromptCount = 1, minEventAt = 0) {
  const reconnectAttempts = []
  let firstPromptAt = -1
  let firstErrorAt = -1
  let errorClearedAfterVisible = false
  let workingBecameVisible = false
  let workingFlickered = false
  let lastWorking = null
  let promptMovedAfterConnection = false
  let promptMovedAfterError = false
  let promptDuplicateDetected = false
  let promptDisappearedAfterVisible = false
  let warningOverwroteTerminalStatus = false
  let terminalSnapshot = null
  let assistantMessageVisible = false
  let promptOnlySnapshot = null
  const reconnectSnapshotsByAttempt = {}

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]
    const dump = Array.isArray(sample?.dump) ? sample.dump : []
    const liveEvents = Array.isArray(sample?.liveEvents) ? sample.liveEvents : []
    const traceEvents = Array.isArray(sample?.traceEvents) ? sample.traceEvents : []
    const flowEvents = [...traceEvents, ...liveEvents].filter((event) => {
      const at = Math.max(0, Number(event?.at || 0))
      return at > Math.max(0, Number(minEventAt || 0))
    })
    const promptMatches = findMessagesByText(dump, prompt)
    const reconnectIndex = lastMessageIndexContaining(dump, 'Reconnecting...')
    const errorIndex = lastMessageIndexContaining(dump, ERROR_TEXT)
    if (
      dump.some((item) => {
        const role = String(item?.role || '').trim().toLowerCase()
        const body = String(item?.rawText || item?.bodyText || '').trim()
        return role === 'assistant' && body && body !== prompt
      })
    ) {
      assistantMessageVisible = true
    }
    for (const event of flowEvents) {
      if (String(event?.kind || '') !== 'live.connection:thread_show_reconnect') continue
      const attempt = String(event?.attempt || '').trim()
      if (attempt && !reconnectAttempts.includes(attempt)) reconnectAttempts.push(attempt)
    }
    for (const event of flowEvents) {
      if (String(event?.kind || '') !== 'chat.timeline:add') continue
      const text = String(event?.text || '').trim()
      const attemptMatch = text.match(/\b([1-5]\/5)\b/)
      const attempt = String(attemptMatch?.[1] || '').trim()
      if (!attempt || reconnectSnapshotsByAttempt[attempt]) continue
      reconnectSnapshotsByAttempt[attempt] = syntheticSampleFromTimelineEvent(event, sample)
    }
    if (promptMatches.length > expectedPromptCount) promptDuplicateDetected = true
    if (promptMatches.length === expectedPromptCount && firstPromptAt < 0) firstPromptAt = i
    if (
      !promptOnlySnapshot &&
      promptMatches.length === expectedPromptCount &&
      reconnectIndex < 0 &&
      errorIndex < 0
    ) {
      promptOnlySnapshot = sample
    }
    if (firstPromptAt >= 0 && promptMatches.length < expectedPromptCount) promptDisappearedAfterVisible = true
    if (promptMatches.length && reconnectIndex >= 0 && Number(promptMatches[0]?.index ?? -1) > reconnectIndex) {
      promptMovedAfterConnection = true
    }
    if (promptMatches.length && errorIndex >= 0 && Number(promptMatches[0]?.index ?? -1) > errorIndex) {
      promptMovedAfterError = true
    }
    const hasError = errorIndex >= 0
    if (hasError && firstErrorAt < 0) firstErrorAt = i
    if (!hasError && firstErrorAt >= 0) errorClearedAfterVisible = true
    const working = /working/i.test(String(sample?.runtime || '')) || /stop current turn/i.test(String(sample?.sendLabel || ''))
    if (working) workingBecameVisible = true
    if (
      lastWorking !== null &&
      lastWorking !== working &&
      !(lastWorking === true && working === false && hasError)
    ) {
      workingFlickered = true
    }
    lastWorking = working
    if (
      hasError &&
      String(sample?.status || '').includes('Some enabled skills were not included')
    ) {
      warningOverwroteTerminalStatus = true
    }
    if (hasError) terminalSnapshot = sample
    const reconnectText = String(getReconnectCard(dump)?.rawText || getReconnectCard(dump)?.bodyText || '').trim()
    for (const attempt of ['1/5', '2/5', '3/5', '4/5', '5/5']) {
      if (reconnectSnapshotsByAttempt[attempt]) continue
      if (promptMatches.length === expectedPromptCount && reconnectText.includes(attempt) && errorIndex < 0) {
        reconnectSnapshotsByAttempt[attempt] = sample
      }
    }
  }

  return {
    reconnectAttempts,
    firstPromptAt,
    firstErrorAt,
    errorClearedAfterVisible,
    workingBecameVisible,
    workingFlickered,
    promptMovedAfterConnection,
    promptMovedAfterError,
    promptDuplicateDetected,
    promptDisappearedAfterVisible,
    warningOverwroteTerminalStatus,
    terminalSnapshot,
    assistantMessageVisible,
    promptOnlySnapshot,
    reconnectSnapshotsByAttempt,
  }
}

function validateReconnectFailureFlow({
  observedFlow,
  finalState,
  prompt,
  expectedPromptCount,
  stageLabel,
  requirePromptOnlySnapshot = true,
}) {
  const reconnectKeySteps = ['1/5', '2/5', '3/5', '4/5', '5/5']
  const missingSteps = reconnectKeySteps.filter((step) => !observedFlow.reconnectAttempts.includes(step))
  if (
    missingSteps.length === reconnectKeySteps.length &&
    observedFlow.assistantMessageVisible &&
    String(finalState?.status || '').trim() === 'Turn completed.'
  ) {
    throw new Error(`${stageLabel}: expected reconnect failure flow, but the real turn completed successfully`)
  }
  if (missingSteps.length) {
    throw new Error(`${stageLabel}: missing reconnect steps: ${missingSteps.join(', ')}`)
  }
  if (observedFlow.firstPromptAt < 0) {
    throw new Error(`${stageLabel}: prompt never became visible`)
  }
  if (requirePromptOnlySnapshot && !observedFlow.promptOnlySnapshot) {
    throw new Error(`${stageLabel}: missing prompt-only stage before reconnecting`)
  }
  if (observedFlow.firstErrorAt < 0) {
    throw new Error(`${stageLabel}: error card never appeared`)
  }
  if (requirePromptOnlySnapshot) {
    const promptOnlyShape = stageShape(observedFlow.promptOnlySnapshot, prompt)
    assertStage(
      promptOnlyShape.promptCount === expectedPromptCount &&
        promptOnlyShape.reconnectIndex < 0 &&
        promptOnlyShape.errorCount === 0,
      `${stageLabel}: prompt-only stage shape mismatch`,
      promptOnlyShape,
    )
  }
  for (const step of reconnectKeySteps) {
    const reconnectSnapshot = observedFlow.reconnectSnapshotsByAttempt[step]
    if (!reconnectSnapshot) {
      throw new Error(`${stageLabel}: missing reconnect snapshot for ${step}`)
    }
    const reconnectShape = stageShape(reconnectSnapshot, prompt)
    assertStage(
      reconnectShape.promptCount === expectedPromptCount &&
        reconnectShape.errorCount === 0 &&
        reconnectShape.reconnectText.includes(step) &&
        reconnectShape.sendLabel === 'Stop current turn' &&
        /working/i.test(reconnectShape.runtime),
      `${stageLabel}: reconnect stage shape mismatch for ${step}`,
      reconnectShape,
    )
  }
  if (observedFlow.errorClearedAfterVisible) {
    throw new Error(`${stageLabel}: error card disappeared after becoming visible`)
  }
  if (!observedFlow.workingBecameVisible) {
    throw new Error(`${stageLabel}: working state never became visible during retries`)
  }
  if (observedFlow.workingFlickered) {
    throw new Error(`${stageLabel}: working state flickered during flow`)
  }
  if (observedFlow.promptDuplicateDetected) {
    throw new Error(`${stageLabel}: prompt duplicated during flow`)
  }
  if (observedFlow.promptDisappearedAfterVisible) {
    throw new Error(`${stageLabel}: prompt disappeared after becoming visible`)
  }
  if (observedFlow.promptMovedAfterConnection) {
    throw new Error(`${stageLabel}: prompt moved behind reconnect card`)
  }
  if (observedFlow.promptMovedAfterError) {
    throw new Error(`${stageLabel}: prompt moved behind error card`)
  }
  if (observedFlow.warningOverwroteTerminalStatus) {
    throw new Error(`${stageLabel}: warning status overwrote terminal error status`)
  }

  const terminalDump = Array.isArray(finalState?.dump) ? finalState.dump : []
  const terminalErrors = terminalDump.filter((item) => String(item?.rawText || item?.bodyText || '').includes(ERROR_TEXT))
  if (terminalErrors.length !== 1) {
    throw new Error(`${stageLabel}: expected exactly one error card at terminal state, got ${terminalErrors.length}`)
  }
  const terminalShape = stageShape(finalState, prompt)
  assertStage(
    terminalShape.promptCount === expectedPromptCount &&
      terminalShape.errorCount === 1 &&
      terminalShape.reconnectIndex < 0 &&
      terminalShape.sendLabel === 'Send message' &&
      !/working/i.test(terminalShape.runtime),
    `${stageLabel}: terminal stage shape mismatch`,
    terminalShape,
  )
  if (String(finalState?.sendLabel || '') !== 'Send message') {
    throw new Error(`${stageLabel}: expected send button after terminal error, got ${JSON.stringify(finalState?.sendLabel || '')}`)
  }
  if (/working/i.test(String(finalState?.runtime || ''))) {
    throw new Error(`${stageLabel}: expected runtime to stop after terminal error, got ${JSON.stringify(finalState?.runtime || '')}`)
  }
  if (/reconnecting/i.test(String(finalState?.status || ''))) {
    throw new Error(`${stageLabel}: expected terminal status line to stop reconnecting, got ${JSON.stringify(finalState?.status || '')}`)
  }
}

function collectFailureSnapshot(state, history, observedFlow = null, reopen = null) {
  const liveEvents = Array.isArray(state?.liveEvents) ? state.liveEvents : []
  const keyLiveEvents = liveEvents.filter((event) => {
    const kind = String(event?.kind || '')
    return (
      kind.startsWith('chat.timeline:') ||
      kind.startsWith('live.connection:') ||
      kind.startsWith('live.status') ||
      kind.startsWith('history.render:') ||
      kind === 'history.apply' ||
      kind === 'history.receive' ||
      kind === 'turn.send' ||
      kind === 'turn.start.ack'
    )
  })
  return {
    info: state?.info || null,
    active: state?.active || null,
    status: state?.status || '',
    runtime: state?.runtime || '',
    sendLabel: state?.sendLabel || '',
    promptValue: state?.promptValue || '',
    welcomeVisible: !!state?.welcomeVisible,
    pipeline: state?.pipeline || null,
    observedFlow,
    reopen,
    keyLiveEvents,
    dump: state?.dump || [],
    history: history || null,
  }
}

async function reopenExistingThread(driver, threadId) {
  return driver.executeAsyncScript(
    `
      const threadId = arguments[0];
      const done = arguments[arguments.length - 1];
      (async () => {
        try {
          const hooks = window.__webCodexE2E;
          if (!hooks || typeof hooks.openThread !== 'function') {
            return done({ ok: false, error: 'openThread missing' });
          }
          const result = await hooks.openThread(threadId);
          done({ ok: true, result });
        } catch (error) {
          done({ ok: false, error: String(error && error.message ? error.message : error) });
        }
      })();
    `,
    threadId,
  )
}

async function main() {
  let desktop = null
  const baseUrl = EXTERNAL_BASE_URL
    || (desktop = await startIsolatedDesktop(), desktop.baseUrl)
  await ensureDesktopReady(baseUrl)

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
  const prompt = `hi [codex-web-reconnect-flow ${runId}]`

  try {
    await fs.mkdir(startCwd, { recursive: true })
    await driver.get(baseUrl)
    await waitForCodexReady(driver)

    const prepared = await setWorkspaceAndFolder(driver, 'windows', startCwd)
    if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)

    await waitFor(async () => {
      const state = await getDebugState(driver)
      return String(state?.info?.activeThreadId || '') === '' && state?.welcomeVisible === true
    }, 10000, 'new chat reset state')

    const sent = await setPromptAndSend(driver, prompt)
    if (!sent?.ok) throw new Error(`send failed: ${sent?.error || 'unknown'}`)

    const firstPromptState = await waitForState(async () => {
      const state = await getDebugState(driver)
      const shape = stageShape(state, prompt)
      if (
        String(state?.active?.activeThreadId || '').trim().length > 0 &&
        shape.promptCount === 1 &&
        shape.reconnectIndex < 0 &&
        shape.errorCount === 0
      ) {
        return state
      }
      return null
    }, 30000, 'prompt-only user message')

    const samples = [{
      at: Date.now(),
      status: String(firstPromptState?.status || ''),
      runtime: String(firstPromptState?.runtime || ''),
      sendLabel: String(firstPromptState?.sendLabel || ''),
      latestReconnectText: '',
      latestReconnectIndex: lastMessageIndexContaining(firstPromptState?.dump, 'Reconnecting...'),
      latestErrorIndex: lastMessageIndexContaining(firstPromptState?.dump, ERROR_TEXT),
      dump: Array.isArray(firstPromptState?.dump) ? firstPromptState.dump : [],
      info: firstPromptState?.info || null,
      active: firstPromptState?.active || null,
      liveEvents: firstPromptState?.liveEvents || [],
      traceEvents: firstPromptState?.traceEvents || [],
    }]
    const started = Date.now()
    let terminalState = null
    while (Date.now() - started < FLOW_TIMEOUT_MS) {
      // eslint-disable-next-line no-await-in-loop
      const state = await getDebugState(driver)
      const dump = Array.isArray(state?.dump) ? state.dump : []
      const latestReconnectIndex = lastMessageIndexContaining(dump, 'Reconnecting...')
      const latestReconnectText = latestReconnectIndex >= 0
        ? String(dump.find((item) => Number(item?.index ?? -1) === latestReconnectIndex)?.rawText || '')
        : ''
      const latestErrorIndex = lastMessageIndexContaining(dump, ERROR_TEXT)
      const snapshot = {
        at: Date.now(),
        status: String(state?.status || ''),
        runtime: String(state?.runtime || ''),
        sendLabel: String(state?.sendLabel || ''),
        latestReconnectText,
        latestReconnectIndex,
        latestErrorIndex,
        dump,
        info: state?.info || null,
        active: state?.active || null,
        liveEvents: state?.liveEvents || [],
        traceEvents: state?.traceEvents || [],
      }
      samples.push(snapshot)
      if (latestErrorIndex >= 0 && !/working/i.test(snapshot.runtime) && snapshot.sendLabel === 'Send message') {
        terminalState = state
        break
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(FLOW_SAMPLE_INTERVAL_MS)
    }

    const finalState = terminalState || await getDebugState(driver)
    const threadId = String(finalState?.info?.activeThreadId || '').trim()
    const workspace = String(finalState?.info?.activeThreadWorkspace || 'windows').trim() || 'windows'
    const rolloutPath = String(finalState?.info?.activeThreadRolloutPath || '').trim()
    if (!threadId) {
      throw new Error(`missing active thread id after flow: ${JSON.stringify(finalState?.info || null)}`)
    }

    const observedFlow = summarizeObservedFlow(samples, prompt, 1)
    const history = await fetchHistory(driver, threadId, workspace, rolloutPath)
    const liveLogSlice = await collectLiveLogSlice(desktop?.userDataDir || path.join(repoRoot, 'user-data'), [threadId], 240)
    validateReconnectFailureFlow({
      observedFlow,
      finalState,
      prompt,
      expectedPromptCount: 1,
      stageLabel: 'first-send',
    })
    if (!history?.ok) {
      throw new Error(`history fetch failed: ${history?.status || 0} ${history?.error || JSON.stringify(history?.body || {})}`)
    }
    const historyStatus = String(history?.body?.thread?.status?.type || history?.body?.page?.status?.type || '').trim().toLowerCase()
    if (historyStatus && historyStatus !== 'systemerror' && historyStatus !== 'failed') {
      throw new Error(`expected failed history terminal status, got ${JSON.stringify(historyStatus)}`)
    }
    const failedTurnId = latestHistoryTurnId(history)
    const lateAssistantText = `late failed assistant [${runId}]`
    if (!rolloutPath || !failedTurnId) {
      throw new Error(`missing rollout path or failed turn id for late assistant regression: ${JSON.stringify({ rolloutPath, failedTurnId, threadId })}`)
    }
    await appendLateAssistantToFailedTurn(rolloutPath, threadId, failedTurnId, lateAssistantText)
    await sleep(2200)
    const postLateAssistantState = await getDebugState(driver)
    const postLateAssistantHistory = await fetchHistory(driver, threadId, workspace, rolloutPath)
    if (!postLateAssistantHistory?.ok) {
      throw new Error(`post-late-assistant history fetch failed: ${postLateAssistantHistory?.status || 0} ${postLateAssistantHistory?.error || JSON.stringify(postLateAssistantHistory?.body || {})}`)
    }
    if (
      (Array.isArray(postLateAssistantState?.dump) ? postLateAssistantState.dump : []).some((item) => {
        const role = String(item?.role || '').trim().toLowerCase()
        const body = String(item?.rawText || item?.bodyText || '').trim()
        return role === 'assistant' && body === lateAssistantText
      })
    ) {
      throw new Error('late same-turn assistant appeared in chat after terminal error')
    }
    if (countHistoryAssistantTextOccurrences(postLateAssistantHistory, lateAssistantText) > 0) {
      throw new Error('late same-turn assistant leaked into authoritative history after terminal error')
    }

    const secondFlowMinEventAt = maxEventAt(finalState?.traceEvents, finalState?.liveEvents)
    const resent = await setPromptAndSend(driver, prompt)
    if (!resent?.ok) throw new Error(`second send failed: ${resent?.error || 'unknown'}`)
    const secondPromptState = await waitForState(async () => {
      const state = await getDebugState(driver)
      const shape = stageShape(state, prompt)
      if (
        String(state?.info?.activeThreadId || '').trim() === threadId &&
        shape.promptCount === 2 &&
        shape.errorCount === 0
      ) {
        return state
      }
      return null
    }, 30000, 'second user message visibility')
    const secondTurnAckState = await waitForState(async () => {
      const state = await getDebugState(driver)
      const ackEvent = findEventAfter(
        secondFlowMinEventAt,
        (event) =>
          String(event?.kind || '').trim() === 'turn.start.ack' &&
          String(event?.threadId || '').trim() === threadId,
        state?.traceEvents,
        state?.liveEvents,
      )
      if (
        String(state?.info?.activeThreadId || '').trim() === threadId &&
        ackEvent
      ) {
        return { state, ackEvent }
      }
      return null
    }, 30000, 'second turn start ack')
    const secondTurnStartAt = Math.max(
      secondFlowMinEventAt,
      Math.max(0, Number(secondTurnAckState?.ackEvent?.at || 0)),
    )

    const secondSamples = [{
      at: Date.now(),
      status: String(secondPromptState?.status || ''),
      runtime: String(secondPromptState?.runtime || ''),
      sendLabel: String(secondPromptState?.sendLabel || ''),
      latestReconnectText: '',
      latestReconnectIndex: lastMessageIndexContaining(secondPromptState?.dump, 'Reconnecting...'),
      latestErrorIndex: lastMessageIndexContaining(secondPromptState?.dump, ERROR_TEXT),
      dump: Array.isArray(secondPromptState?.dump) ? secondPromptState.dump : [],
      info: secondPromptState?.info || null,
      active: secondPromptState?.active || null,
      liveEvents: secondPromptState?.liveEvents || [],
      traceEvents: secondPromptState?.traceEvents || [],
    }]
    let secondTerminalState = null
    const secondStarted = Date.now()
    while (Date.now() - secondStarted < FLOW_TIMEOUT_MS) {
      // eslint-disable-next-line no-await-in-loop
      const state = await getDebugState(driver)
      const dump = Array.isArray(state?.dump) ? state.dump : []
      const latestReconnectIndex = lastMessageIndexContaining(dump, 'Reconnecting...')
      const latestReconnectText = latestReconnectIndex >= 0
        ? String(dump.find((item) => Number(item?.index ?? -1) === latestReconnectIndex)?.rawText || '')
        : ''
      const latestErrorIndex = lastMessageIndexContaining(dump, ERROR_TEXT)
      const snapshot = {
        at: Date.now(),
        status: String(state?.status || ''),
        runtime: String(state?.runtime || ''),
        sendLabel: String(state?.sendLabel || ''),
        latestReconnectText,
        latestReconnectIndex,
        latestErrorIndex,
        dump,
        info: state?.info || null,
        active: state?.active || null,
        liveEvents: state?.liveEvents || [],
        traceEvents: state?.traceEvents || [],
      }
      secondSamples.push(snapshot)
      if (latestErrorIndex >= 0 && !/working/i.test(snapshot.runtime) && snapshot.sendLabel === 'Send message') {
        secondTerminalState = state
        break
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(FLOW_SAMPLE_INTERVAL_MS)
    }

    const secondFinalState = secondTerminalState || await getDebugState(driver)
    const secondObservedFlow = summarizeObservedFlow(secondSamples, prompt, 2, secondTurnStartAt)
    validateReconnectFailureFlow({
      observedFlow: secondObservedFlow,
      finalState: secondFinalState,
      prompt,
      expectedPromptCount: 2,
      stageLabel: 'second-send',
      requirePromptOnlySnapshot: false,
    })

    await sleep(2200)
    const settledState = await getDebugState(driver)
    const settledShape = stageShape(settledState, prompt)
    assertStage(
      settledShape.promptCount === 2 &&
        settledShape.errorCount === 1 &&
        settledShape.reconnectIndex < 0 &&
        settledShape.sendLabel === 'Send message' &&
        !/working/i.test(settledShape.runtime),
      'post-terminal settled shape mismatch after second send',
      settledShape,
    )
    if (settledState?.dump?.some((item) => String(item?.role || '').trim().toLowerCase() === 'assistant')) {
      throw new Error('assistant message appeared after second terminal failure')
    }

    await driver.navigate().refresh()
    await waitForCodexReady(driver)
    const reopened = await reopenExistingThread(driver, threadId)
    if (!reopened?.ok) throw new Error(`reopen failed: ${reopened?.error || 'unknown'}`)
    await waitFor(async () => {
      const state = await getDebugState(driver)
      return String(state?.info?.activeThreadId || '').trim() === threadId
    }, REOPEN_TIMEOUT_MS, 'reopened failed thread')
    await sleep(2200)
    const reopenState = await getDebugState(driver)
    const reopenHistory = await fetchHistory(
      driver,
      threadId,
      String(reopenState?.info?.activeThreadWorkspace || 'windows').trim() || 'windows',
      String(reopenState?.info?.activeThreadRolloutPath || '').trim(),
    )
    if (!reopenHistory?.ok) {
      throw new Error(`reopen history fetch failed: ${reopenHistory?.status || reopenHistory?.error || 'unknown'}`)
    }
    const expectedReopenPromptCount = countHistoryPromptOccurrences(reopenHistory, prompt)
    const reopenObserved = {
      status: String(reopenState?.status || ''),
      runtime: String(reopenState?.runtime || ''),
      sendLabel: String(reopenState?.sendLabel || ''),
      reconnectIndex: lastMessageIndexContaining(reopenState?.dump, 'Reconnecting...'),
      errorIndex: lastMessageIndexContaining(reopenState?.dump, ERROR_TEXT),
      dump: reopenState?.dump || [],
      historyPromptCount: expectedReopenPromptCount,
    }
    const reopenShape = stageShape(reopenState, prompt)
    assertStage(
      reopenShape.promptCount === expectedReopenPromptCount &&
        reopenShape.errorCount === 0 &&
        reopenShape.reconnectIndex < 0 &&
        reopenShape.sendLabel === 'Send message' &&
        !/working/i.test(reopenShape.runtime) &&
        reopenShape.promptSources.every((source) => source === 'historyRender'),
      'reopen stage shape mismatch',
      reopenShape,
    )
    if (reopenObserved.reconnectIndex >= 0) {
      throw new Error('reopen unexpectedly showed reconnecting')
    }
    if (reopenObserved.errorIndex >= 0) {
      throw new Error('reopen unexpectedly preserved transient error card')
    }
    if (/working/i.test(reopenObserved.runtime) || reopenObserved.sendLabel === 'Stop current turn') {
      throw new Error('reopen unexpectedly resumed running state')
    }

    console.log('[ui:e2e:codex-reconnect-error-sequence] PASS')
    console.log(JSON.stringify({
      runId,
      threadId,
      observedFlow,
      secondObservedFlow,
      reopenObserved,
      liveLogTail: liveLogSlice.slice(-30),
    }, null, 2))
  } catch (error) {
    let failureState = null
    let failureHistory = null
    let liveLogSlice = []
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
        liveLogSlice = await collectLiveLogSlice(desktop?.userDataDir || path.join(repoRoot, 'user-data'), [threadId], 260)
      }
    } catch {}
    console.error('[ui:e2e:codex-reconnect-error-sequence] FAIL')
    console.error(error?.stack || error)
    console.error(JSON.stringify(collectFailureSnapshot(failureState, failureHistory), null, 2))
    console.error(JSON.stringify({ liveLogSlice }, null, 2))
    process.exitCode = 1
  } finally {
    try {
      await driver.quit()
    } catch {}
    await stopProcessTree(desktop?.child)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-reconnect-error-sequence] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})
