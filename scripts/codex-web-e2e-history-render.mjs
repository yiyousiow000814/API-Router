import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { Builder, By } from 'selenium-webdriver'
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
    await sleep(200)
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
  let driver = null
  try {
    const msedgedriverPath = ensureMsEdgeDriver()
    const options = new edge.Options()
    options.addArguments('--window-size=1366,900')
    options.addArguments('--disable-features=OverlayScrollbar,OverlayScrollbars,OverlayScrollbarFlashAfterAnyScrollUpdate')
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
        const el = await driver.findElement(By.id('threadList'))
        return !!el
      } catch {
        return false
      }
    }, 20000, 'threadList element')

    const moduleProbe = await driver.executeAsyncScript(`
      const done = arguments[0];
      fetch('/src/ui/codex-web-dev.js', { cache: 'no-store' })
        .then((r) => r.text().then((t) => done({ ok: true, status: r.status, size: t.length })))
        .catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!moduleProbe?.ok || Number(moduleProbe.status || 0) !== 200) {
      throw new Error(`failed to load codex-web-dev.js: ${JSON.stringify(moduleProbe)}`)
    }

    await waitFor(async () => {
      const ok = await driver.executeScript(`return !!window.__webCodexScriptLoaded;`)
      return !!ok
    }, 20000, '__webCodexScriptLoaded')

    await waitFor(async () => {
      const ok = await driver.executeScript(`return !!window.__webCodexE2E;`)
      return !!ok
    }, 20000, '__webCodexE2E init')

    // Seed a single deterministic thread.
    const seeded = await driver.executeScript(`
      const h = window.__webCodexE2E;
      if (!h) {
        return {
          ok: false,
          error: '__webCodexE2E missing',
          debug: {
            href: location.href,
            path: location.pathname,
            title: document.title,
            scripts: Array.from(document.querySelectorAll('script')).map((s) => s.getAttribute('src') || '').filter(Boolean).slice(0, 8),
          }
        };
      }
      return h.seedThreads(2);
    `)
    if (!seeded?.ok) throw new Error(`seed failed: ${seeded?.error || 'unknown'} debug=${JSON.stringify(seeded?.debug || {})}`)

    // Provide a history that includes:
    // - a Codex-injected AGENTS prompt (should be hidden)
    // - image tags + inline image placeholders in text (should be stripped)
    // - input_image attachments (should render as images, not text)
    const historyOk = await driver.executeScript(`
      const h = window.__webCodexE2E;
      if (!h) return { ok: false, error: '__webCodexE2E missing' };
      // With seedThreads(2), e2e_0 is wsl2 and e2e_1 is windows (matches default workspaceTarget).
      const threadId = 'e2e_1';
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4//8/AwAI/AL+Zf1zGQAAAABJRU5ErkJggg==';
      const thread = {
        id: threadId,
        turns: [
          { items: [{ type: 'userMessage', content: [{ type: 'input_text', text: '# AGENTS.md instructions for C:\\\\repo\\\\n<INSTRUCTIONS>\\nPR-first\\n</INSTRUCTIONS>' }] }] },
          { items: [{ type: 'assistantMessage', text: 'OK.' }] },
          { items: [{ type: 'userMessage', content: [
            { type: 'input_text', text: '<image name=[Image #1]>\\n[image: inline-image]\\n</image>\\nHello' },
            { type: 'input_image', image_url: dataUrl },
          ] }] },
          { items: [{ type: 'assistantMessage', text: 'Saw it.' }] },
        ],
      };
      h.setThreadHistory(threadId, thread);
      return { ok: true, threadId };
    `)
    if (!historyOk?.ok) throw new Error(`history seed failed: ${historyOk?.error || 'unknown'}`)

    const opened = await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      if (!h || typeof h.openThread !== 'function') return done({ ok: false, error: 'openThread missing' });
      Promise.resolve(h.openThread('e2e_1'))
        .then((v) => done(v))
        .catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!opened?.ok) throw new Error(`openThread failed: ${opened?.error || 'unknown'}`)

    await waitFor(async () => {
      const count = await driver.executeScript(`return document.querySelectorAll('#chatBox .msg').length;`)
      return Number(count || 0) >= 2
    }, 15000, 'chat to render')

    const checks = await driver.executeScript(`
      const text = document.getElementById('chatBox')?.innerText || '';
      return {
        ok: true,
        hasAgents: /AGENTS\\.md instructions|<INSTRUCTIONS>/i.test(text),
        hasImageTag: /<image\\s+name=\\[Image\\s+#\\d+\\]>/i.test(text) || /<\\/image>/i.test(text),
        hasImagePlaceholder: /\\[image:/i.test(text),
        userImgs: document.querySelectorAll('#chatBox .msg.user img.msgAttachmentImage').length,
      };
    `)
    if (!checks?.ok) throw new Error('checks failed')
    if (checks.hasAgents) throw new Error('AGENTS bootstrap prompt should be hidden from chat rendering')
    if (checks.hasImageTag) throw new Error('raw <image name=[Image #...]> blocks should not be rendered verbatim')
    if (checks.hasImagePlaceholder) throw new Error('textual [image: ...] placeholders should not be rendered (render images instead)')
    if (!(Number(checks.userImgs || 0) >= 1)) throw new Error(`expected at least one rendered user image, got ${checks.userImgs}`)

    console.log('[ui:e2e:codex-history-render] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-history-render] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})
