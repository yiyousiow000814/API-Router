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
  const backdropBlock = /\.imageViewerBackdrop\s*\{[\s\S]*?\}/m.exec(html)?.[0] || ''
  if (!/top:\s*0/i.test(backdropBlock)) throw new Error('expected .imageViewerBackdrop to set top: 0 (mobile fixed overlay)')
  if (!/left:\s*0/i.test(backdropBlock)) throw new Error('expected .imageViewerBackdrop to set left: 0 (mobile fixed overlay)')
  if (!/right:\s*0/i.test(backdropBlock)) throw new Error('expected .imageViewerBackdrop to set right: 0 (mobile fixed overlay)')
  if (!/bottom:\s*0/i.test(backdropBlock)) throw new Error('expected .imageViewerBackdrop to set bottom: 0 (mobile fixed overlay)')
  if (!/scrollbar-gutter:\s*stable/i.test(html)) throw new Error('expected .messages to set scrollbar-gutter: stable (no jiggle on image load)')
  if (!/animation:\s*msg-enter\s*360ms/i.test(html)) throw new Error('expected msg-enter animation to be slowed to 360ms')
  if (!/animation-duration:\s*288ms/i.test(html)) throw new Error('expected tool msg-enter animation to be slowed to 288ms')

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

    // Opening a thread should land near the bottom (latest messages visible).
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
    if (!scrollChecks?.ok) throw new Error(`scroll checks failed: ${scrollChecks?.error || 'unknown'}`)
    if (!(Number(scrollChecks.scrollTop || 0) > 0)) throw new Error('expected chat to be scrolled down on open (not at top)')
    if (Number(scrollChecks.scrollTop || 0) + Number(scrollChecks.clientHeight || 0) < Number(scrollChecks.scrollHeight || 0) - 60) {
      throw new Error('expected chat to land near bottom on open')
    }

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
    await driver.executeScript(`
      const btn = document.getElementById('scrollToBottomBtn');
      if (btn) btn.click();
    `)
    // Should animate (not "snap") to bottom: on the next animation frame we should not yet be at bottom.
    const animProbe = await driver.executeAsyncScript(`
      const done = arguments[0];
      const box = document.getElementById('chatBox');
      const btn = document.getElementById('scrollToBottomBtn');
      if (!box || !btn) return done({ ok: false, error: 'missing box/btn' });
      const before = box.scrollTop;
      const target = box.scrollHeight - box.clientHeight;
      btn.click();
      requestAnimationFrame(() => {
        const after = box.scrollTop;
        const dist = (box.scrollHeight - (after + box.clientHeight));
        done({ ok: true, before, after, dist, target });
      });
    `)
    if (!animProbe?.ok) throw new Error(`anim probe failed: ${animProbe?.error || 'unknown'}`)
    if (Number(animProbe.dist || 0) <= 18) throw new Error('expected scroll-to-bottom to animate (not land at bottom within 1 frame)')
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
