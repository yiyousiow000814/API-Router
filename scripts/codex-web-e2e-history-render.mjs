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

      await driver.findElement(By.id('mobileMenuBtn')).click()
      await waitFor(async () => {
        const isOpen = await driver.executeScript(`return document.body.classList.contains('drawer-left-open');`)
        return !!isOpen
      }, 8000, 'drawer-left-open after menu click')

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
    await driver.executeScript(`
      const h = window.__webCodexE2E;
      if (!h) return;
      const threadId = h._activeThreadId || 'e2e_1';
      const cur = h.getThreadHistory(threadId);
      if (!cur) return;
      const cloned = JSON.parse(JSON.stringify(cur));
      const turns = Array.isArray(cloned.turns) ? cloned.turns : [];
      turns.push({
        items: [{ type: 'assistantMessage', text: Array.from({ length: 70 }).map((_, i) => 'incoming line ' + i + ' ' + 'y'.repeat(140)).join('\\n') }],
      });
      cloned.turns = turns;
      h.setThreadHistory(threadId, cloned);
      // Simulate the active-thread poll applying new history.
      if (typeof h.refreshActiveThread === 'function') h.refreshActiveThread();
    `)
    await new Promise((r) => setTimeout(r, 1400))
    const pinnedAfterIncoming = await driver.executeScript(`
      const box = document.getElementById('chatBox');
      if (!box) return false;
      return box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
    `)
    if (!pinnedAfterIncoming) throw new Error('expected pinned chat to auto-follow bottom after an incoming message')

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
      if (!box) return done({ ok: false, error: 'missing chatBox' });

      // Start at bottom so "new content appended" latches into live follow.
      box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
      box.dispatchEvent(new Event('scroll'));

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
      box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
      box.dispatchEvent(new Event('scroll'));

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
