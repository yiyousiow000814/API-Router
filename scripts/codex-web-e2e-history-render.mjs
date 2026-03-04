import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
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
  // Regression: the image viewer must use explicit edges (top/left/right/bottom) because some mobile
  // webviews have spotty support for `inset: 0` on fixed elements.
  const html = fs.readFileSync(path.join(repoRoot, 'codex-web.html'), 'utf8')
  // z-index must use a small sequential scale (avoid scattered large magic numbers).
  {
    const rootBlock = /:root\s*\{[\s\S]*?\}/m.exec(html)?.[0] || ''
    const getVar = (name) => {
      const escaped = String(name || '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
      const m = new RegExp(`${escaped}\\s*:\\s*(\\d+)`, 'i').exec(rootBlock)
      return m ? Number(m[1]) : null
    }
    const vars = [
      ['--z-chat-opening', 1],
      ['--z-chat-fab', 2],
      ['--z-chat-menu', 3],
      ['--z-chat-submenu', 4],
      ['--z-chat-header', 5],
      ['--z-drawer-backdrop', 6],
      ['--z-drawer-panel', 7],
      ['--z-image-viewer', 8],
    ]
    for (const [name, expected] of vars) {
      const got = getVar(name)
      if (got !== expected) throw new Error(`expected ${name} to be ${expected}, got ${String(got)}`)
    }
    if (/\bz-index\s*:\s*[1-9]\d+\b/i.test(html)) {
      throw new Error('expected no 2+ digit z-index magic numbers in codex-web.html (use --z-* scale)')
    }
  }
  const backdropBlock = /\.imageViewerBackdrop\s*\{[\s\S]*?\}/m.exec(html)?.[0] || ''
  if (!/top:\s*0/i.test(backdropBlock)) throw new Error('expected .imageViewerBackdrop to set top: 0 (mobile fixed overlay)')
  if (!/left:\s*0/i.test(backdropBlock)) throw new Error('expected .imageViewerBackdrop to set left: 0 (mobile fixed overlay)')
  if (!/right:\s*0/i.test(backdropBlock)) throw new Error('expected .imageViewerBackdrop to set right: 0 (mobile fixed overlay)')
  if (!/bottom:\s*0/i.test(backdropBlock)) throw new Error('expected .imageViewerBackdrop to set bottom: 0 (mobile fixed overlay)')
  // Regression: opening-chat overlay should avoid inset shorthand (some WebViews are spotty with it).
  {
    const openingBlock = /\.chatOpeningOverlay\s*\{[\s\S]*?\}/m.exec(html)?.[0] || ''
    if (!/\bposition\s*:\s*absolute\b/i.test(openingBlock)) throw new Error('expected .chatOpeningOverlay to be position: absolute')
    if (!/\btop\s*:\s*0\b/i.test(openingBlock)) throw new Error('expected .chatOpeningOverlay to set top: 0')
    if (!/\bleft\s*:\s*0\b/i.test(openingBlock)) throw new Error('expected .chatOpeningOverlay to set left: 0')
    if (!/\bright\s*:\s*0\b/i.test(openingBlock)) throw new Error('expected .chatOpeningOverlay to set right: 0')
    if (!/\bbottom\s*:\s*0\b/i.test(openingBlock)) throw new Error('expected .chatOpeningOverlay to set bottom: 0')
    if (/\binset\s*:/i.test(openingBlock)) throw new Error('expected .chatOpeningOverlay to avoid inset shorthand')
  }
  if (!/scrollbar-gutter:\s*stable/i.test(html)) throw new Error('expected .messages to set scrollbar-gutter: stable (no jiggle on image load)')
  if (!/animation:\s*msg-enter\s*360ms/i.test(html)) throw new Error('expected msg-enter animation to be slowed to 360ms')
  if (!/animation-duration:\s*288ms/i.test(html)) throw new Error('expected tool msg-enter animation to be slowed to 288ms')
  if (!/\.chatPanel\s+\.panelHeader\s+\.headerModelMenu\s*\{[\s\S]*box-shadow:\s*none/i.test(html)) {
    throw new Error('expected model menu to disable box-shadow')
  }
  if (!/\.effortInlineOverlay\s*\{[\s\S]*box-shadow:\s*none/i.test(html)) {
    throw new Error('expected reasoning-effort submenu to disable box-shadow')
  }
  {
    const stripComments = (s) => String(s || '').replace(/\/\*[\s\S]*?\*\//g, '')
    const overlayBlockRaw = /\.effortInlineOverlay\s*\{[\s\S]*?\}/m.exec(html)?.[0] || ''
    const showBlockRaw = /\.effortInlineOverlay\.show\s*\{[\s\S]*?\}/m.exec(html)?.[0] || ''
    const overlayBlock = stripComments(overlayBlockRaw)
    const showBlock = stripComments(showBlockRaw)
    if (!/\bdisplay\s*:\s*grid\b/i.test(overlayBlock)) throw new Error('expected .effortInlineOverlay to use display: grid (mounted for transitions)')
    if (/\bdisplay\s*:\s*none\b/i.test(overlayBlock)) throw new Error('expected .effortInlineOverlay to not use display: none (prevents transitions)')
    if (/\bdisplay\s*:/i.test(showBlock)) throw new Error('expected .effortInlineOverlay.show to not toggle display (transition-only)')
  }

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

    // Regression: when there is no persisted selection, default should pick the latest model
    // (not the first item / isDefault), and default effort should be "medium" when supported.
    {
      const seeded = await driver.executeScript(`
        try {
          localStorage.removeItem('web_codex_selected_model_v1');
          localStorage.removeItem('web_codex_reasoning_effort_v1');
          localStorage.removeItem('web_codex_model_user_selected_v1');
          localStorage.removeItem('web_codex_effort_user_selected_v1');
        } catch {}
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
          };
        `)
        return cur?.model === '5.3-codex' && cur?.effort === 'medium'
      }, 10000, 'latest model default selection')

      const cur = await driver.executeScript(`
        return {
          model: String(document.getElementById('headerModelLabel')?.textContent || '').trim(),
          effort: String(document.getElementById('headerReasoningEffort')?.textContent || '').trim(),
        };
      `)
      if (cur?.model !== '5.3-codex') throw new Error(`expected latest model 5.3-codex, got ${JSON.stringify(cur)}`)
      if (cur?.effort !== 'medium') throw new Error(`expected default effort medium, got ${JSON.stringify(cur)}`)
    }

    // Regression: while models are still loading, the header should say "Loading models..." and
    // the model picker should not open a menu that says "No models available".
    {
      const forced = await driver.executeScript(`
        const h = window.__webCodexE2E;
        if (!h || typeof h.setModelLoading !== 'function') return { ok: false, error: 'setModelLoading missing' };
        return h.setModelLoading(true);
      `)
      if (!forced?.ok) throw new Error(`failed to force model loading state: ${forced?.error || 'unknown'}`)

      const pre = await driver.executeScript(`
        const label = document.getElementById('headerModelLabel');
        const trigger = document.getElementById('headerModelTrigger');
        const picker = document.getElementById('headerModelPicker');
        const chev = picker ? picker.querySelector('.headerModelChevron') : null;
        const cs = chev ? getComputedStyle(chev) : null;
        return {
          label: String(label?.textContent || '').trim(),
          ariaDisabled: String(trigger?.getAttribute('aria-disabled') || '').trim(),
          open: !!picker?.classList.contains('open'),
          chevronDisplay: String(cs?.display || ''),
          chevronOpacity: String(cs?.opacity || ''),
        };
      `)
      if (pre?.label !== 'Loading models...') throw new Error(`expected header model label to show Loading models..., got ${JSON.stringify(pre?.label || '')}`)
      if (pre?.ariaDisabled !== 'true') throw new Error(`expected header model trigger aria-disabled=true while loading, got ${JSON.stringify(pre?.ariaDisabled || '')}`)
      {
        const op = Number.parseFloat(String(pre?.chevronOpacity || ''))
        const hidden = pre?.chevronDisplay === 'none' || (Number.isFinite(op) && op <= 0.01)
        if (!hidden) {
          throw new Error(`expected header chevron to be hidden while loading, got display=${JSON.stringify(pre?.chevronDisplay || '')} opacity=${JSON.stringify(pre?.chevronOpacity || '')}`)
        }
      }

      // Avoid descender clipping ("g" tail in "Loading") by requiring a non-tight line-height.
      const lh = await driver.executeScript(`
        const label = document.getElementById('headerModelLabel');
        if (!label) return { ok: false, error: 'missing headerModelLabel' };
        const s = getComputedStyle(label);
        const fontSize = parseFloat(String(s.fontSize || '0')) || 0;
        const raw = String(s.lineHeight || '').trim();
        const lineHeight = raw === 'normal' ? NaN : (parseFloat(raw) || 0);
        const pbRaw = String(s.paddingBottom || '').trim();
        const paddingBottom = parseFloat(pbRaw) || 0;
        return { ok: true, fontSize, lineHeight, raw, paddingBottom, pbRaw };
      `)
      if (!lh?.ok) throw new Error(`line-height probe failed: ${lh?.error || 'unknown'}`)
      if (Number.isFinite(lh.lineHeight) && lh.fontSize > 0 && lh.lineHeight < lh.fontSize * 1.1) {
        throw new Error(`expected header model label line-height >= 1.1x font-size to avoid clipping; got fontSize=${lh.fontSize} lineHeight=${lh.lineHeight} raw=${JSON.stringify(lh.raw)}`)
      }
      if (!(Number(lh.paddingBottom || 0) >= 1)) {
        throw new Error(`expected header model label padding-bottom >= 1px to avoid descender clipping; got pb=${lh.paddingBottom} raw=${JSON.stringify(lh.pbRaw)}`)
      }

      await driver.executeScript(`document.getElementById('headerModelTrigger')?.click?.();`)
      await new Promise((r) => setTimeout(r, 250))
      const stillClosed = await driver.executeScript(`return !!document.getElementById('headerModelPicker')?.classList.contains('open');`)
      if (stillClosed) throw new Error('expected model picker to stay closed while models are loading')

      // Loading label should not "flash": once shown, keep it visible for at least 1s, then
      // transition to the selected model+effort with an animation (no hard swap).
      const loadingSwap = await driver.executeScript(`
        const h = window.__webCodexE2E;
        if (!h || typeof h.loadModelsWithMinLoadingMs !== 'function') return { ok: false, error: 'loadModelsWithMinLoadingMs missing' };
        const t0 = performance.now();
        const r = h.loadModelsWithMinLoadingMs([
          {
            id: 'gpt-5.2',
            displayName: 'gpt-5.2',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { effort: 'low', description: 'fast' },
              { effort: 'medium', description: 'default' },
              { effort: 'high', description: 'deep' },
            ],
          },
        ], 1000);
        return { ok: true, t0, remainingMs: r && typeof r.remainingMs === 'number' ? r.remainingMs : -1 };
      `)
      if (!loadingSwap?.ok) throw new Error(`loadModelsWithMinLoadingMs failed: ${loadingSwap?.error || 'unknown'}`)

      // Observe over time:
      // - Loading models... must remain for at least 1s (no flash)
      // - Effort must not appear while label still says Loading models...
      // - Swap must be animated (we should see the `isSwapping` class at least once)
      // - Final state should be 5.2 + medium
      const tStart = Date.now()
      let sawSwapClass = false
      let sawLoaded = false
      let visModelAt = -1
      let visEffAt = -1
      let visChevAt = -1
      let last = { text: '', eff: '' }
      while (Date.now() - tStart < 1400) {
        // eslint-disable-next-line no-await-in-loop
        const p = await driver.executeScript(`
          const model = document.getElementById('headerModelLabel');
          const effort = document.getElementById('headerReasoningEffort');
          const picker = document.getElementById('headerModelPicker');
          const chev = picker ? picker.querySelector('.headerModelChevron') : null;
          const cs = chev ? getComputedStyle(chev) : null;
          const text = String(model?.textContent || '').trim();
          const eff = String(effort?.textContent || '').trim();
          const swapping = !!(model?.classList?.contains?.('isSwapping') || effort?.classList?.contains?.('isSwapping'));
          const ms = model ? getComputedStyle(model) : null;
          const es = effort ? getComputedStyle(effort) : null;
          return {
            text,
            eff,
            swapping,
            chevronDisplay: String(cs?.display || ''),
            chevronOpacity: String(cs?.opacity || ''),
            modelOpacity: String(ms?.opacity || ''),
            effortOpacity: String(es?.opacity || ''),
          };
        `)
        last = { text: String(p?.text || ''), eff: String(p?.eff || '') }
        if (p?.swapping) sawSwapClass = true
        if (String(p?.text || '').trim() === 'Loading models...') {
          const op = Number.parseFloat(String(p?.chevronOpacity || ''))
          const hidden = String(p?.chevronDisplay || '') === 'none' || (Number.isFinite(op) && op <= 0.01)
          if (!hidden) {
            throw new Error(`expected chevron hidden while label is Loading models..., got display=${JSON.stringify(p?.chevronDisplay || '')} opacity=${JSON.stringify(p?.chevronOpacity || '')}`)
          }
        }

        const elapsed = Date.now() - tStart
        if (elapsed < 600) {
          if (last.text !== 'Loading models...') throw new Error(`expected Loading models... to remain visible for >=600ms, got ${JSON.stringify(last.text)}`)
          if (last.eff) throw new Error(`expected no effort label while still loading, got ${JSON.stringify(last.eff)}`)
        }
        if (last.text === 'Loading models...' && last.eff) {
          throw new Error('effort label appeared while model label still showed Loading models... (should swap in sync)')
        }
        if (last.text && last.text !== 'Loading models...') {
          sawLoaded = true
        }

        // Capture first frame each element is "visible" (opacity high enough).
        const mo = Number.parseFloat(String(p?.modelOpacity || ''))
        const eo = Number.parseFloat(String(p?.effortOpacity || ''))
        const co = Number.parseFloat(String(p?.chevronOpacity || ''))
        if (visModelAt < 0 && last.text && last.text !== 'Loading models...' && Number.isFinite(mo) && mo >= 0.85) visModelAt = Date.now() - tStart
        if (visEffAt < 0 && last.eff && Number.isFinite(eo) && eo >= 0.85) visEffAt = Date.now() - tStart
        if (visChevAt < 0 && last.text && last.text !== 'Loading models...' && String(p?.chevronDisplay || '') !== 'none' && Number.isFinite(co) && co >= 0.85) visChevAt = Date.now() - tStart

        // eslint-disable-next-line no-await-in-loop
        await sleep(20)
      }
      if (!sawSwapClass) throw new Error('expected an animated swap (isSwapping) when changing Loading models... -> model label/effort')
      if (!sawLoaded) throw new Error(`expected to leave loading state within 1.4s, last=${JSON.stringify(last)}`)
      if (last.text !== '5.2') throw new Error(`expected final model label 5.2, got ${JSON.stringify(last.text)}`)
      if (last.eff !== 'medium') throw new Error(`expected final effort label medium, got ${JSON.stringify(last.eff)}`)

      // Model, effort, and chevron should become visible at essentially the same time.
      if (visModelAt < 0 || visEffAt < 0 || visChevAt < 0) {
        throw new Error(`expected model+effort+chevron to become visible; got visModelAt=${visModelAt} visEffAt=${visEffAt} visChevAt=${visChevAt}`)
      }
      const maxVis = Math.max(visModelAt, visEffAt, visChevAt)
      const minVis = Math.min(visModelAt, visEffAt, visChevAt)
      if (maxVis - minVis > 45) {
        throw new Error(`expected model+effort+chevron to appear within 45ms of each other; got model=${visModelAt}ms effort=${visEffAt}ms chev=${visChevAt}ms`)
      }

      // Chevron should become visible promptly once loading is gone.
      await waitFor(async () => {
        const p = await driver.executeScript(`
          const picker = document.getElementById('headerModelPicker');
          const chev = picker ? picker.querySelector('.headerModelChevron') : null;
          const cs = chev ? getComputedStyle(chev) : null;
          const label = String(document.getElementById('headerModelLabel')?.textContent || '').trim();
          const op = Number.parseFloat(String(cs?.opacity || ''));
          const visible = cs && cs.display !== 'none' && (!Number.isFinite(op) || op >= 0.85);
          return { label, visible, display: String(cs?.display || ''), opacity: String(cs?.opacity || '') };
        `)
        return p?.label === '5.2' && !!p?.visible
      }, 2000, 'header chevron visible after loading swap')
    }

    // Regression: empty thread list must not get stuck showing "Loading chats..." after the
    // request finishes (threadListLoading flips false in finally).
    {
      const res = await driver.executeAsyncScript(`
        const done = arguments[0];
        (async () => {
          const h = window.__webCodexE2E;
          if (!h || typeof h.refreshThreadsWithMock !== 'function') return done({ ok: false, error: 'refreshThreadsWithMock missing' });
          const r = await h.refreshThreadsWithMock('windows', []);
          done(r);
        })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
      `)
      if (!res?.ok) throw new Error(`refreshThreadsWithMock failed: ${res?.error || 'unknown'}`)

      await waitFor(async () => {
        const t = await driver.executeScript(`return String(document.getElementById('threadList')?.innerText || '').trim();`)
        return t.includes('No threads yet.') && !t.includes('Loading chats')
      }, 8000, 'empty threads shows No threads yet (not Loading chats)')
    }

    // Regression: assistant markdown should render with visible structure in codex-web
    // (lists, inline code, code blocks). Otherwise the web view looks like a flat wall of text.
    {
      const markdown = [
        'We changed semantics: **mismatch** still logs `warning`.',
        '',
        '1. Gateway-side dedupe',
        '2. Daily Events rebuild',
        '',
        '- Parent bullet',
        '  1. Child ordered one',
        '  2. Child ordered two',
        '- Second bullet',
        '',
        '1. Parent ordered',
        '  - Child bullet A',
        '  - Child bullet B',
        '2. Parent ordered two',
        '',
        '```js',
        'console.log(\"hello\")',
        '```',
      ].join('\n')
      const seeded = await driver.executeAsyncScript(`
        const markdown = arguments[0];
        const done = arguments[arguments.length - 1];
        try {
          const h = window.__webCodexE2E;
          if (!h || typeof h.setThreadHistory !== 'function') return done({ ok: false, error: 'setThreadHistory missing' });
          const threadId = 'e2e_markdown_1';
          h.setThreadHistory(threadId, {
            id: threadId,
            modelName: 'gpt-5.3-codex',
            turns: [
              { items: [{ type: 'assistantMessage', text: String(markdown || '') }] },
            ],
          });
          done({ ok: true, threadId });
        } catch (e) {
          done({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      `, markdown)
      if (!seeded?.ok) throw new Error(`seed markdown thread failed: ${seeded?.error || 'unknown'}`)

      const opened = await driver.executeAsyncScript(`
        const done = arguments[0];
        (async () => {
          const h = window.__webCodexE2E;
          const r = await h.openThread(${JSON.stringify('e2e_markdown_1')});
          done(r);
        })().catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
      `)
      if (!opened?.ok) throw new Error(`openThread failed: ${opened?.error || 'unknown'}`)

      await waitFor(async () => {
        const ok = await driver.executeScript(`
          const box = document.getElementById('chatBox');
          if (!box) return { ok: false };
          const hasList = !!box.querySelector('ol, ul');
          const hasInline = !!box.querySelector('code.msgInlineCode');
          const hasBlock = !!box.querySelector('pre.msgCodeBlock');
          return { ok: hasList && hasInline && hasBlock, hasList, hasInline, hasBlock };
        `)
        return !!ok?.ok
      }, 8000, 'assistant markdown structure (list/inline code/code block)')

      // Regression: nested lists must nest structurally (no "bullet + numbering pinned together").
      // - UL should contain nested OL
      // - OL should contain nested UL
      const nesting = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        if (!box) return null;
        const ulHasOl = !!box.querySelector('ul li ol');
        const olHasUl = !!box.querySelector('ol li ul');
        return { ulHasOl, olHasUl };
      `)
      if (!nesting) throw new Error('missing nesting probe')
      if (!nesting.ulHasOl) throw new Error(`expected ul->li->ol nesting, got ${JSON.stringify(nesting)}`)
      if (!nesting.olHasUl) throw new Error(`expected ol->li->ul nesting, got ${JSON.stringify(nesting)}`)

      // Inline code should not be visually invisible (must have non-transparent background or border).
      const inlineStyle = await driver.executeScript(`
        const node = document.querySelector('#chatBox code.msgInlineCode');
        if (!node) return null;
        const cs = getComputedStyle(node);
        return { color: String(cs.color || ''), bg: String(cs.backgroundColor || ''), br: String(cs.borderTopColor || ''), pl: String(cs.paddingLeft || '') };
      `)
      if (!inlineStyle) throw new Error('missing inline code style probe')

      // Codex-like: inline code should be colored (blue-ish) without a pill background.
      // Accept a range: ensure it's not gray/black and is in the blue-ish direction (B >= R/G), and background is transparent.
      {
        const m = /rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(String(inlineStyle.color || ''))
        if (!m) throw new Error(`expected inline code color to be rgb/rgba, got ${JSON.stringify(inlineStyle)}`)
        const r = Number(m[1] || 0)
        const g = Number(m[2] || 0)
        const b = Number(m[3] || 0)
        if (!(b >= g && b >= r && b >= 140)) {
          throw new Error(`expected inline code to be blue-ish (dominant B), got ${JSON.stringify({ ...inlineStyle, r, g, b })}`)
        }
      }
      if (!/0,\s*0,\s*0,\s*0\)?/.test(String(inlineStyle.bg || '')) && !/transparent/i.test(String(inlineStyle.bg || ''))) {
        // Some browsers report transparent as rgba(0, 0, 0, 0); others as 'transparent'.
        throw new Error(`expected inline code background to be transparent, got ${JSON.stringify(inlineStyle)}`)
      }
    }

    // Regression: reasoning-effort selector should be a nested submenu to the RIGHT of the active model option
    // (ChatGPT-style: show current effort + chevron, click chevron opens a submenu).
    // This test runs in e2e mode without requiring a running gateway.
    {
      const seededModels = await driver.executeScript(`
        const h = window.__webCodexE2E;
        if (!h || typeof h.setModels !== 'function') return { ok: false, error: 'setModels missing' };
        h.setModels([
          {
            id: 'gpt-5.2',
            displayName: 'gpt-5.2',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { effort: 'low', description: 'fast' },
              { effort: 'medium', description: 'default' },
              { effort: 'high', description: 'deep' },
              { effort: 'xhigh', description: 'deepest' },
            ],
          },
          {
            id: 'gpt-5.3-codex',
            displayName: 'gpt-5.3-codex',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { effort: 'low', description: 'fast' },
              { effort: 'medium', description: 'default' },
              { effort: 'high', description: 'deep' },
              { effort: 'xhigh', description: 'deepest' },
            ],
          },
          { id: 'gpt-5.2-codex', displayName: 'gpt-5.2-codex' },
        ]);
        return { ok: true };
      `)
      if (!seededModels?.ok) throw new Error(`seed models failed: ${seededModels?.error || 'unknown'}`)

      // Regression: tapping the model trigger should not "flicker" open then immediately close.
      // This requires a real pointer tap (pointerdown+pointerup+click), not a synthetic dispatchEvent.
      {
        const trigger = await driver.findElement(By.id('headerModelTrigger'))
        await driver.actions({ async: true }).move({ origin: trigger }).press().release().perform()
        await waitFor(async () => {
          const open = await driver.executeScript(
            `return !!document.getElementById('headerModelPicker')?.classList.contains('open');`,
          )
          return !!open
        }, 1200, 'header model picker open (tap)', 20)

        // Stay open for a short stability window.
        for (let i = 0; i < 12; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(25)
          // eslint-disable-next-line no-await-in-loop
          const open = await driver.executeScript(
            `return !!document.getElementById('headerModelPicker')?.classList.contains('open');`,
          )
          if (!open) throw new Error('expected model menu to remain open after tapping the trigger (no flicker)')
        }
      }

      // The model row chevron should not create excessive whitespace (keep the menu compact).
      const rowGap = await driver.executeScript(`
        const menu = document.getElementById('headerModelMenu');
        if (!menu) return { ok: false, error: 'missing menu' };
        const btns = Array.from(menu.querySelectorAll('.headerModelOption'));
        const target = btns.find((b) => /5\\.3-codex/.test(String(b.textContent || '')));
        if (!target) return { ok: false, error: 'missing 5.3-codex row' };
        const label = target.querySelector('.modelLabel');
        const chev = target.querySelector('.effortSubChevron');
        if (!label || !chev) return { ok: false, error: 'missing label/chevron' };
        const lr = label.getBoundingClientRect();
        const cr = chev.getBoundingClientRect();
        return { ok: true, gap: Math.round(Math.max(0, cr.left - lr.right)) };
      `)
      if (!rowGap?.ok) throw new Error(`row gap probe failed: ${rowGap?.error || 'unknown'}`)
      // Old builds had a large empty strip here; keep it modest.
      if (typeof rowGap.gap === 'number' && rowGap.gap > 32) {
        throw new Error(`expected model row gap (label→chevron) <= 32px, got ${rowGap.gap}px`)
      }

      // Selecting a model should keep the menu open so the user can immediately adjust reasoning effort.
      const selectedModelStaysOpen = await driver.executeScript(`
        const menu = document.getElementById('headerModelMenu');
        const btns = menu ? Array.from(menu.querySelectorAll('.headerModelOption')) : [];
        const target = btns.find((b) => /5\\.3-codex/.test(String(b.textContent || '')));
        if (!target) return { ok: false, error: 'missing model option 5.3-codex' };
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
        const open = !!document.getElementById('headerModelPicker')?.classList.contains('open');
        const active = document.querySelector('#headerModelMenu .headerModelOption.active .modelLabel');
        return { ok: true, open, active: String(active?.textContent || '').trim() };
      `)
      if (!selectedModelStaysOpen?.ok) throw new Error(`model select probe failed: ${selectedModelStaysOpen?.error || 'unknown'}`)
      if (!selectedModelStaysOpen?.open) throw new Error('expected model menu to stay open after selecting a model')
      if (selectedModelStaysOpen.active !== '5.3-codex') throw new Error(`expected active model to become 5.3-codex, got ${JSON.stringify(selectedModelStaysOpen.active)}`)

      const reasoningUi = await driver.executeScript(`
        const menu = document.getElementById('headerModelMenu');
        if (!menu) return { ok: false, error: 'missing headerModelMenu' };
        const legacyRow = menu.querySelector('.headerModelEffortRow');
        const activeOption = menu.querySelector('.headerModelOption.active');
        const legacyPills = activeOption ? activeOption.querySelector('.effortPills') : null;
        const label = String(activeOption?.querySelector('.effortSubLabel')?.textContent || '').trim();
        const chev = activeOption ? activeOption.querySelector('.effortSubChevron') : null;
        const allChevs = Array.from(menu.querySelectorAll('.effortSubChevron')).length;
        const modelCount = Array.from(menu.querySelectorAll('.headerModelOption')).length;
        return {
          ok: true,
          hasLegacyRow: !!legacyRow,
          hasLegacyPills: !!legacyPills,
          hasActiveOption: !!activeOption,
          hasChevron: !!chev,
          allChevs,
          modelCount,
          label,
        };
      `)
      if (!reasoningUi?.ok) throw new Error(`reasoning ui probe failed: ${reasoningUi?.error || 'unknown'}`)
      if (reasoningUi?.hasLegacyRow) throw new Error('expected .headerModelEffortRow to be removed (effort selector must be inline to active model)')
      if (!reasoningUi?.hasActiveOption) throw new Error('expected an active model option in the menu')
      if (reasoningUi?.hasLegacyPills) throw new Error('expected legacy multi-pill effort selector to be removed (must be compact dropdown)')
      if (!reasoningUi?.hasChevron) throw new Error('expected .effortSubChevron to exist next to active model')
      if (Number(reasoningUi?.allChevs || 0) !== Number(reasoningUi?.modelCount || 0)) {
        throw new Error(`expected a chevron for each model row, got chevs=${JSON.stringify(reasoningUi?.allChevs || 0)} models=${JSON.stringify(reasoningUi?.modelCount || 0)}`)
      }
      if (reasoningUi?.label) throw new Error(`expected no inline effort label in the model row, got ${JSON.stringify(reasoningUi?.label || '')}`)

      // Selecting a model opens the effort overlay via requestAnimationFrame; wait for it.
      await waitFor(async () => {
        const ok = await driver.executeScript(`return !!document.getElementById('effortInlineOverlay')?.classList.contains('show');`)
        return !!ok
      }, 2000, 'effortInlineOverlay.show')

      const pickedHigh = await driver.executeScript(`
        const overlay = document.getElementById('effortInlineOverlay');
        if (!overlay || !overlay.classList.contains('show')) return { ok: false, error: 'missing inline effort overlay' };
        const menuRect = document.getElementById('headerModelMenu')?.getBoundingClientRect();
        const overlayRectOpen = overlay.getBoundingClientRect();
        const rightOfMenu = !!(menuRect && overlayRectOpen && overlayRectOpen.left >= menuRect.right - 2);
        const gap = !!(menuRect && overlayRectOpen) ? Math.round(Math.max(0, overlayRectOpen.left - menuRect.right)) : -1;
        const high = Array.from(overlay.querySelectorAll('.effortInlineOption')).find((b) => {
          const label = b.querySelector('.label');
          return String(label?.textContent || '').trim() === 'high';
        });
        if (!high) return { ok: false, error: 'missing high option' };
        high.click();
        const pickerOpen2 = !!document.getElementById('headerModelPicker')?.classList.contains('open');
        const overlayGone = !document.getElementById('effortInlineOverlay')?.classList.contains('show');
        return { ok: true, pickerOpen2, overlayGone, rightOfMenu, gap };
      `)
      if (!pickedHigh?.ok) throw new Error(`failed to pick high: ${pickedHigh?.error || 'unknown'}`)
      if (pickedHigh.pickerOpen2) throw new Error('expected model menu to close after selecting reasoning effort')
      if (!pickedHigh.overlayGone) throw new Error('expected effort submenu overlay to close after selecting reasoning effort')
      if (!pickedHigh.rightOfMenu) throw new Error('expected effort overlay to appear to the right of model menu')
      if (typeof pickedHigh.gap === 'number' && pickedHigh.gap > 3) throw new Error(`expected effort submenu gap <= 3px, got ${pickedHigh.gap}px`)

      await waitFor(async () => {
        const headerEffort = await driver.executeScript(
          `return String(document.getElementById('headerReasoningEffort')?.textContent || '').trim();`,
        )
        return headerEffort === 'high'
      }, 4000, 'headerReasoningEffort becomes high')

      // Header effort should match the model label typography (same font-size and font-weight).
      const typo = await driver.executeScript(`
        const model = document.getElementById('headerModelLabel');
        const effort = document.getElementById('headerReasoningEffort');
        if (!model || !effort) return { ok: false, error: 'missing header labels' };
        const ms = getComputedStyle(model);
        const es = getComputedStyle(effort);
        return {
          ok: true,
          modelFontSize: ms.fontSize,
          effortFontSize: es.fontSize,
          modelFontWeight: ms.fontWeight,
          effortFontWeight: es.fontWeight,
          modelFontFamily: ms.fontFamily,
          effortFontFamily: es.fontFamily,
          effortMarginLeft: es.marginLeft,
        };
      `)
      if (!typo?.ok) throw new Error(`typography probe failed: ${typo?.error || 'unknown'}`)
      if (typo.modelFontSize !== typo.effortFontSize) {
        throw new Error(`expected header effort to match model font-size, model=${typo.modelFontSize} effort=${typo.effortFontSize}`)
      }
      if (typo.modelFontWeight !== typo.effortFontWeight) {
        throw new Error(`expected header effort to match model font-weight, model=${typo.modelFontWeight} effort=${typo.effortFontWeight}`)
      }
      if (typo.modelFontFamily !== typo.effortFontFamily) {
        throw new Error(`expected header effort to match model font-family, model=${typo.modelFontFamily} effort=${typo.effortFontFamily}`)
      }
      if (typo.effortMarginLeft !== '0px') {
        throw new Error(`expected header effort margin-left to be 0px, got ${JSON.stringify(typo.effortMarginLeft)}`)
      }

      // Close via outside click (more reliable than re-clicking the trigger across webviews).
      await driver.executeScript(`document.body.click();`)
      await waitFor(async () => {
        const open = await driver.executeScript(`return !!document.getElementById('headerModelPicker')?.classList.contains('open');`)
        return !open
      }, 8000, 'header model picker closed')
    }

    // Regression (mobile): while "Opening chat..." overlay is shown, the sidebar menu button should
    // remain clickable (overlay must not cover the header).
    {
      const originalRect = await driver.manage().window().getRect()
      await driver.manage().window().setRect({ ...originalRect, width: 420, height: 900 })
      await driver.executeScript(`
        document.getElementById('chatOpeningOverlay')?.classList.add('show');
      `)
      await waitFor(async () => {
        try {
          const el = await driver.findElement(By.id('mobileMenuBtn'))
          return !!el
        } catch {
          return false
        }
      }, 8000, 'mobileMenuBtn element')

      const hitTest = await driver.executeScript(`
        const btn = document.getElementById('mobileMenuBtn');
        if (!btn) return { ok: false, error: 'missing mobileMenuBtn' };
        const r = btn.getBoundingClientRect();
        const x = Math.floor(r.left + r.width / 2);
        const y = Math.floor(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        const within = !!(hit && (hit === btn || btn.contains(hit)));
        return {
          ok: true,
          within,
          hitTag: hit?.tagName || '',
          hitId: hit?.id || '',
          hitClass: typeof hit?.className === 'string' ? hit.className : String(hit?.className || ''),
        };
      `)
      if (!hitTest?.ok) throw new Error(`mobile menu hit test failed: ${hitTest?.error || 'unknown'}`)
      if (!hitTest?.within) {
        throw new Error(`expected mobile menu to be topmost (hit within mobileMenuBtn), got tag=${hitTest.hitTag} id=${hitTest.hitId} class=${hitTest.hitClass}`)
      }

      const zProbe = await driver.executeScript(`
        const header = document.querySelector('.chatPanel .panelHeader');
        const overlay = document.getElementById('chatOpeningOverlay');
        if (!header || !overlay) return { ok: false, error: 'missing header/overlay' };
        const hs = getComputedStyle(header);
        const os = getComputedStyle(overlay);
        const hz = parseInt(String(hs.zIndex || ''), 10);
        const oz = parseInt(String(os.zIndex || ''), 10);
        return { ok: true, headerZ: hs.zIndex, overlayZ: os.zIndex, hz, oz, overlayPe: os.pointerEvents };
      `)
      if (!zProbe?.ok) throw new Error(`z-index probe failed: ${zProbe?.error || 'unknown'}`)
      if (!(Number.isFinite(zProbe.hz) && Number.isFinite(zProbe.oz) && zProbe.hz > zProbe.oz)) {
        throw new Error(`expected header z-index > opening overlay z-index, got ${JSON.stringify(zProbe)}`)
      }
      if (String(zProbe.overlayPe) !== 'none') {
        throw new Error(`expected opening overlay pointer-events:none, got ${JSON.stringify(zProbe)}`)
      }

      await driver.findElement(By.id('mobileMenuBtn')).click()
      await waitFor(async () => {
        const isOpen = await driver.executeScript(`return document.body.classList.contains('drawer-left-open');`)
        return !!isOpen
      }, 8000, 'drawer-left-open after menu click')

      // Drawer backdrop should use blur (backdrop-filter) for the expected dim+blur effect.
      const blurProbe = await driver.executeScript(`
        const backdrop = document.getElementById('mobileDrawerBackdrop');
        if (!backdrop) return { ok: false, error: 'missing mobileDrawerBackdrop' };
        const s = getComputedStyle(backdrop);
        return { ok: true, bf: String(s.backdropFilter || '').trim(), wbf: String(s.webkitBackdropFilter || '').trim() };
      `)
      if (!blurProbe?.ok) throw new Error(`backdrop blur probe failed: ${blurProbe?.error || 'unknown'}`)
      const bfText = (blurProbe.bf || blurProbe.wbf || '').toLowerCase()
      if (!bfText.includes('blur(')) {
        throw new Error(`expected drawer backdrop to enable blur, got ${JSON.stringify(blurProbe)}`)
      }

      // While the drawer is open, the backdrop must be above the chat header so clicking the
      // top-right badge area also closes the drawer (matches expected UX).
      const overlayHit = await driver.executeScript(`
        const badge = document.getElementById('headerWorkspaceBadge');
        const backdrop = document.getElementById('mobileDrawerBackdrop');
        if (!badge || !backdrop) return { ok: false, error: 'missing badge/backdrop' };
        const r = badge.getBoundingClientRect();
        const x = Math.floor(r.left + r.width / 2);
        const y = Math.floor(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        const withinBackdrop = !!(hit && (hit === backdrop || backdrop.contains(hit)));
        return {
          ok: true,
          withinBackdrop,
          hitTag: hit?.tagName || '',
          hitId: hit?.id || '',
          hitClass: typeof hit?.className === 'string' ? hit.className : String(hit?.className || ''),
        };
      `)
      if (!overlayHit?.ok) throw new Error(`drawer backdrop hit-test failed: ${overlayHit?.error || 'unknown'}`)
      if (!overlayHit?.withinBackdrop) {
        throw new Error(`expected backdrop to cover header badge while drawer is open, got tag=${overlayHit.hitTag} id=${overlayHit.hitId} class=${overlayHit.hitClass}`)
      }

      // When drawer is open, only one workspace switch should be visible (avoid duplicate WIN/WSL2).
      const wsUi = await driver.executeScript(`
        const header = document.getElementById('headerWorkspaceSwitch');
        const drawer = document.getElementById('drawerWorkspaceSwitch');
        const headerVisible = !!(header && header.offsetParent);
        const drawerVisible = !!(drawer && drawer.offsetParent);
        return { headerVisible, drawerVisible };
      `)
      if (wsUi?.headerVisible) throw new Error('expected headerWorkspaceSwitch to be hidden while drawer is open (avoid duplicate workspace toggles)')
      if (!wsUi?.drawerVisible) throw new Error('expected drawerWorkspaceSwitch to remain visible while drawer is open')

      // Clicking the backdrop (including over the header region) must close the drawer.
      await driver.executeScript(`
        const badge = document.getElementById('headerWorkspaceBadge');
        const r = badge?.getBoundingClientRect?.();
        const x = r ? Math.floor(r.left + r.width / 2) : 10;
        const y = r ? Math.floor(r.top + r.height / 2) : 10;
        document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      `)
      await waitFor(async () => {
        const isOpen = await driver.executeScript(`return document.body.classList.contains('drawer-left-open');`)
        return !isOpen
      }, 8000, 'drawer-left-open cleared by backdrop click')

      await driver.executeScript(`document.getElementById('chatOpeningOverlay')?.classList.remove('show');`)
      await driver.manage().window().setRect(originalRect)
    }

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

    // Regression (mobile): opening a very large chat must not "freeze" header clicks.
    // Historically, synchronous DOM work (especially clearing a huge prior chat) blocked the event loop,
    // making the hamburger/model picker feel unclickable until loading finished.
    {
      const bigSeed = await driver.executeScript(`
        const h = window.__webCodexE2E;
        if (!h) return { ok: false, error: 'missing e2e hook' };
        const prevId = 'e2e_big_prev';
        const nextId = 'e2e_big_next';
        const a = h.seedHeavyThreadHistory
          ? h.seedHeavyThreadHistory(prevId, { turns: 160, itemsPerTurn: 3, textSize: 360 })
          : { ok: false, error: 'seedHeavyThreadHistory missing' };
        const b = h.seedHeavyThreadHistory
          ? h.seedHeavyThreadHistory(nextId, { turns: 220, itemsPerTurn: 3, textSize: 360 })
          : { ok: false, error: 'seedHeavyThreadHistory missing' };
        return { ok: !!(a && a.ok && b && b.ok), prevId, nextId, a, b };
      `)
      if (!bigSeed?.ok) throw new Error(`big seed failed: ${bigSeed?.error || 'unknown'} detail=${JSON.stringify(bigSeed)}`)

      const originalRect = await driver.manage().window().getRect()
      await driver.manage().window().setRect({ ...originalRect, width: 420, height: 900 })

      // First open a huge chat so the DOM contains hundreds of nodes; then open another huge chat.
      // Clearing the previous chat must not block header clicks.
      const openedPrev = await driver.executeAsyncScript(`
        const done = arguments[0];
        const h = window.__webCodexE2E;
        if (!h || typeof h.openThread !== 'function') return done({ ok: false, error: 'openThread missing' });
        Promise.resolve(h.openThread('e2e_big_prev'))
          .then((v) => done(v))
          .catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
      `)
      if (!openedPrev?.ok) throw new Error(`openThread(prev) failed: ${openedPrev?.error || 'unknown'}`)

      // Opening a chat should land at (or extremely near) the bottom.
      const prevBottom = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        if (!box) return { ok: false, error: 'missing chatBox' };
        const dist = Math.max(0, box.scrollHeight - (box.scrollTop + box.clientHeight));
        return { ok: true, dist: Math.round(dist) };
      `)
      if (!prevBottom?.ok) throw new Error(`bottom probe failed: ${prevBottom?.error || 'unknown'}`)
      if (Number(prevBottom.dist || 0) > 3) {
        throw new Error(`expected opened chat to be at bottom (dist<=3px), got ${JSON.stringify(prevBottom)}`)
      }

      // Regression: if the user previously scrolled away (non-sticky), opening a new chat with stickToBottom
      // must still keep following late layout settles (e.g. images loading) for a short window.
      const lateSettle = await driver.executeAsyncScript(`
        const done = arguments[0];
        const h = window.__webCodexE2E;
        const box = document.getElementById('chatBox');
        if (!h || !box) return done({ ok: false, error: 'missing e2e/chatBox' });
        h.setChatStickiness(false);
        // Simulate "image load" by changing padding on an existing element (attribute change; no DOM mutation).
        const lastBody = box.querySelector('.msg:last-child .msgBody');
        if (!lastBody) return done({ ok: false, error: 'missing last msgBody' });
        lastBody.style.paddingBottom = '0px';
        setTimeout(() => { lastBody.style.paddingBottom = '520px'; }, 220);
        setTimeout(() => {
          const dist = Math.max(0, box.scrollHeight - (box.scrollTop + box.clientHeight));
          done({ ok: true, dist: Math.round(dist) });
        }, 760);
      `)
      if (!lateSettle?.ok) throw new Error(`late settle probe failed: ${lateSettle?.error || 'unknown'}`)
      if (Number(lateSettle.dist || 0) > 3) {
        throw new Error(`expected open-chat stickiness to keep bottom during late layout settles (dist<=3px), got ${JSON.stringify(lateSettle)}`)
      }

      const startedSlow = await driver.executeScript(`
        const h = window.__webCodexE2E;
        return h?.startOpenThreadSlow?.('e2e_big_next') || { ok: false, error: 'startOpenThreadSlow missing' };
      `)
      if (!startedSlow?.ok) throw new Error(`startOpenThreadSlow failed: ${startedSlow?.error || 'unknown'}`)

      await waitFor(async () => {
        const shown = await driver.executeScript(`return !!document.getElementById('chatOpeningOverlay')?.classList.contains('show');`)
        return !!shown
      }, 8000, 'chatOpeningOverlay.show (slow open)')

      // Real mobile taps are pointer events; some WebViews drop/delay `click` under load.
      // The hamburger must respond to pointerdown immediately while opening.
      const pointerResponsive = await driver.executeAsyncScript(`
        const done = arguments[0];
        const btn = document.getElementById('mobileMenuBtn');
        if (!btn) return done({ ok: false, error: 'missing mobileMenuBtn' });
        const started = performance.now();
        setTimeout(() => {
          const fired = performance.now();
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
          const opened = document.body.classList.contains('drawer-left-open');
          done({ ok: true, delayMs: Math.round(fired - started), opened });
        }, 0);
      `)
      if (!pointerResponsive?.ok) throw new Error(`pointer responsiveness probe failed: ${pointerResponsive?.error || 'unknown'}`)
      if (!pointerResponsive?.opened) throw new Error(`expected drawer-left-open to toggle on pointerdown during slow open, got ${JSON.stringify(pointerResponsive)}`)
      if (Number(pointerResponsive?.delayMs || 0) > 150) {
        throw new Error(`expected header pointer interactions to stay responsive while opening (delay <= 150ms), got ${JSON.stringify(pointerResponsive)}`)
      }

      // Measure event loop responsiveness while the slow open is in progress. If the open path blocks the
      // main thread synchronously, even a `setTimeout(..., 0)` click will be delayed.
      const responsive = await driver.executeAsyncScript(`
        const done = arguments[0];
        const btn = document.getElementById('mobileMenuBtn');
        if (!btn) return done({ ok: false, error: 'missing mobileMenuBtn' });
        const started = performance.now();
        setTimeout(() => {
          const fired = performance.now();
          btn.click();
          const opened = document.body.classList.contains('drawer-left-open');
          done({ ok: true, delayMs: Math.round(fired - started), opened });
        }, 0);
      `)
      if (!responsive?.ok) throw new Error(`responsiveness probe failed: ${responsive?.error || 'unknown'}`)
      if (!responsive?.opened) throw new Error(`expected drawer-left-open to toggle during slow open, got ${JSON.stringify(responsive)}`)
      // Target: menu should respond quickly even while opening.
      if (Number(responsive?.delayMs || 0) > 150) {
        throw new Error(`expected header interactions to stay responsive while opening (delay <= 150ms), got ${JSON.stringify(responsive)}`)
      }

      const done = await driver.executeAsyncScript(`
        const done = arguments[0];
        const h = window.__webCodexE2E;
        if (!h || typeof h.awaitSlowOpenDone !== 'function') return done({ ok: false, error: 'awaitSlowOpenDone missing' });
        h.awaitSlowOpenDone().then(done).catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
      `)
      if (!done?.ok) throw new Error(`slow open did not complete: ${done?.error || 'unknown'}`)

      const nextBottom = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        if (!box) return { ok: false, error: 'missing chatBox' };
        const dist = Math.max(0, box.scrollHeight - (box.scrollTop + box.clientHeight));
        return { ok: true, dist: Math.round(dist) };
      `)
      if (!nextBottom?.ok) throw new Error(`bottom probe failed: ${nextBottom?.error || 'unknown'}`)
      if (Number(nextBottom.dist || 0) > 3) {
        throw new Error(`expected opened chat to be at bottom after slow open (dist<=3px), got ${JSON.stringify(nextBottom)}`)
      }

      await driver.executeScript(`document.body.classList.remove('drawer-left-open'); document.getElementById('mobileDrawerBackdrop')?.classList.remove('show');`)
      await driver.manage().window().setRect(originalRect)
    }

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
           // Regression: harness-only wrappers like <subagent_notification> and <turn_aborted> must never
           // render as user/assistant chat bubbles (align clawdex-mobile behavior).
           { items: [{ type: 'userMessage', content: [{ type: 'input_text', text: '<subagent_notification>{\"marker\":\"e2e-subagent\",\"kind\":\"thread_spawn\"}</subagent_notification>' }] }] },
           { items: [{ type: 'assistantMessage', text: '<turn_aborted>{\"marker\":\"e2e-aborted\",\"reason\":\"user_cancel\"}</turn_aborted>' }] },
           // Regression: compaction can inject the harness prompt later in the thread; it must still be hidden.
           { items: [{ type: 'userMessage', content: [{ type: 'input_text', text: '# AGENTS.md instructions for C:\\\\repo\\\\n<INSTRUCTIONS>\\nPR-first\\n</INSTRUCTIONS>' }] }] },
           { items: [{ type: 'userMessage', content: [
             { type: 'input_text', text: '<image name=[Image #1]>\\n[image: inline-image]\\n</image>\\nHello' },
             { type: 'input_image', image_url: dataUrl },
             { type: 'input_text', text: '[Image #2]\\n[image: inline-image-2]\\nNext' },
            { type: 'input_image', image_url: dataUrl },
            { type: 'input_text', text: '[Image #3]\\n[image: inline-image-3]' },
            { type: 'input_image', image_url: dataUrl },
            { type: 'input_text', text: '[Image #4]\\n[image: inline-image-4]' },
            { type: 'input_image', image_url: dataUrl },
            { type: 'input_text', text: '[Image #5]\\n[image: inline-image-5]' },
            { type: 'input_image', image_url: dataUrl },
            { type: 'input_text', text: '[Image #6]\\n[image: inline-image-6]' },
            { type: 'input_image', image_url: dataUrl },
          ] }] },
          { items: [{ type: 'assistantMessage', text: 'Saw it.' }] },
          { items: [{ type: 'userMessage', content: [
            { type: 'input_text', text: '[Image #A]\\n[image: inline-image-a]\\n3-up' },
            { type: 'input_image', image_url: dataUrl },
            { type: 'input_text', text: '[Image #B]\\n[image: inline-image-b]' },
            { type: 'input_image', image_url: dataUrl },
            { type: 'input_text', text: '[Image #C]\\n[image: inline-image-c]' },
            { type: 'input_image', image_url: dataUrl },
          ] }] },
          { items: [{ type: 'assistantMessage', text: Array.from({ length: 120 }).map((_, i) => 'line ' + String(i + 1)).join('\\n') }] },
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

    // Regression: never show the Codex harness "AGENTS.md instructions" bootstrap prompt as a user message,
    // even if it appears mid-thread (e.g. after compaction).
    {
      const t = await driver.executeScript(`return String(document.getElementById('chatBox')?.innerText || '');`)
      if (t.includes('AGENTS.md instructions') || t.includes('<INSTRUCTIONS>')) {
        throw new Error('expected bootstrap AGENTS prompt to be hidden from chat history')
      }
    }

    // Regression: never render harness wrapper blocks as normal chat content.
    {
      const t = await driver.executeScript(`return String(document.getElementById('chatBox')?.innerText || '');`)
      if (t.includes('e2e-subagent') || t.includes('subagent_notification')) {
        throw new Error('expected subagent_notification harness wrapper to be hidden from chat history')
      }
      if (t.includes('e2e-aborted') || t.includes('turn_aborted')) {
        throw new Error('expected turn_aborted harness wrapper to be hidden from chat history')
      }
    }

    // Opening a thread should land near the bottom (latest messages visible).
    await waitFor(async () => {
      const scrollChecks = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        if (!box) return { ok: false, error: 'no chatBox' };
        return {
          ok: true,
          scrollTop: box.scrollTop,
          scrollHeight: box.scrollHeight,
          clientHeight: box.clientHeight,
        };
      `)
      if (!scrollChecks?.ok) return false
      const top = Number(scrollChecks.scrollTop || 0)
      const h = Number(scrollChecks.scrollHeight || 0)
      const ch = Number(scrollChecks.clientHeight || 0)
      if (!(top > 0)) return false
      return top + ch >= h - 60
    }, 2500, 'chat to land near bottom on open')

    // Regression: after open, late layout settles (e.g. image thumbnails) must keep us pinned to the true bottom
    // if the user has not scrolled away. Otherwise the "scroll to bottom" button flashes on open.
    await sleep(1300)
    {
      const settled = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        const btn = document.getElementById('scrollToBottomBtn');
        if (!box || !btn) return { ok: false, error: 'missing box or btn' };
        const dist = Math.max(0, box.scrollHeight - (box.scrollTop + box.clientHeight));
        const show = btn.classList.contains('show');
        const dbg = window.__webCodexDbg || {};
        return { ok: true, dist: Math.round(dist), show, dbg };
      `)
      if (!settled?.ok) throw new Error(`settle probe failed: ${settled?.error || 'unknown'}`)
      if (Number(settled.dist || 0) > 3) {
        throw new Error(`expected opened chat to stay pinned to bottom after settles (dist<=3px), got ${JSON.stringify(settled)}`)
      }
      if (settled.show) {
        throw new Error(`expected scroll-to-bottom button hidden after open settles, got ${JSON.stringify(settled)}`)
      }
    }

    // Regression: Immediately after opening (while stick-to-bottom timers may still be active),
    // if the user scrolls UP even slightly to read history, we must NOT yank them back to bottom.
    // This was happening due to auto-stick timers treating small scrolls as "still pinned".
    {
      const scrolled = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        if (!box) return { ok: false, error: 'missing chatBox' };
        // Simulate a real user gesture (touch) before scrolling.
        box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
        const before = box.scrollTop;
        box.scrollTop = Math.max(0, before - 60);
        box.dispatchEvent(new Event('scroll'));
        const after = box.scrollTop;
        const dbg = window.__webCodexDbg || {};
        return { ok: true, before, after, dbg };
      `)
      if (!scrolled?.ok) throw new Error(`immediate scroll-up probe failed: ${scrolled?.error || 'unknown'}`)
      if (!(Number(scrolled.after || 0) <= Number(scrolled.before || 0))) {
        throw new Error(`expected scrollTop to move up (after<=before), got ${JSON.stringify(scrolled)}`)
      }
      // Give any pending auto-stick timers time to fire; we should still be away from bottom.
      await new Promise((r) => setTimeout(r, 650))
      const stayedUp = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        if (!box) return { ok: false, error: 'missing chatBox' };
        const dist = box.scrollHeight - (box.scrollTop + box.clientHeight);
        const dbg = window.__webCodexDbg || {};
        return { ok: true, dist: Math.round(dist), scrollTop: Math.round(box.scrollTop), dbg };
      `)
      if (!stayedUp?.ok) throw new Error(`scroll-up verify failed: ${stayedUp?.error || 'unknown'}`)
      if (Number(stayedUp.dist || 0) <= 40) {
        throw new Error(`expected to remain scrolled away from bottom after immediate scroll-up, got ${JSON.stringify(stayedUp)}`)
      }
    }

    // Regression: opening a chat should remain pinned to bottom even if layout shifts shortly after
    // (e.g. late fonts/image sizing). Without repeated stick-to-bottom, the view can drift above bottom.
    await driver.executeScript(`
      const box = document.getElementById('chatBox');
      const last = box ? box.querySelector('.msg:last-of-type .msgBody') : null;
      if (last) {
        setTimeout(() => {
          last.textContent = (last.textContent || '') + '\\n' + Array.from({ length: 40 }).map((_, i) => 'late line ' + i + ' ' + 'x'.repeat(120)).join('\\n');
        }, 650);
      }
    `)
    await new Promise((r) => setTimeout(r, 1100))
    const pinnedAfterShift = await driver.executeScript(`
      const box = document.getElementById('chatBox');
      if (!box) return false;
      return box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
    `)
    if (!pinnedAfterShift) throw new Error('expected chat to stay pinned near bottom after a late layout shift')

    // Regression: if the user is pinned at bottom, a new incoming message (append-only) should keep
    // the view at bottom even when the new message is tall enough to push content far above bottom.
    // Bug: our live-follow loop auto-scrolls, but the scroll handler mis-classified that as user
    // scroll and stopped the follow, leaving the view "stuck" above bottom.
    const appended = await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      if (!h) return done({ ok: false, error: 'missing e2e hook' });
      const threadId = h._activeThreadId || 'e2e_1';
      const cur = h.getThreadHistory(threadId);
      if (!cur) return done({ ok: false, error: 'missing seeded history' });
      const cloned = JSON.parse(JSON.stringify(cur));
      const turns = Array.isArray(cloned.turns) ? cloned.turns : [];
      turns.push({
        items: [{ type: 'assistantMessage', text: Array.from({ length: 70 }).map((_, i) => 'incoming line ' + i + ' ' + 'y'.repeat(140)).join('\\n') }],
      });
      cloned.turns = turns;
      h.setThreadHistory(threadId, cloned);
      if (typeof h.refreshActiveThread !== 'function') return done({ ok: false, error: 'refreshActiveThread missing' });
      Promise.resolve(h.refreshActiveThread())
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e && e.message ? e.message : e) }));
    `)
    if (!appended?.ok) throw new Error(`failed to append incoming message: ${appended?.error || 'unknown'}`)
    await waitFor(async () => {
      const pinned = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        if (!box) return false;
        return box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
      `)
      return !!pinned
    }, 8000, 'pinned chat to auto-follow bottom after an incoming message')

    // When scrolled up meaningfully, a floating "scroll to bottom" button should appear; clicking it scrolls to bottom.
    {
      const shown = await driver.executeScript(`return !!document.getElementById('scrollToBottomBtn')?.classList.contains('show');`)
      if (shown) throw new Error('expected scroll-to-bottom button to be hidden when landing at bottom')
    }
    await driver.executeScript(`
      const box = document.getElementById('chatBox');
      if (box) {
        box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight - 60);
        box.dispatchEvent(new Event('scroll'));
      }
    `)
    await waitFor(async () => {
      const shown = await driver.executeScript(`return !!document.getElementById('scrollToBottomBtn')?.classList.contains('show');`)
      return !shown
    }, 8000, 'scroll-to-bottom button to stay hidden after small scroll')
    await driver.executeScript(`
      const box = document.getElementById('chatBox');
      if (box) {
        box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight - 260);
        box.dispatchEvent(new Event('scroll'));
      }
    `)
    await waitFor(async () => {
      const shown = await driver.executeScript(`return !!document.getElementById('scrollToBottomBtn')?.classList.contains('show');`)
      return !!shown
    }, 8000, 'scroll-to-bottom button to show when not near bottom')
    // Button should be horizontally centered in the chat box.
    const centered = await driver.executeScript(`
      const btn = document.getElementById('scrollToBottomBtn');
      const box = document.getElementById('chatBox');
      if (!btn || !box) return { ok: false };
      const br = btn.getBoundingClientRect();
      const cr = box.getBoundingClientRect();
      const btnCenter = br.left + br.width / 2;
      const boxCenter = cr.left + cr.width / 2;
      return { ok: true, deltaX: Math.abs(btnCenter - boxCenter), deltaBottom: Math.abs(cr.bottom - br.bottom), w: br.width, h: br.height };
    `)
    if (!centered?.ok) throw new Error('expected scroll-to-bottom button to exist for centering check')
    if (Number(centered.deltaX || 0) > 8) throw new Error(`expected scroll-to-bottom button to be centered (deltaX<=8px), got ${centered.deltaX}`)
    if (Number(centered.deltaBottom || 0) > 160) throw new Error(`expected scroll-to-bottom button to sit near bottom of chat area (deltaBottom<=160px), got ${centered.deltaBottom}`)
    if (Number(centered.w || 0) > 40 || Number(centered.h || 0) > 40) throw new Error(`expected scroll-to-bottom button to be compact (<=40px), got ${centered.w}x${centered.h}`)
    // Should animate (not "snap") to bottom, and take a noticeable amount of time (not a "flash").
    const animProbe = await driver.executeAsyncScript(`
      const done = arguments[0];
      const box = document.getElementById('chatBox');
      const btn = document.getElementById('scrollToBottomBtn');
      if (!box || !btn) return done({ ok: false, error: 'missing box/btn' });
      const before = box.scrollTop;
      const startedWall = Date.now();
      const onclickStr = String(btn.onclick || '');
      btn.click();

      let checkedFirstFrame = false;
      function tick() {
        const nowWall = Date.now();
        const after = box.scrollTop;
        const dist = (box.scrollHeight - (after + box.clientHeight));
        if (!checkedFirstFrame) {
          checkedFirstFrame = true;
          if (dist <= 18) return done({ ok: false, error: 'snap-within-1-frame', before, after, dist });
        }
        const dbg = window.__webCodexDbg || null;
        const endedAt = dbg && typeof dbg.lastSmoothScrollEndedAt === 'number' ? dbg.lastSmoothScrollEndedAt : 0;
        const startedAt = dbg && typeof dbg.lastSmoothScrollStartAt === 'number' ? dbg.lastSmoothScrollStartAt : startedWall;
        if (endedAt && endedAt >= startedWall) {
          return done({
            ok: true,
            before,
            after,
            dist,
            elapsedMs: endedAt - startedAt,
            onclickHasSmooth: onclickStr.includes('smoothScrollChatToBottom'),
            rafIsNative: String(window.requestAnimationFrame || '').includes('[native code]'),
            dbg,
          });
        }
        if (nowWall - startedWall > 5000) return done({ ok: false, error: 'timeout', before, after, dist, dbg });
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    `)
    if (!animProbe?.ok) throw new Error(`anim probe failed: ${animProbe?.error || 'unknown'} probe=${JSON.stringify(animProbe)}`)
    if (Number(animProbe.elapsedMs || 0) < 350)
      throw new Error(`expected scroll-to-bottom animation to be noticeable (>=350ms), got ${animProbe.elapsedMs}ms probe=${JSON.stringify(animProbe)}`)
    // End of animation should not "snap" a large distance in the final frame(s).
    // (This commonly happens when forcing scrollTop=scrollHeight and letting the browser clamp.)
    const tail = animProbe?.dbg?.lastSmoothScrollTail;
    if (Array.isArray(tail) && tail.length >= 2) {
      const a = Number(tail[tail.length - 2]);
      const b = Number(tail[tail.length - 1]);
      const delta = Math.abs(b - a);
      if (Number.isFinite(delta) && delta > 120)
        throw new Error(`expected smooth scroll to settle without a big last-frame snap (delta<=120px), got ${delta}px tail=${JSON.stringify(tail)}`)
    }
    await waitFor(async () => {
      const near = await driver.executeScript(`
        const box = document.getElementById('chatBox');
        if (!box) return false;
        return box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
      `)
      return !!near
    }, 8000, 'scroll-to-bottom click to land near bottom')
    await waitFor(async () => {
      const shown = await driver.executeScript(`return !!document.getElementById('scrollToBottomBtn')?.classList.contains('show');`)
      return !shown
    }, 8000, 'scroll-to-bottom button to hide near bottom')
    // When hidden, the button should not keep focus (avoids aria-hidden focused descendant warnings).
    const focusCheck = await driver.executeScript(`
      const btn = document.getElementById('scrollToBottomBtn');
      const active = document.activeElement;
      return {
        ok: true,
        btnHidden: btn ? btn.getAttribute('aria-hidden') : null,
        btnDisabled: btn ? !!btn.disabled : null,
        activeId: active ? active.id : null,
      };
    `)
    if (!focusCheck?.ok) throw new Error('focus check failed')
    if (String(focusCheck.btnHidden) !== 'true') throw new Error(`expected hidden scroll-to-bottom to set aria-hidden=true, got ${focusCheck.btnHidden}`)
    if (!focusCheck.btnDisabled) throw new Error('expected hidden scroll-to-bottom to be disabled (not focusable)')
    if (focusCheck.activeId === 'scrollToBottomBtn') throw new Error('expected focus to not remain on hidden scroll-to-bottom button')

    // Notifications should be able to render tool-like messages live (clawdex-style).
    const notif = await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      if (!h || typeof h.emitWsPayload !== 'function') return done({ ok: false, error: 'emitWsPayload missing' });
      const payload = {
        type: 'rpc.notification',
        payload: {
          method: 'item/created',
          params: {
            msg: {
              type: 'commandExecution',
              status: 'completed',
              command: 'echo hello',
              exitCode: 0,
              output: 'hello',
              thread_id: (h && h._activeThreadId) || 'e2e_1',
            }
          }
        }
      };
      const res = h.emitWsPayload(payload);
      // Let the DOM update and message animation attach.
      requestAnimationFrame(() => done(res));
    `)
    if (!notif?.ok) throw new Error(`emit notification failed: ${notif?.error || 'unknown'}`)
    await waitFor(async () => {
      const count = await driver.executeScript(`
        const nodes = Array.from(document.querySelectorAll('#chatBox .msg.system.kind-tool .msgBody'));
        return nodes.filter((n) => (n.textContent || '').includes('Ran')).length;
      `)
      return Number(count || 0) >= 1
    }, 8000, 'live tool-like notification to render')

    // Live updates (streaming deltas) should "push up" smoothly, not jump to create a blank gap.
    const liveFollowProbe = await driver.executeAsyncScript(`
      const done = arguments[0];
      const box = document.getElementById('chatBox');
      const h = window.__webCodexE2E;
      if (!box) return done({ ok: false, error: 'missing chatBox' });

      // Start at bottom so "new content appended" latches into live follow.
      if (h && typeof h.scrollChatToBottomNow === 'function') h.scrollChatToBottomNow();
      else {
        box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
        box.dispatchEvent(new Event('scroll'));
      }

      const msg = document.createElement('div');
      msg.className = 'msg assistant';
      msg.innerHTML = '<div class="msgHead">assistant</div><div class="msgBody"></div>';
      const body = msg.querySelector('.msgBody');
      body.textContent = 'streaming...';
      box.appendChild(msg);

      const start = Date.now();
      const tops = [];
      function sample() {
        tops.push(Number(box.scrollTop || 0));
        if (Date.now() - start > 1100) return finish();
        requestAnimationFrame(sample);
      }

      function finish() {
        let maxDelta = 0;
        let movingFrames = 0;
        for (let i = 1; i < tops.length; i += 1) {
          const d = Math.abs(tops[i] - tops[i - 1]);
          if (d > maxDelta) maxDelta = d;
          if (d > 0.5) movingFrames += 1;
        }
        done({ ok: true, maxDelta, movingFrames, frames: tops.length });
      }

      // Simulate streaming text growing the last message (like deltas).
      let i = 0;
      function tick() {
        i += 1;
        body.textContent += '\\n' + ('line ' + i + ' ' + 'x'.repeat(120));
        if (i >= 18) return;
        setTimeout(tick, 28);
      }
      setTimeout(tick, 24);
      requestAnimationFrame(sample);
    `)
    if (!liveFollowProbe?.ok) throw new Error(`live follow probe failed: ${liveFollowProbe?.error || 'unknown'}`)
    if (Number(liveFollowProbe.movingFrames || 0) < 6)
      throw new Error(`expected live updates to scroll over multiple frames (movingFrames>=6), got ${liveFollowProbe.movingFrames} probe=${JSON.stringify(liveFollowProbe)}`)
    if (Number(liveFollowProbe.maxDelta || 0) > 80)
      throw new Error(`expected live updates to avoid large single-frame jumps (maxDelta<=80px), got ${liveFollowProbe.maxDelta} probe=${JSON.stringify(liveFollowProbe)}`)

    // Streaming rendering should be incremental (chunk-by-chunk DOM nodes), not just one big textContent update.
    const streamingDomProbe = await driver.executeAsyncScript(`
      const done = arguments[0];
      const box = document.getElementById('chatBox');
      const h = window.__webCodexE2E;
      if (!box || !h) return done({ ok: false, error: 'missing chatBox/e2e' });
      if (typeof h.scrollChatToBottomNow === 'function') h.scrollChatToBottomNow();
      else {
        box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
        box.dispatchEvent(new Event('scroll'));
      }

      if (typeof h.createStreamingMessage !== 'function' || typeof h.appendStreamingDelta !== 'function') {
        return done({ ok: false, error: 'streaming hooks missing' });
      }
      const created = h.createStreamingMessage();
      if (!created || !created.ok) return done({ ok: false, error: 'createStreamingMessage failed' });

      let i = 0;
      function tick() {
        i += 1;
        h.appendStreamingDelta('line ' + i + '\\n');
        if (i >= 10) return;
        setTimeout(tick, 18);
      }
      setTimeout(tick, 16);
      setTimeout(() => {
        const chunks = box.querySelectorAll('.msg.assistant .streamChunk').length;
        done({ ok: true, chunks });
      }, 420);
    `)
    if (!streamingDomProbe?.ok) throw new Error(`streaming DOM probe failed: ${streamingDomProbe?.error || 'unknown'}`)
    if (Number(streamingDomProbe.chunks || 0) < 6)
      throw new Error(`expected streaming to render multiple .streamChunk nodes (>=6), got ${streamingDomProbe.chunks}`)

    const checks = await driver.executeScript(`
      const text = document.getElementById('chatBox')?.innerText || '';
      const mosaics = Array.from(document.querySelectorAll('#chatBox .msg.user .msgAttachments.mosaic'));
      const firstMosaic = mosaics[0] || null;
      const mr = firstMosaic?.getBoundingClientRect?.();
      const firstTile = firstMosaic?.querySelector?.('.msgAttachmentCard') || null;
      const tr = firstTile?.getBoundingClientRect?.();
      const allMosaics = Array.from(document.querySelectorAll('#chatBox .msg.user .msgAttachments.mosaic'));
      const lastMosaic = allMosaics[allMosaics.length - 1] || null;
      const lastTiles = lastMosaic ? Array.from(lastMosaic.querySelectorAll('.msgAttachmentCard')) : [];
      const lastTileTops = lastTiles.map((n) => Math.round(n.getBoundingClientRect().top));
      const firstMsg = firstMosaic ? firstMosaic.closest('.msg.user') : null;
      const firstMsgRect = firstMsg ? firstMsg.getBoundingClientRect() : null;
      const labelNodes = Array.from(document.querySelectorAll('#chatBox .msg.user .msgAttachmentCaption, #chatBox .msg.user .msgAttachmentLabelBadge'));
      const labelTexts = labelNodes.map((n) => (n.textContent || '').trim()).filter(Boolean);
      return {
        ok: true,
        hasAgents: /AGENTS\\.md instructions|<INSTRUCTIONS>/i.test(text),
        hasImageTag: /<image\\s+name=\\[Image\\s+#\\d+\\]>/i.test(text) || /<\\/image>/i.test(text),
        hasImagePlaceholder: /\\[image:/i.test(text),
        userImgs: document.querySelectorAll('#chatBox .msg.user img.msgAttachmentImage').length,
        hasCaption: labelTexts.some((t) => /^#1$/i.test(t)),
        hasVerboseImageLabel: labelTexts.some((t) => /Image\\s*#\\d+/i.test(t)),
        mosaic: mosaics.length > 0,
        mosaicCount: mosaics.length,
        firstMosaicTileCount: firstMosaic ? firstMosaic.querySelectorAll('.msgAttachmentCard').length : 0,
        firstMosaicOverlay: firstMosaic ? Array.from(firstMosaic.querySelectorAll('.msgAttachmentMoreOverlay')).map((n) => n.textContent || '') : [],
        firstMosaicWidth: mr ? mr.width : 0,
        firstTileAspect: tr && tr.width ? (tr.height / tr.width) : 0,
        lastMosaicTileCount: lastTiles.length,
        lastMosaicTileTops: lastTileTops,
        firstMsgWidth: firstMsgRect ? firstMsgRect.width : 0,
      };
    `)
    if (!checks?.ok) throw new Error('checks failed')
    if (checks.hasAgents) throw new Error('AGENTS bootstrap prompt should be hidden from chat rendering')
    if (checks.hasImageTag) throw new Error('raw <image name=[Image #...]> blocks should not be rendered verbatim')
    if (checks.hasImagePlaceholder) throw new Error('textual [image: ...] placeholders should not be rendered (render images instead)')
    if (!(Number(checks.userImgs || 0) >= 4)) throw new Error(`expected at least four rendered user images, got ${checks.userImgs}`)
    if (!checks.hasCaption) throw new Error('expected image caption (#1) to be rendered on the image')
    if (checks.hasVerboseImageLabel) throw new Error('expected image labels to be simplified (#1), not "Image #1"')
    if (!checks.mosaic) throw new Error('expected many images to collapse into a mosaic attachment grid')
    if (Number(checks.firstMosaicTileCount || 0) !== 4) throw new Error(`expected mosaic to show 4 tiles, got ${checks.firstMosaicTileCount}`)
    if (!Array.isArray(checks.firstMosaicOverlay) || !checks.firstMosaicOverlay.some((t) => /\+2/.test(String(t)))) {
      throw new Error(`expected mosaic to show "+2" overlay, got ${JSON.stringify(checks.firstMosaicOverlay || [])}`)
    }
    if (!(Number(checks.mosaicCount || 0) >= 2)) throw new Error('expected 3-image message to also render as mosaic (uniform tiles)')
    if (Number(checks.firstMosaicWidth || 0) > 320) throw new Error(`expected mosaic width <= 320px, got ${checks.firstMosaicWidth}`)
    if (!(Number(checks.firstTileAspect || 0) > 0 && Number(checks.firstTileAspect || 0) <= 0.82)) {
      throw new Error(`expected mosaic tiles to be wider than tall (aspect<=0.82), got ${checks.firstTileAspect}`)
    }
    // User bubble should stay compact when it includes attachments + text (avoid large empty backgrounds).
    if (Number(checks.firstMsgWidth || 0) > Number(checks.firstMosaicWidth || 0) + 46) {
      throw new Error(`expected user bubble width ~= mosaic width, got msg=${checks.firstMsgWidth} mosaic=${checks.firstMosaicWidth}`)
    }
    // 3-image message should not leave an empty column; we render it as a 3-column single-row mosaic.
    if (Number(checks.lastMosaicTileCount || 0) !== 3) throw new Error(`expected last mosaic to have 3 tiles, got ${checks.lastMosaicTileCount}`)
    if (Array.isArray(checks.lastMosaicTileTops) && new Set(checks.lastMosaicTileTops).size !== 1) {
      throw new Error(`expected 3-image mosaic tiles to be on one row, got tops=${JSON.stringify(checks.lastMosaicTileTops)}`)
    }

    // Clicking a tile should open a viewer (gallery / filmstrip lives there).
    await driver.executeScript(`
      const tiles = Array.from(document.querySelectorAll('#chatBox .msg.user .msgAttachments.mosaic .msgAttachmentCard'));
      if (tiles[3]) tiles[3].click();
    `)
    await waitFor(async () => {
      const open = await driver.executeScript(`return !!document.getElementById('imageViewerBackdrop')?.classList.contains('show');`)
      return !!open
    }, 8000, 'image viewer to open')

    // It should open at the clicked image (Image #4) and keep the active thumb visible (not stuck at far left).
    {
      const started = Date.now()
      let last = ''
      while (Date.now() - started < 8000) {
        // eslint-disable-next-line no-await-in-loop
        last = await driver.executeScript(`return document.getElementById('imageViewerTitle')?.textContent || ''`)
        if (/Image\s*#4/i.test(String(last))) break
        // eslint-disable-next-line no-await-in-loop
        await sleep(200)
      }
      if (!/Image\s*#4/i.test(String(last))) throw new Error(`expected viewer to open on Image #4, got: ${JSON.stringify(String(last))}`)
    }

    const filmstripVisible = await driver.executeScript(`
      const film = document.getElementById('imageViewerFilmstrip');
      const active = film?.querySelector('.imageViewerThumb.active');
      if (!film || !active) return { ok: false, error: 'film/active missing' };
      const fr = film.getBoundingClientRect();
      const ar = active.getBoundingClientRect();
      return {
        ok: true,
        film: { left: fr.left, right: fr.right },
        active: { left: ar.left, right: ar.right },
        clientWidth: film.clientWidth,
        scrollWidth: film.scrollWidth,
        scrollLeft: film.scrollLeft,
      };
    `)
    if (!filmstripVisible?.ok) throw new Error(`filmstrip visibility check failed: ${filmstripVisible?.error || 'unknown'}`)
    if (Number(filmstripVisible.scrollWidth || 0) > Number(filmstripVisible.clientWidth || 0) + 4) {
      if (!(Number(filmstripVisible.scrollLeft || 0) > 0)) throw new Error('expected filmstrip to auto-scroll near active image (scrollLeft > 0)')
    }
    if (Number(filmstripVisible.active.left || 0) < Number(filmstripVisible.film.left || 0) - 1) throw new Error('expected active thumb to be visible in filmstrip (left clipped)')
    if (Number(filmstripVisible.active.right || 0) > Number(filmstripVisible.film.right || 0) + 1) throw new Error('expected active thumb to be visible in filmstrip (right clipped)')

    // Viewer backdrop must cover the viewport (avoids "in-flow" rendering on some mobile browsers).
    const viewerChecks = await driver.executeScript(`
      const backdrop = document.getElementById('imageViewerBackdrop');
      if (!backdrop) return { ok: false, error: 'no backdrop' };
      const cs = window.getComputedStyle(backdrop);
      const rect = backdrop.getBoundingClientRect();
      return {
        ok: true,
        position: cs.position,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    `)
    if (!viewerChecks?.ok) throw new Error(`viewer checks failed: ${viewerChecks?.error || 'unknown'}`)
    if (viewerChecks.position !== 'fixed') throw new Error(`expected viewer backdrop position:fixed, got ${viewerChecks.position}`)
    if (Math.abs(Number(viewerChecks.rect?.top || 0)) > 2) throw new Error(`expected viewer backdrop to start near top=0, got ${viewerChecks.rect?.top}`)
    if (Math.abs(Number(viewerChecks.rect?.left || 0)) > 2) throw new Error(`expected viewer backdrop to start near left=0, got ${viewerChecks.rect?.left}`)
    if (Number(viewerChecks.rect?.width || 0) < Number(viewerChecks.vw || 0) * 0.95) throw new Error('expected viewer backdrop to span viewport width')
    if (Number(viewerChecks.rect?.height || 0) < Number(viewerChecks.vh || 0) * 0.95) throw new Error('expected viewer backdrop to span viewport height')

    // Regression: viewer should support navigating between multiple images in the chat.
    // We accept either a filmstrip thumbnail list or a next button; at minimum, selecting the 2nd image
    // should update the viewer title.
    const navOk = await driver.executeScript(`
      const title = document.getElementById('imageViewerTitle');
      if (!title) return { ok: false, error: 'no title' };
      const thumbs = Array.from(document.querySelectorAll('[data-qa=\"image-viewer-thumb\"]'));
      if (thumbs.length >= 2) {
        const before = title.textContent || '';
        thumbs[1].scrollIntoView?.({ block: 'center', inline: 'center' });
        thumbs[1].click();
        return {
          ok: true,
          mode: 'thumbs',
          before,
          after: title.textContent || '',
          thumbLabels: thumbs.map((t) => t.getAttribute('aria-label') || '').slice(0, 6),
        };
      }
      const next = document.querySelector('[data-qa=\"image-viewer-next\"]');
      if (next) {
        const before = title.textContent || '';
        next.click();
        return { ok: true, mode: 'next', before, after: title.textContent || '' };
      }
      return { ok: false, error: 'no thumbs or next button' };
    `)
    if (!navOk?.ok) throw new Error(`expected viewer navigation UI (thumbs/next): ${navOk?.error || 'unknown'}`)
    {
      const started = Date.now()
      let last = ''
      while (Date.now() - started < 5000) {
        // eslint-disable-next-line no-await-in-loop
        last = await driver.executeScript(`return document.getElementById('imageViewerTitle')?.textContent || ''`)
        if (/Image\s*#2/i.test(String(last))) break
        // eslint-disable-next-line no-await-in-loop
        await sleep(200)
      }
      if (!/Image\s*#2/i.test(String(last))) throw new Error(`expected viewer title to become Image #2, got: ${JSON.stringify(String(last))}`)
    }

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
