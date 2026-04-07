import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { Builder } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'

import { filterThreadsForWorkspace, normalizeThreadCwdForMatch } from '../../../../src/ui/modules/codex-web/threadMeta.js'
import { ensureMsEdgeDriver, repoRoot } from '../../support/runtime-utils.mjs'

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

async function fetchThreads(driver, workspace) {
  return driver.executeAsyncScript(
    `
      const workspace = arguments[0];
      const done = arguments[arguments.length - 1];
      (async () => {
        const res = await fetch('/codex/threads?workspace=' + encodeURIComponent(workspace), {
          credentials: 'same-origin',
        });
        const body = await res.json().catch(() => ({}));
        done({
          ok: res.ok,
          status: res.status,
          body,
        });
      })().catch((error) => done({
        ok: false,
        status: 0,
        error: String(error && error.message ? error.message : error),
      }));
    `,
    workspace,
  )
}

function pickCandidateFolders(items, workspace, maxFolders = 2) {
  const counts = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const cwd = normalizeThreadCwdForMatch(item?.cwd || item?.project || item?.directory || item?.path || '', workspace)
    if (!cwd) continue
    counts.set(cwd, (counts.get(cwd) || 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], undefined, { sensitivity: 'base', numeric: true }))
    .slice(0, maxFolders)
    .map(([cwd]) => cwd)
}

function expectVisibleThreads(items, workspace, startCwd) {
  return filterThreadsForWorkspace(items, {
    hasDualWorkspaceTargets: true,
    currentTarget: workspace,
    startCwd,
  })
}

async function setWorkspaceAndFolder(driver, workspace, startCwd) {
  return driver.executeAsyncScript(
    `
      const workspace = arguments[0];
      const startCwd = arguments[1];
      const done = arguments[arguments.length - 1];
      (async () => {
        const h = window.__webCodexE2E;
        const debug = window.__webCodexDebug;
        if (!h || typeof h.setWorkspaceTarget !== 'function' || typeof h.setStartCwdForWorkspace !== 'function' || !debug || typeof debug.getThreadListSnapshot !== 'function') {
          return done({ ok: false, error: 'missing debug hooks' });
        }
        await h.setWorkspaceTarget(workspace);
        await h.setStartCwdForWorkspace(workspace, startCwd);
        const snapshot = debug.getThreadListSnapshot(400);
        done(snapshot);
      })().catch((error) => done({
        ok: false,
        error: String(error && error.message ? error.message : error),
      }));
    `,
    workspace,
    startCwd,
  )
}

async function getThreadSnapshot(driver) {
  return driver.executeScript(`
    return window.__webCodexDebug && typeof window.__webCodexDebug.getThreadListSnapshot === 'function'
      ? window.__webCodexDebug.getThreadListSnapshot(400)
      : null;
  `)
}

async function openThread(driver, threadId) {
  return driver.executeAsyncScript(
    `
      const threadId = arguments[0];
      const done = arguments[arguments.length - 1];
      (async () => {
        const h = window.__webCodexE2E;
        const debug = window.__webCodexDebug;
        if (!h || typeof h.openThread !== 'function' || !debug || typeof debug.getScriptInfo !== 'function') {
          return done({ ok: false, error: 'missing openThread hook' });
        }
        const result = await h.openThread(threadId);
        done({
          result,
          info: debug.getScriptInfo(),
        });
      })().catch((error) => done({
        ok: false,
        error: String(error && error.message ? error.message : error),
      }));
    `,
    threadId,
  )
}

async function getOpenThreadState(driver) {
  return driver.executeScript(`
    const h = window.__webCodexDebug;
    const info = h && typeof h.getScriptInfo === 'function' ? h.getScriptInfo() : null;
    const welcome = document.getElementById('welcomeCard');
    const style = welcome ? getComputedStyle(welcome) : null;
    return {
      info,
      welcomeHidden: !welcome || style?.display === 'none' || welcome.hidden === true || welcome.classList.contains('hide'),
    };
  `)
}

async function verifyWorkspace(driver, workspace) {
  const payload = await fetchThreads(driver, workspace)
  if (!payload?.ok) {
    throw new Error(`${workspace} threads fetch failed: ${payload?.status || 0} ${payload?.error || JSON.stringify(payload?.body || {})}`)
  }
  const items = Array.isArray(payload?.body?.items?.data)
    ? payload.body.items.data
    : (Array.isArray(payload?.body?.items) ? payload.body.items : [])
  const folders = pickCandidateFolders(items, workspace, 2)
  if (!folders.length) {
    throw new Error(`${workspace} has no folders with cwd`)
  }

  const checks = []
  for (const folder of folders) {
    const expectedItems = expectVisibleThreads(items, workspace, folder)
    const initial = await setWorkspaceAndFolder(driver, workspace, folder)
    if (!initial?.ok) {
      throw new Error(`${workspace} setStartCwd failed for ${folder}: ${initial?.error || 'unknown error'}`)
    }
    await waitFor(async () => {
      const snapshot = await getThreadSnapshot(driver)
      return (
        snapshot &&
        snapshot.workspaceTarget === workspace &&
        snapshot.startCwd === folder &&
        Number(snapshot.visibleCount || 0) === expectedItems.length
      )
    }, 15000, `${workspace} filtered thread list for ${folder}`)

    const snapshot = await getThreadSnapshot(driver)
    const mismatched = (snapshot?.visibleItems || []).find((item) => {
      const cwd = normalizeThreadCwdForMatch(item?.cwd || '', workspace)
      return !cwd || (cwd !== folder && !cwd.startsWith(`${folder}/`))
    })
    if (mismatched) {
      throw new Error(`${workspace} snapshot contains mismatched cwd for ${folder}: ${JSON.stringify(mismatched)}`)
    }
    checks.push({
      folder,
      expectedCount: expectedItems.length,
      visibleCount: Number(snapshot?.visibleCount || 0),
      firstThreadId: String(expectedItems[0]?.id || expectedItems[0]?.threadId || ''),
    })
  }

  if (checks.length >= 2 && checks[0].folder === checks[1].folder) {
    throw new Error(`${workspace} folder switching did not produce distinct folders`)
  }
  if (checks.length >= 2 && checks[0].visibleCount === checks[1].visibleCount && checks[0].firstThreadId === checks[1].firstThreadId) {
    throw new Error(`${workspace} folder switching did not change visible thread slice`)
  }

  const openFolder = checks[0].folder
  const openItems = expectVisibleThreads(items, workspace, openFolder)
  const terminalLike =
    openItems.find((item) => ['cli', 'wsl-session-index'].includes(String(item?.source || '').trim())) ||
    openItems[0]
  const threadId = String(terminalLike?.id || terminalLike?.threadId || '')
  if (!threadId) {
    throw new Error(`${workspace} has no thread to open for ${openFolder}`)
  }

  const openResult = await openThread(driver, threadId)
  if (!openResult?.result?.ok) {
    throw new Error(`${workspace} openThread failed for ${threadId}: ${JSON.stringify(openResult)}`)
  }
  await waitFor(async () => {
    const state = await getOpenThreadState(driver)
    return state?.info?.activeThreadId === threadId && Number(state?.info?.messageCount || 0) > 0
  }, 15000, `${workspace} thread ${threadId} history render`)
  const openState = await getOpenThreadState(driver)
  if (!openState?.welcomeHidden) {
    throw new Error(`${workspace} thread ${threadId} still shows welcome card`)
  }

  return {
    workspace,
    folders: checks,
    openedThreadId: threadId,
    openedSource: String(terminalLike?.source || ''),
    messageCount: Number(openState?.info?.messageCount || 0),
  }
}

async function main() {
  const devProc = await ensureDevServerReady()
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
      const info = await driver.executeScript(`
        return !!window.__webCodexDebug && !!window.__webCodexE2E && !!document.getElementById('chatBox');
      `)
      return !!info
    }, 20000, 'codex web ready')

    const windows = await verifyWorkspace(driver, 'windows')
    const wsl2 = await verifyWorkspace(driver, 'wsl2')

    console.log('[ui:e2e:codex-threadlist-start-cwd-real] PASS')
    console.log(JSON.stringify({ windows, wsl2 }, null, 2))
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-threadlist-start-cwd-real] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

