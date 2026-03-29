import { spawn, spawnSync } from 'node:child_process'
import { Builder } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'
import { ensureMsEdgeDriver, repoRoot } from './ui-check/runtime-utils.mjs'

const BASE_URL = String(process.env.CODEX_WEB_URL || 'http://127.0.0.1:5174/codex-web?e2e=1').trim()
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

async function canReach(url) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    clearTimeout(timer)
    return res.ok
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
    ['/d', '/s', '/c', 'npm.cmd', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5174'],
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
  await ensureMsEdgeDriver()

  const options = new edge.Options()
  if (!KEEP_VISIBLE) options.addArguments('--headless=new')
  options.addArguments('--disable-gpu')
  options.addArguments('--window-size=1280,900')

  const driver = await new Builder().forBrowser('MicrosoftEdge').setEdgeOptions(options).build()
  try {
    await driver.get(BASE_URL)

    await waitFor(async () => {
      const ok = await driver.executeScript(`return !!window.__webCodexScriptLoaded;`)
      return !!ok
    }, 20000, '__webCodexScriptLoaded')

    await waitFor(async () => {
      const ok = await driver.executeScript(`return !!window.__webCodexE2E;`)
      return !!ok
    }, 20000, '__webCodexE2E init')

    const seeded = await driver.executeScript(`
      const h = window.__webCodexE2E;
      if (!h || typeof h.setModels !== 'function') return { ok: false, error: 'setModels missing' };
      return h.setModels([
        { id: 'gpt-5.2-codex', supportedReasoningEfforts: [{ effort: 'medium' }, { effort: 'high' }], defaultReasoningEffort: 'high' },
        { id: 'gpt-5.3-codex', supportedReasoningEfforts: [{ effort: 'medium' }, { effort: 'high' }], defaultReasoningEffort: 'high' },
      ]);
    `)
    if (!seeded?.ok) throw new Error(`setModels failed: ${seeded?.error || 'unknown'}`)

    await waitFor(async () => {
      const cur = await driver.executeScript(`
        return {
          model: String(document.getElementById('headerModelLabel')?.textContent || '').trim(),
          effort: String(document.getElementById('headerReasoningEffort')?.textContent || '').trim(),
          effortDisplay: String(getComputedStyle(document.getElementById('headerReasoningEffort')).display || ''),
        };
      `)
      return cur?.model.length > 0 && cur?.effort.length > 0 && cur?.effortDisplay !== 'none'
    }, 10000, 'header labels to render')

    // Regression: effort label should be baseline-aligned with the model label.
    // On some WebViews, `inline-flex` can sit ~1px lower than adjacent text; use `inline-block`.
    {
      const display = await driver.executeScript(`
        return String(getComputedStyle(document.getElementById('headerReasoningEffort')).display || '');
      `)
      if (display === 'flex' || display === 'inline-flex') {
        throw new Error(`expected headerReasoningEffort to not be flex, got ${JSON.stringify(display)}`)
      }
    }

    const align = await driver.executeScript(`
      const model = document.getElementById('headerModelLabel');
      const effort = document.getElementById('headerReasoningEffort');
      if (!model || !effort) return { ok: false, error: 'missing labels' };
      const a = model.getBoundingClientRect();
      const b = effort.getBoundingClientRect();
      const ac = (a.top + a.bottom) / 2;
      const bc = (b.top + b.bottom) / 2;
      return {
        ok: true,
        delta: Math.abs(ac - bc),
        a: { top: a.top, bottom: a.bottom },
        b: { top: b.top, bottom: b.bottom },
      };
    `)
    if (!align?.ok) throw new Error(`alignment probe failed: ${align?.error || 'unknown'}`)
    if (Number(align.delta || 0) > 1.5) {
      throw new Error(`model/effort not aligned: ${JSON.stringify(align)}`)
    }
  } finally {
    await driver.quit().catch(() => {})
    if (devProc) killProcessTree(devProc)
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[ui:e2e:codex-header-align] FAIL:', err && err.stack ? err.stack : String(err))
  process.exitCode = 1
})
