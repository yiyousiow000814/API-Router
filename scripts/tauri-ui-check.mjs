import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import {
  cleanupDirBestEffort,
  ensureDir,
  ensureMsEdgeDriver,
  pruneUiCheckRuntimeDirs,
  repoRoot,
  resolveTauriAppPath,
  runCapture,
  runOrThrow,
  runQuietOrThrow,
  startHiddenDesktopProcess,
  warnOrFail,
} from './ui-check/runtime-utils.mjs'
import {
  assertPxClose,
  clickButtonByText,
  clickTopNav,
  centerX,
  centerY,
  dayKeyFromOffset,
  ensureCodexAuthForSwitchboard,
  normalizeText,
  openModalAndClose,
  openModalAndCloseOptional,
  parsePx,
  pickDirectProvider,
  runFontBaselineCase,
  runEventLogCalendarDailyStatsCase,
  runPricingTimelineModalCase,
  runProviderStatisticsKeyStyleCase,
  runRequestsFirstPaintStabilityCase,
  runTopNavSwitchResponsivenessCase,
  runSwitchboardSwitchCase,
  runUsageHistoryScrollCase,
  seedHistoryRows,
  tauriInvoke,
  waitPageTitle,
  waitSectionHeading,
  waitVisible,
} from './ui-check/cases.mjs'

import { Builder, By, until } from 'selenium-webdriver'

process.env.NODE_NO_WARNINGS = '1'
// Keep the terminal clean in default (headless-ish) mode.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' ')

// Keep these in sync with `src/ui/App.tsx` drag logic to test responsiveness.
const DRAG_PROBE_DOWN = 0.82
const DRAG_PROBE_UP = 0.22

async function waitForPort(host, port, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection({ host, port })
      const done = (v) => {
        try {
          sock.destroy()
        } catch {}
        resolve(v)
      }
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
      sock.setTimeout(400, () => done(false))
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function getProviderOrder(driver) {
  return await driver.executeScript(`
    return Array.from(document.querySelectorAll('.aoProviderConfigCard[data-provider]'))
      .map((el) => el.getAttribute('data-provider'))
      .filter(Boolean);
  `)
}

async function getDragOverProvider(driver) {
  return await driver.executeScript(`
    const el = document.querySelector('.aoProviderConfigDragOver[data-provider]');
    return el ? el.getAttribute('data-provider') : null;
  `)
}

async function getPlaceholderIndex(driver) {
  return await driver.executeScript(`
    const list = document.querySelector('.aoProviderConfigList');
    if (!list) return -1;
    const kids = Array.from(list.children);
    return kids.findIndex((el) => el.classList && el.classList.contains('aoProviderConfigPlaceholder'));
  `)
}

async function waitForPlaceholderIndex(driver, predicate, timeoutMs = 800) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const idx = await getPlaceholderIndex(driver)
    if (predicate(idx)) return idx
    await new Promise((r) => setTimeout(r, 50))
  }
  return await getPlaceholderIndex(driver)
}

async function getRects(driver, cardEl, handleEl) {
  return await driver.executeScript(
    `
      const card = arguments[0];
      const handle = arguments[1];
      const cr = card.getBoundingClientRect();
      const hr = handle.getBoundingClientRect();
      return {
        card: { left: cr.left, top: cr.top, width: cr.width, height: cr.height },
        handle: { left: hr.left, top: hr.top, width: hr.width, height: hr.height },
      };
    `,
    cardEl,
    handleEl,
  )
}

async function getOverlayRect(driver) {
  return await driver.executeScript(`
    const el = document.querySelector('.aoProviderConfigCard.aoProviderConfigDragging');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  `)
}

async function main() {
  const msedgedriverPath = ensureMsEdgeDriver()
  const driversDir = path.dirname(msedgedriverPath)
  const msedgedriverLogPath = path.join(driversDir, 'msedgedriver.log')
  const msedgedriverWrapperPath = path.join(driversDir, 'msedgedriver-wrapper.cmd')

  // Wrap msedgedriver so we can keep logs on disk without spamming the terminal.
  fs.writeFileSync(
    msedgedriverWrapperPath,
    [
      '@echo off',
      'setlocal',
      `set LOG=${msedgedriverLogPath}`,
      `"${msedgedriverPath}" %* --log-path="%LOG%" >nul 2>&1`,
      'endlocal',
      '',
    ].join('\r\n'),
    'utf-8',
  )

  // Build debug binary (no bundles) for automation.
  const keepVisible = String(process.env.UI_TAURI_VISIBLE || '').trim() === '1'
  // In "background" mode we build release to avoid console spew from the debug WebView2 process.
  const buildMode = keepVisible ? 'debug' : 'release'
  console.log(`[ui:tauri] Building Tauri ${buildMode} binary (--no-bundle)...`)
  // Windows: npm entrypoint is npm.cmd.
  const npmArgs = ['run', 'tauri', '--', 'build', ...(buildMode === 'debug' ? ['--debug'] : []), '--no-bundle']
  if (keepVisible) {
    runOrThrow('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...npmArgs], { cwd: repoRoot })
  } else {
    runQuietOrThrow('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...npmArgs], { cwd: repoRoot })
  }

  const appPath = resolveTauriAppPath(buildMode)
  console.log(`[ui:tauri] App: ${appPath}`)

  const artifactsDir = path.join(repoRoot, 'user-data', 'ui-artifacts', 'tauri')
  ensureDir(artifactsDir)
  const screenshotPath = path.join(artifactsDir, `drag-border-${Date.now()}.png`)
  const fontBaselinePath = path.join(repoRoot, 'scripts', 'ui-baselines', 'font-baseline.json')
  const uiRuntimeRoot = path.join(repoRoot, 'user-data', 'ui-check-runtime')
  ensureDir(uiRuntimeRoot)
  pruneUiCheckRuntimeDirs(uiRuntimeRoot)
  const uiProfileDir = path.join(uiRuntimeRoot, String(Date.now()))
  ensureDir(uiProfileDir)

  const driverHost = '127.0.0.1'
  const driverPort = 4444

  // Default: run in a hidden Windows desktop so WebView2's console window never appears.
  const useHiddenDesktop = !keepVisible && String(process.env.UI_TAURI_HIDDEN_DESKTOP || '').trim() !== '0'

  const tauriDriverExe =
    process.platform === 'win32'
      ? runCapture('where.exe', ['tauri-driver'], { cwd: repoRoot }).split(/\r?\n/).find(Boolean)
      : 'tauri-driver'
  if (!tauriDriverExe) throw new Error('tauri-driver not found in PATH.')

  const tauriDriverArgs = ['--port', String(driverPort), '--native-port', '4445', '--native-driver', msedgedriverWrapperPath]

  const tauriDriver = useHiddenDesktop
    ? startHiddenDesktopProcess({
        exe: tauriDriverExe,
        args: tauriDriverArgs,
        cwd: repoRoot,
        keepVisible,
        env: { ...process.env, UI_TAURI: '1', UI_TAURI_PROFILE_DIR: uiProfileDir },
      })
    : spawn(tauriDriverExe, tauriDriverArgs, {
        cwd: repoRoot,
        windowsHide: !keepVisible,
        stdio: keepVisible ? 'inherit' : 'ignore',
        env: {
          ...process.env,
          UI_TAURI: keepVisible ? undefined : '1',
          UI_TAURI_PROFILE_DIR: uiProfileDir,
        },
      })

  let driver
  try {
    // Give tauri-driver time to start listening.
    if (useHiddenDesktop && !keepVisible) {
      let launcherOut = ''
      let launcherErr = ''
      try {
        if (tauriDriver.stdout) tauriDriver.stdout.on('data', (d) => (launcherOut += String(d)))
        if (tauriDriver.stderr) tauriDriver.stderr.on('data', (d) => (launcherErr += String(d)))
      } catch {}

      const ok = await waitForPort(driverHost, driverPort, 20000)
      if (!ok) {
        const tailOut = String(launcherOut).trim().slice(-1500)
        const tailErr = String(launcherErr).trim().slice(-1500)
        const extra = [tailOut && `stdout:\n${tailOut}`, tailErr && `stderr:\n${tailErr}`].filter(Boolean).join('\n')
        throw new Error(
          `Hidden desktop launcher failed to start tauri-driver on ${driverHost}:${driverPort}.${extra ? `\n${extra}` : ''}`,
        )
      }
    } else {
      await new Promise((r) => setTimeout(r, 1500))
    }

    driver = await new Builder()
      .usingServer(`http://${driverHost}:${driverPort}/`)
      .withCapabilities({
        // tauri-driver will map `tauri:options` to the native Edge WebView2 capabilities.
        // We keep `browserName` here for client compatibility; tauri-driver overwrites it.
        browserName: 'wry',
        'tauri:options': {
          application: appPath,
        },
      })
      .build()

    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 60000, script: 60000 })

    try {
      if (keepVisible) {
        // Make the window shorter to force scroll/clipping scenarios (best-effort).
        await driver.manage().window().setRect({ width: 1360, height: 820 })
      } else {
        // Push far off-screen. Keep a normal size so element coordinates stay in-bounds.
        // Some window managers clamp negative coords; try both directions.
        try {
          await driver.manage().window().setRect({ x: 100000, y: 100000, width: 1360, height: 820 })
        } catch {}
        try {
          await driver.manage().window().setRect({ x: -10000, y: -10000, width: 1360, height: 820 })
        } catch {}
      }
    } catch {}

    // === Subtest A: main page contracts and key modals ===
    {
      console.log('[ui:tauri] Subtest A: contracts start')
      const directProvider = await pickDirectProvider(driver)
      const bodyTextLen = Number(await driver.executeScript('return (document.body && document.body.innerText ? document.body.innerText.trim().length : 0)'))
      if (!Number.isFinite(bodyTextLen) || bodyTextLen < 40) {
        throw new Error(`UI appears blank (document body text length=${bodyTextLen})`)
      }

      await waitSectionHeading(driver, 'Providers', 45000)
      await waitSectionHeading(driver, 'Sessions')
      await waitVisible(driver, By.xpath(`//button[contains(@class,'aoTopNavBtn')][.//span[normalize-space()='Events']]`), 15000)

      console.log('[ui:tauri] Subtest A: getting started modal')
      await openModalAndCloseOptional(
        driver,
        'Getting Started',
        'Getting Started',
        'Close',
        'Getting Started modal check',
      )
      console.log('[ui:tauri] Subtest A: gateway token modal')
      await clickButtonByText(driver, 'Rotate', 15000)

      console.log('[ui:tauri] Subtest A: usage statistics page')
      await clickTopNav(driver, 'Analytics')
      await waitPageTitle(driver, 'Usage Statistics')
      await waitVisible(driver, By.xpath(`//div[contains(@class,'aoMiniLabel') and normalize-space()='Provider Statistics']`), 12000)
      await runProviderStatisticsKeyStyleCase(driver, screenshotPath)
      console.log('[ui:tauri] Subtest A1: usage history scroll contract')
      await seedHistoryRows(driver, directProvider, 44)
      await runUsageHistoryScrollCase(driver, screenshotPath)
      await openModalAndCloseOptional(driver, 'Base Pricing', 'Base Pricing', 'Close', 'Base Pricing modal check')
      await runPricingTimelineModalCase(driver, screenshotPath)
      console.log('[ui:tauri] Subtest A1b: event log calendar daily stats contract')
      await runEventLogCalendarDailyStatsCase(driver, directProvider, screenshotPath)

      console.log('[ui:tauri] Subtest A: provider switchboard page')
      await clickTopNav(driver, 'Provider Switchboard')
      await waitPageTitle(driver, 'Provider Switchboard')
      await waitVisible(driver, By.xpath(`//span[contains(@class,'aoSwitchQuickTitle') and normalize-space()='Gateway']`), 12000)
      await waitVisible(driver, By.xpath(`//span[contains(@class,'aoSwitchQuickTitle') and normalize-space()='Official']`), 12000)
      await waitVisible(driver, By.xpath(`//span[contains(@class,'aoSwitchQuickTitle') and normalize-space()='Direct Provider']`), 12000)
      await openModalAndClose(driver, 'Configure Dirs', 'Codex CLI directories', 'Cancel')
      console.log('[ui:tauri] Subtest A2: switchboard switch contract')
      await runSwitchboardSwitchCase(driver, directProvider, uiProfileDir)

      console.log('[ui:tauri] Subtest A: back to dashboard')
      await clickTopNav(driver, 'Dashboard')
      await waitSectionHeading(driver, 'Providers')
      console.log('[ui:tauri] Subtest A2b: top nav responsiveness contract')
      const topNavProbe = await runTopNavSwitchResponsivenessCase(driver, screenshotPath)
      console.log(
        `[ui:tauri] Top nav probe: stepLatencies=${topNavProbe.stepLatencies.map((v) => `${v.toFixed(1)}ms`).join(', ')} max=${topNavProbe.maxLatency.toFixed(1)}ms frameGap=${topNavProbe.maxFrameGap.toFixed(1)}ms`,
      )
      console.log('[ui:tauri] Subtest A2c: requests first paint stability')
      await runRequestsFirstPaintStabilityCase(driver, screenshotPath)
      await clickTopNav(driver, 'Dashboard')
      await waitSectionHeading(driver, 'Providers')
      console.log('[ui:tauri] Subtest A3: font baseline snapshot contract')
      await runFontBaselineCase(driver, fontBaselinePath, screenshotPath)
      console.log('[ui:tauri] Subtest A: contracts pass')
    }

    // Open Config modal.
    const configBtn = await driver.wait(until.elementLocated(By.css('button[aria-label="Config"]')), 45000)
    await driver.wait(until.elementIsVisible(configBtn), 10000)
    await configBtn.click()

    // Keep the list near the top so target cards stay within the viewport (avoids out-of-bounds moves).
    try {
      await driver.executeScript(`
        const body = document.querySelector('.aoModalBody');
        if (body) body.scrollTop = 0;
      `)
      await new Promise((r) => setTimeout(r, 150))
    } catch {}

    const list = await driver.wait(until.elementLocated(By.css('.aoProviderConfigList')), 20000)
    await driver.wait(until.elementIsVisible(list), 10000)

    const cards = await driver.findElements(By.css('.aoProviderConfigCard[data-provider]'))
    if (cards.length < 2) throw new Error(`Expected >=2 provider cards, got ${cards.length}`)

    // Subtest: Config modal action contracts (key / usage base modals).
    {
      const setKeyBtn = await waitVisible(driver, By.css('.aoProviderConfigCard[data-provider] button[title="Set key"]'), 12000)
      await setKeyBtn.click()
      await waitVisible(
        driver,
        By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Set API key']]`),
        12000,
      )
      await clickButtonByText(driver, 'Cancel', 12000)
      await driver.wait(
        async () => {
          const found = await driver.findElements(
            By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Set API key']]`),
          )
          return found.length === 0
        },
        10000,
        'Set API key modal should close after cancel',
      )

      const usageBaseBtn = await waitVisible(
        driver,
        By.xpath(`(//div[contains(@class,'aoProviderConfigCard') and @data-provider]//button[normalize-space()='Usage Base'])[1]`),
        12000,
      )
      await usageBaseBtn.click()
      await waitVisible(
        driver,
        By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Usage base URL']]`),
        12000,
      )
      await clickButtonByText(driver, 'Cancel', 12000)
      await driver.wait(
        async () => {
          const found = await driver.findElements(
            By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Usage base URL']]`),
          )
          return found.length === 0
        },
        10000,
        'Usage base URL modal should close after cancel',
      )
    }

    // === Subtest B: drag down one slot (highlight should be the card below) ===
    {
      const viewportH = Number(await driver.executeScript('return window.innerHeight'))
      const beforeOrder = await getProviderOrder(driver)
      const draggingName = beforeOrder[0]
      const belowName = beforeOrder[1]
      const draggingCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${draggingName}"]`))
      const belowCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${belowName}"]`))
      const handle = await draggingCard.findElement(By.css('button.aoDragHandle'))
      const rects = await getRects(driver, draggingCard, handle)
      const pointerDownY = centerY(rects.handle)
      const pointerDownX = centerX(rects.handle)
      const pointerOffset = pointerDownY - rects.card.top
      const belowRect = await driver.executeScript('const r = arguments[0].getBoundingClientRect(); return { top: r.top, height: r.height };', belowCard)
      const belowMid = belowRect.top + belowRect.height / 2

      const actions = driver.actions({ async: true })
      await actions
        .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
        .press()
        .pause(80)
        // Step 1: move to just touching the next card -> highlight should be the card below.
        .move({
          origin: 'viewport',
          x: Math.round(pointerDownX),
          y: Math.round(
            Math.max(
              2,
              Math.min(
                viewportH - 2,
                // Touch condition: dragBottom >= belowTop => (clientY - offset + h) >= belowTop
                // => clientY >= belowTop - h + offset
                (belowRect.top + 1 - rects.card.height) + pointerOffset,
              ),
            ),
          ),
        })
        .pause(220)
        .perform()

      const ph0 = await getPlaceholderIndex(driver)
      if (ph0 < 0) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-down-no-drag.png`), Buffer.from(b64, 'base64'))
        throw new Error('Drag-down: placeholder not found after press/move (drag did not start).')
      }

      const over = await getDragOverProvider(driver)
      if (over !== belowName) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-down-mismatch.png`), Buffer.from(b64, 'base64'))
        throw new Error(`Drag-down highlight mismatch: expected ${belowName}, got ${over} (dragging ${draggingName})`)
      }

      const phIdx = await getPlaceholderIndex(driver)
      if (phIdx < 0) throw new Error('Drag-down: placeholder not found (drag did not start?)')
      if (phIdx !== 0) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-down-bad-placeholder-before.png`), Buffer.from(b64, 'base64'))
        throw new Error(`Drag-down: expected placeholder index 0 before crossing, got ${phIdx}`)
      }

      // Step 2: move to just after crossing the midpoint -> reorder should trigger (placeholder leaves index 0).
      const belowRect2 = await driver.executeScript(
        'const r = arguments[0].getBoundingClientRect(); return { top: r.top, height: r.height };',
        belowCard,
      )
      const belowMid2 = belowRect2.top + belowRect2.height / 2
      const desiredY2Raw = (belowMid2 + 1 - rects.card.height * DRAG_PROBE_DOWN) + pointerOffset
      const desiredY2 = Math.max(2, Math.min(viewportH - 2, desiredY2Raw))
      await driver
        .actions({ async: true })
        .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(desiredY2) })
        .pause(240)
        .perform()

      const ph2 = await waitForPlaceholderIndex(driver, (idx) => idx > 0)
      if (ph2 <= 0) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-down-no-reorder.png`), Buffer.from(b64, 'base64'))
        throw new Error(`Drag-down: expected reorder after crossing midpoint, placeholder index=${ph2} (y=${Math.round(desiredY2)})`)
      }

      // Move back to original position so we don't persist a reorder into the next subtest.
      await driver
        .actions({ async: true })
        .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
        .pause(160)
        .perform()

      await driver.actions({ async: true }).release().perform()
      await new Promise((r) => setTimeout(r, 150))
    }

    // Refresh card references (DOM moved during drag).
    // Refresh order + references (DOM may have animated during the prior drag).
    const cards2 = await driver.findElements(By.css('.aoProviderConfigCard[data-provider]'))

    // === Subtest C: drag up one slot (highlight should be the card above) ===
    {
      const beforeOrder = await getProviderOrder(driver)
      if (beforeOrder.length < 2) {
        console.log('[ui:tauri] Subtest C skipped (need at least 2 provider cards after Subtest B).')
      } else {
      const viewportH = Number(await driver.executeScript('return window.innerHeight'))
      const draggingName = beforeOrder[1] ?? beforeOrder[beforeOrder.length - 1]
      const aboveName = beforeOrder[0]
      if (!draggingName || !aboveName || draggingName === aboveName) {
        console.log('[ui:tauri] Subtest C skipped (insufficient distinct cards for drag-up).')
      } else {
      const draggingCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${draggingName}"]`))
      const aboveCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${aboveName}"]`))
      const handle = await draggingCard.findElement(By.css('button.aoDragHandle'))
      const rects = await getRects(driver, draggingCard, handle)
      const pointerDownY = centerY(rects.handle)
      const pointerDownX = centerX(rects.handle)
      const pointerOffset = pointerDownY - rects.card.top
      const aboveRect = await driver.executeScript(
        'const r = arguments[0].getBoundingClientRect(); return { top: r.top, height: r.height };',
        aboveCard,
      )
      const aboveMid = aboveRect.top + aboveRect.height / 2

      const actions = driver.actions({ async: true })
      await actions
        .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
        .press()
        .pause(80)
        // Tiny nudge first to ensure drag state starts on all hosts.
        .move({
          origin: 'viewport',
          x: Math.round(pointerDownX),
          y: Math.round(Math.max(2, Math.min(viewportH - 2, pointerDownY - 3))),
        })
        .pause(120)
        // Step 1: just touching the card above -> highlight should be the card above.
        .move({
          origin: 'viewport',
          x: Math.round(pointerDownX),
          y: Math.round(
            Math.max(
              2,
              Math.min(
                viewportH - 2,
                // Touch condition: dragTop <= aboveBottom => (clientY - offset) <= aboveBottom
                // => clientY <= aboveBottom + offset
                (aboveRect.top + aboveRect.height - 1) + pointerOffset,
              ),
            ),
          ),
        })
        .pause(220)
        .perform()

      let ph0 = await waitForPlaceholderIndex(driver, (idx) => idx >= 0, 1200)
      if (ph0 < 0) {
        // Retry once with a tiny extra nudge to reliably trigger pointer drag on slower hosts.
        const retryY = Math.max(2, Math.min(viewportH - 2, Math.round(pointerDownY - 6)))
        await driver
          .actions({ async: true })
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: retryY })
          .pause(220)
          .perform()
        ph0 = await waitForPlaceholderIndex(driver, (idx) => idx >= 0, 1200)
      }
      if (ph0 < 0) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-up-no-drag.png`), Buffer.from(b64, 'base64'))
        warnOrFail('Subtest C degraded (drag did not start).')
        await driver.actions({ async: true }).release().perform()
        await new Promise((r) => setTimeout(r, 150))
      } else {
        const over = await getDragOverProvider(driver)
        if (over !== aboveName) {
          const ph = await getPlaceholderIndex(driver)
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-up-mismatch.png`), Buffer.from(b64, 'base64'))
          throw new Error(
            `Drag-up highlight mismatch: expected ${aboveName}, got ${over} (dragging ${draggingName}) order=${beforeOrder.join(
              ',',
            )} placeholderIdx=${ph}`,
          )
        }

        const phIdx = await getPlaceholderIndex(driver)
        if (phIdx < 0) throw new Error('Drag-up: placeholder not found (drag did not start?)')
        if (phIdx <= 0) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-up-bad-placeholder-before.png`), Buffer.from(b64, 'base64'))
          throw new Error(`Drag-up: expected placeholder index >= 1 before crossing, got ${phIdx}`)
        }

        // Step 2: cross above midpoint -> placeholder should move to index 0.
        const aboveRect2 = await driver.executeScript(
          'const r = arguments[0].getBoundingClientRect(); return { top: r.top, height: r.height };',
          aboveCard,
        )
        const aboveMid2 = aboveRect2.top + aboveRect2.height / 2
        const desiredY2Raw = (aboveMid2 - 1 - rects.card.height * DRAG_PROBE_UP) + pointerOffset
        const desiredY2 = Math.max(2, Math.min(viewportH - 2, desiredY2Raw))
        await driver
          .actions({ async: true })
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(desiredY2) })
          .pause(240)
          .perform()

        const ph2 = await waitForPlaceholderIndex(driver, (idx) => idx === 0)
        if (ph2 !== 0) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-up-no-reorder.png`), Buffer.from(b64, 'base64'))
          throw new Error(`Drag-up: expected reorder after crossing midpoint, placeholder index=${ph2} (y=${Math.round(desiredY2)})`)
        }

        // Keep one screenshot for artifact inspection.
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath, Buffer.from(b64, 'base64'))

        // Move back to original position so we don't persist a reorder into the release.
        await driver
          .actions({ async: true })
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
          .pause(160)
          .perform()

        await driver.actions({ async: true }).release().perform()
        await new Promise((r) => setTimeout(r, 150))
      }
      }
      }
    }

    // === Subtest D: drag while scrolling (overlay should stay pinned under cursor) ===
    {
      const scrollInfo = await driver.executeScript(`
        const body = document.querySelector('.aoModalBody');
        if (!body) return null;
        return { scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
      `)
      if (!scrollInfo || !(scrollInfo.scrollHeight > scrollInfo.clientHeight + 2)) {
        console.log('[ui:tauri] Subtest D skipped (modal body not scrollable).')
      } else {
        const viewportH = Number(await driver.executeScript('return window.innerHeight'))
        const beforeOrder = await getProviderOrder(driver)
        const draggingName = beforeOrder[0]
        const draggingCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${draggingName}"]`))
        const handle = await draggingCard.findElement(By.css('button.aoDragHandle'))
        const rects = await getRects(driver, draggingCard, handle)

        let pointerY = centerY(rects.handle)
        const pointerX = centerX(rects.handle)
        const pointerOffset = pointerY - rects.card.top

        // Start drag (press + a tiny move to ensure the drag overlay is rendered).
        await driver
          .actions({ async: true })
          .move({ origin: 'viewport', x: Math.round(pointerX), y: Math.round(pointerY) })
          .press()
          .pause(100)
          .move({ origin: 'viewport', x: Math.round(pointerX), y: Math.round(Math.min(viewportH - 2, pointerY + 2)) })
          .pause(200)
          .perform()

        pointerY = Math.min(viewportH - 2, pointerY + 2)

        const ph0 = await waitForPlaceholderIndex(driver, (idx) => idx >= 0, 1200)
        if (ph0 < 0) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-scroll-no-drag.png`), Buffer.from(b64, 'base64'))
          throw new Error('Drag-scroll: placeholder not found after press/move (drag did not start).')
        }

        const overlayBefore = await getOverlayRect(driver)
        if (!overlayBefore) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-scroll-no-overlay.png`), Buffer.from(b64, 'base64'))
          throw new Error('Drag-scroll: overlay not found (.aoProviderConfigDragging).')
        }

        // Scroll without moving the pointer. If the drag overlay isn't scroll-anchored, it will drift.
        await driver.executeScript(`
          const body = document.querySelector('.aoModalBody');
          if (!body) return;
          const next = Math.min(body.scrollHeight - body.clientHeight, body.scrollTop + 220);
          body.scrollTop = next;
        `)
        await new Promise((r) => setTimeout(r, 250))

        const overlayAfter = await getOverlayRect(driver)
        if (!overlayAfter) throw new Error('Drag-scroll: overlay disappeared after scroll.')

        const expectedTop = pointerY - pointerOffset
        const drift = Math.abs(overlayAfter.top - expectedTop)
        if (drift > 3.5) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-scroll-drift.png`), Buffer.from(b64, 'base64'))
          throw new Error(`Drag-scroll: overlay drift too large (drift=${drift.toFixed(2)}px, expectedTop=${expectedTop.toFixed(2)}, gotTop=${overlayAfter.top.toFixed(2)})`)
        }

        await driver.actions({ async: true }).release().perform()
        await new Promise((r) => setTimeout(r, 150))

        // Reset scroll so the final screenshot remains stable.
        await driver.executeScript(`
          const body = document.querySelector('.aoModalBody');
          if (body) body.scrollTop = 0;
        `)
        await new Promise((r) => setTimeout(r, 120))
      }
    }

    // === Subtest E: autoscroll up should not "snap" to top instantly ===
    {
      const info = await driver.executeScript(`
        const body = document.querySelector('.aoModalBody');
        if (!body) return null;
        return { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
      `)
      if (!info || !(info.scrollHeight > info.clientHeight + 2)) {
        console.log('[ui:tauri] Subtest E skipped (modal body not scrollable).')
      } else {
        // Put us somewhere in the middle so there is room to scroll up.
        const startTop = Number(
          await driver.executeScript(`
            const body = document.querySelector('.aoModalBody');
            const max = body.scrollHeight - body.clientHeight;
            body.scrollTop = Math.max(0, Math.min(max, Math.floor(max * 0.6)));
            return body.scrollTop;
          `),
        )
        await new Promise((r) => setTimeout(r, 150))

        const beforeOrder = await getProviderOrder(driver)
        const draggingName = beforeOrder[1] ?? beforeOrder[0]
        const draggingCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${draggingName}"]`))
        const handle = await draggingCard.findElement(By.css('button.aoDragHandle'))
        const rects = await getRects(driver, draggingCard, handle)
        const pointerDownY = centerY(rects.handle)
        const pointerDownX = centerX(rects.handle)

        // Move near the top edge to trigger upward autoscroll.
        const actions = driver.actions({ async: true })
        await actions
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
          .press()
          .pause(80)
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: 6 })
          .pause(180)
          .perform()

        const t1 = Number(
          await driver.executeScript(`
            const body = document.querySelector('.aoModalBody');
            return body ? body.scrollTop : -1;
          `),
        )
        // A snap-to-top would put scrollTop near 0 almost immediately.
        if (startTop > 60 && t1 >= 0 && t1 < 10) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-autoscroll-up-snap.png`), Buffer.from(b64, 'base64'))
          throw new Error(`Autoscroll-up snapped too fast (start=${startTop}, after180ms=${t1})`)
        }

        await driver.actions({ async: true }).release().perform()
        await new Promise((r) => setTimeout(r, 150))
      }
    }

    console.log(`[ui:tauri] Screenshot: ${screenshotPath}`)
    console.log('[ui:tauri] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    try {
      if (tauriDriver && tauriDriver.pid && process.platform === 'win32') {
        // Ensure the whole process tree is terminated (hidden desktop spawns).
        spawnSync('taskkill.exe', ['/PID', String(tauriDriver.pid), '/T', '/F'], {
          cwd: repoRoot,
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
      } else if (tauriDriver) {
        tauriDriver.kill()
      }
    } catch {}
    try {
      if (fs.existsSync(msedgedriverLogPath)) console.log(`[ui:tauri] EdgeDriver log: ${msedgedriverLogPath}`)
    } catch {}
    try {
      cleanupDirBestEffort(uiProfileDir)
    } catch {}
  }
}

main().catch((e) => {
  console.error(`[ui:tauri] FAIL: ${e?.stack || e}`)
  process.exitCode = 1
})
