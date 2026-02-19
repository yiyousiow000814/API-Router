import fs from 'node:fs'
import path from 'node:path'
import { By, until } from 'selenium-webdriver'
import { warnOrFail } from './runtime-utils.mjs'

export async function waitVisible(driver, locator, timeoutMs = 12000) {
  const el = await driver.wait(until.elementLocated(locator), timeoutMs)
  await driver.wait(until.elementIsVisible(el), timeoutMs)
  return el
}

export async function clickButtonByText(driver, label, timeoutMs = 12000) {
  try {
    const btn = await waitVisible(
      driver,
      By.xpath(`//button[@aria-label='${label}' or normalize-space()='${label}' or .//span[normalize-space()='${label}']]`),
      timeoutMs,
    )
    await btn.click()
    return btn
  } catch {
    const clicked = await driver.executeScript(
      `
        const want = arguments[0];
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const aria = (b.getAttribute('aria-label') || '').trim();
        if (aria === want && b.offsetParent !== null && !b.disabled) {
          b.click();
          return true;
        }
        const txt = (b.innerText || b.textContent || '').trim();
        if (txt === want && b.offsetParent !== null && !b.disabled) {
          b.click();
          return true;
        }
        }
        return false;
      `,
      label,
    )
    if (!clicked) throw new Error(`Button not found/clickable: ${label}`)
    return null
  }
}

export async function clickTopNav(driver, label) {
  const btn = await waitVisible(
    driver,
    By.xpath(`//button[contains(@class,'aoTopNavBtn')][.//span[normalize-space()='${label}']]`),
    15000,
  )
  await btn.click()
}

export async function waitPageTitle(driver, title, timeoutMs = 12000) {
  await waitVisible(driver, By.xpath(`//div[contains(@class,'aoPagePlaceholderTitle')][normalize-space()='${title}']`), timeoutMs)
}

export async function waitSectionHeading(driver, heading, timeoutMs = 12000) {
  await waitVisible(driver, By.xpath(`//h3[contains(@class,'aoH3') and normalize-space()='${heading}']`), timeoutMs)
}

export async function openModalAndClose(driver, triggerLabel, modalTitle, closeLabel) {
  await clickButtonByText(driver, triggerLabel, 15000)
  const modal = await waitVisible(
    driver,
    By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and (normalize-space()='${modalTitle}' or contains(normalize-space(),'${modalTitle}'))]]`),
    15000,
  )
  const closeBtn = await modal.findElement(By.xpath(`.//button[normalize-space()='${closeLabel}' or contains(normalize-space(),'${closeLabel}')]`))
  await closeBtn.click()
  await driver.wait(
    async () => {
      const found = await driver.findElements(
        By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and (normalize-space()='${modalTitle}' or contains(normalize-space(),'${modalTitle}'))]]`),
      )
      return found.length === 0
    },
    10000,
    `Modal "${modalTitle}" should close after clicking "${closeLabel}"`,
  )
}

export async function openModalAndCloseOptional(driver, triggerLabel, modalTitle, closeLabel, label) {
  try {
    await openModalAndClose(driver, triggerLabel, modalTitle, closeLabel)
    return true
  } catch (e) {
    warnOrFail(`${label} degraded: ${String(e?.message || e)}`)
    return false
  }
}

export function dayKeyFromOffset(daysAgo) {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function normalizeText(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parsePx(value) {
  const n = Number.parseFloat(String(value ?? '').replace('px', '').trim())
  return Number.isFinite(n) ? n : null
}

export function assertPxClose(actual, expected, tolerance, label) {
  const a = parsePx(actual)
  const e = parsePx(expected)
  if (a == null || e == null || Math.abs(a - e) > tolerance) {
    throw new Error(`Font baseline mismatch (${label}): expected ${expected}, got ${actual}`)
  }
}

export async function tauriInvoke(driver, cmd, args = {}) {
  const out = await driver.executeAsyncScript(
    `
      const command = arguments[0];
      const payload = arguments[1] || {};
      const done = arguments[arguments.length - 1];
      (async () => {
        try {
          const invokeFn =
            (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
            (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
          if (typeof invokeFn !== 'function') {
            throw new Error('tauri invoke unavailable in window globals');
          }
          const res = await invokeFn(command, payload);
          done({ ok: true, res });
        } catch (e) {
          done({ ok: false, err: String(e && (e.message || e)) });
        }
      })();
    `,
    cmd,
    args,
  )
  if (!out || !out.ok) {
    throw new Error(`tauri invoke failed: ${cmd} (${out && out.err ? out.err : 'unknown error'})`)
  }
  return out.res
}

export async function pickDirectProvider(driver) {
  const cfg = await tauriInvoke(driver, 'get_config', {})
  const names = Object.keys((cfg && cfg.providers) || {})
  const nonOfficial = names.find((name) => name !== 'official')
  return nonOfficial || names[0] || 'official'
}

export async function seedHistoryRows(driver, provider, rowCount = 40) {
  for (let i = 0; i < rowCount; i++) {
    const dayKey = dayKeyFromOffset(i)
    await tauriInvoke(driver, 'set_spend_history_entry', {
      provider,
      dayKey,
      totalUsedUsd: 1 + (i % 7) * 0.13,
      usdPerReq: 0.01 + (i % 5) * 0.002,
    })
  }
}

export async function ensureCodexAuthForSwitchboard(uiProfileDir) {
  const appAuthPath = path.join(uiProfileDir, 'codex-home', 'auth.json')
  fs.mkdirSync(path.dirname(appAuthPath), { recursive: true })
  let current = {}
  if (fs.existsSync(appAuthPath)) {
    try {
      current = JSON.parse(fs.readFileSync(appAuthPath, 'utf-8'))
    } catch {}
  }
  const next = {
    ...current,
    OPENAI_API_KEY: current?.OPENAI_API_KEY || 'sk-ui-check-auth',
    tokens:
      current?.tokens && typeof current.tokens === 'object' && Object.keys(current.tokens).length
        ? current.tokens
        : { ui_check: 'token' },
  }
  fs.writeFileSync(appAuthPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
}

export async function runUsageHistoryScrollCase(driver, screenshotPath) {
  await clickButtonByText(driver, 'Daily History', 12000)
  const modal = await waitVisible(
    driver,
    By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Daily History']]`),
    15000,
  )
  await waitVisible(driver, By.css('.aoUsageHistoryTableWrap'), 12000)

  const scrollState = await driver.executeScript(`
    const wrap = document.querySelector('.aoUsageHistoryTableWrap');
    const head = document.querySelector('.aoUsageHistoryTableHead');
    const rows = document.querySelectorAll('.aoUsageHistoryTableBody tbody tr').length;
    if (!wrap || !head) return null;
    return {
      rows,
      maxScroll: Math.max(0, wrap.scrollHeight - wrap.clientHeight),
      wrapTop: wrap.getBoundingClientRect().top,
      headTop: head.getBoundingClientRect().top
    };
  `)
  if (!scrollState) throw new Error('Daily History elements missing.')
  if (scrollState.rows < 20) throw new Error(`Daily History rows too few for scroll test: ${scrollState.rows}`)
  if (!(scrollState.maxScroll > 40)) throw new Error('Daily History list is not scrollable after seeding.')

  await driver.executeScript(`
    const wrap = document.querySelector('.aoUsageHistoryTableWrap');
    if (!wrap) return;
    const next = Math.floor((wrap.scrollHeight - wrap.clientHeight) * 0.58);
    wrap.scrollTop = Math.max(0, next);
    wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
  `)
  await new Promise((r) => setTimeout(r, 120))

  const afterScroll = await driver.executeScript(`
    const wrap = document.querySelector('.aoUsageHistoryTableWrap');
    const head = document.querySelector('.aoUsageHistoryTableHead');
    const overlay = document.querySelector('.aoUsageHistoryScrollbarOverlay');
    if (!wrap || !head || !overlay) return null;
    return {
      scrollTop: wrap.scrollTop,
      headTop: head.getBoundingClientRect().top,
      overlayVisible: overlay.classList.contains('aoUsageHistoryScrollbarOverlayVisible')
    };
  `)
  if (!afterScroll) throw new Error('Daily History scroll state unavailable after scroll.')
  if (!(afterScroll.scrollTop > 0)) throw new Error('Daily History did not scroll.')
  if (Math.abs(afterScroll.headTop - scrollState.headTop) > 1.5) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-history-head-drift.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Daily History header drifted while body scrolled (before=${scrollState.headTop}, after=${afterScroll.headTop})`)
  }
  if (!afterScroll.overlayVisible) {
    throw new Error('Daily History overlay scrollbar did not show during scroll.')
  }

  await driver.actions({ async: true }).move({ origin: 'viewport', x: 24, y: 24 }).perform()
  await new Promise((r) => setTimeout(r, 1350))
  const overlayLater = await driver.executeScript(`
    const overlay = document.querySelector('.aoUsageHistoryScrollbarOverlay');
    return overlay ? overlay.classList.contains('aoUsageHistoryScrollbarOverlayVisible') : null;
  `)
  if (overlayLater !== false) throw new Error('Daily History overlay scrollbar did not auto-hide.')

  const closeBtn = await modal.findElement(By.xpath(`.//button[normalize-space()='Close']`))
  await closeBtn.click()
  await driver.wait(
    async () => {
      const found = await driver.findElements(
        By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Daily History']]`),
      )
      return found.length === 0
    },
    10000,
    'Daily History modal should close after scroll contract check',
  )
}

export async function runEventLogCalendarDailyStatsCase(driver, directProvider, screenshotPath) {
  const markerKey = `sk-ui-check-event-${Date.now()}`
  await tauriInvoke(driver, 'set_provider_key', { provider: directProvider, key: markerKey })
  const today = dayKeyFromOffset(0)

  await clickTopNav(driver, 'Dashboard')
  await waitSectionHeading(driver, 'Providers', 15000)
  await clickTopNav(driver, 'Event Log')
  await waitSectionHeading(driver, 'Event Log', 20000)

  const daily = await tauriInvoke(driver, 'get_event_log_daily_stats')
  const todayStat = Array.isArray(daily) ? daily.find((row) => String(row?.day || '') === today) : null
  const total = Number(todayStat?.total || 0)
  if (!todayStat || !(total > 0)) {
    throw new Error(`Event Log daily stats missing today ${today} after emitting test event.`)
  }

  const fromDateBtn = await waitVisible(driver, By.css('.aoEventLogDateTrigger'), 12000)
  await fromDateBtn.click()
  await waitVisible(driver, By.css('.aoEventLogDatePopover'), 12000)

  const check = await driver.executeScript(`
    const cell = document.querySelector('.aoEventLogDatePopover .aoEventLogDateCell.is-today');
    if (!cell) return { found: false, dotCount: 0 };
    return { found: true, dotCount: cell.querySelectorAll('.aoEventLogDateDot').length };
  `)
  if (!check || !check.found || !(Number(check.dotCount) > 0)) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-event-log-calendar-dot-missing.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Event Log today cell has no dot after daily stats update (today=${today}).`)
  }

  await clickButtonByText(driver, 'OK', 12000)
}

export async function runProviderStatisticsKeyStyleCase(driver, screenshotPath) {
  const showButtons = await driver.findElements(
    By.xpath(`//button[contains(@class,'aoTinyBtn') and normalize-space()='Show']`),
  )
  if (showButtons.length > 0) {
    await showButtons[0].click()
    await driver.wait(
      async () => {
        const detailRows = await driver.findElements(By.css('.aoUsageProviderDetailName .aoUsageProviderDetailKey'))
        if (detailRows.length > 0) return true
        const hideButtons = await driver.findElements(
          By.xpath(`//button[contains(@class,'aoTinyBtn') and normalize-space()='Hide']`),
        )
        return hideButtons.length > 0
      },
      4000,
      'Provider Statistics did not switch to details mode after clicking Show',
    )
  }

  const hasProviderRows = await driver.executeScript(`
    const rows = document.querySelectorAll('.aoUsageProviderTable tbody tr');
    return rows.length > 0;
  `)

  const probe = await driver.executeScript(`
    const keyCell = document.querySelector('.aoUsageProviderDetailName .aoUsageProviderDetailKey');
    if (!keyCell) return null;
    const cs = window.getComputedStyle(keyCell);
    return { text: keyCell.textContent || '', weight: cs.fontWeight || '' };
  `)
  if (!probe) {
    if (hasProviderRows) {
      const b64 = await driver.takeScreenshot()
      fs.writeFileSync(screenshotPath.replace('.png', '-provider-key-missing.png'), Buffer.from(b64, 'base64'))
      throw new Error('Provider Statistics has data but detail key row is missing.')
    }
    return
  }
  const weight = Number.parseInt(String(probe.weight), 10)
  if (Number.isFinite(weight) && weight >= 600) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-provider-key-bold.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Provider Statistics key should not be bold (weight=${probe.weight}, text="${probe.text}").`)
  }
}

export async function runPricingTimelineModalCase(driver, screenshotPath) {
  await clickButtonByText(driver, 'Pricing Timeline', 12000)
  const modal = await waitVisible(
    driver,
    By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Pricing Timeline']]`),
    15000,
  )
  const probe = await driver.executeScript(
    `
      const root = arguments[0];
      const table = root.querySelector('.aoUsageScheduleTable');
      const headers = table ? Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim()) : [];
      const addBtn = root.querySelector('button');
      if (!table) return null;
      const cs = window.getComputedStyle(table);
      return {
        headers,
        tableLayout: cs.tableLayout || '',
        borderRadius: cs.borderTopLeftRadius || '',
        addText: addBtn ? (addBtn.textContent || '').trim() : '',
      };
    `,
    modal,
  )
  if (!probe) {
    throw new Error('Pricing Timeline table not found (.aoUsageScheduleTable).')
  }
  const expectedHeaders = ['Provider', 'API Key', 'Mode', 'Start', 'Expires', 'Amount', 'Currency', 'Action']
  if (probe.headers.length !== expectedHeaders.length) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-pricing-timeline-missing-headers.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Pricing Timeline header count mismatch: expected ${expectedHeaders.length}, got ${probe.headers.length}.`)
  }
  const headerOk = expectedHeaders.every((name, idx) => normalizeText(probe.headers[idx]) === name)
  if (!headerOk) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-pricing-timeline-header-text.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Pricing Timeline headers mismatch: ${JSON.stringify(probe.headers)}`)
  }
  if (normalizeText(probe.tableLayout) !== 'fixed') {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-pricing-timeline-style.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Pricing Timeline table layout should be fixed, got "${probe.tableLayout}".`)
  }
  if (!(parsePx(probe.borderRadius) > 0)) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-pricing-timeline-radius.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Pricing Timeline table border radius missing (got "${probe.borderRadius}").`)
  }
  await clickButtonByText(driver, 'Close', 12000)
  await driver.wait(
    async () => {
      const found = await driver.findElements(
        By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Pricing Timeline']]`),
      )
      return found.length === 0
    },
    10000,
    'Pricing Timeline modal should close after clicking Close',
  )
}

export async function runSwitchboardSwitchCase(driver, directProvider, uiProfileDir) {
  await ensureCodexAuthForSwitchboard(uiProfileDir)
  const cfg = await tauriInvoke(driver, 'get_config', {})
  const providerCfg = cfg?.providers?.[directProvider]
  if (!providerCfg || !String(providerCfg.base_url || '').trim()) {
    await tauriInvoke(driver, 'upsert_provider', {
      name: directProvider,
      displayName: String(providerCfg?.display_name || directProvider),
      baseUrl: 'https://example.com/v1',
    })
  }
  await tauriInvoke(driver, 'set_provider_key', { provider: directProvider, key: 'sk-ui-check-direct-provider-key' })

  await clickTopNav(driver, 'Provider Switchboard')
  await waitPageTitle(driver, 'Provider Switchboard')
  const cliHomes = await driver.executeScript(`
    const raw = (document.querySelector('.aoSwitchMetaDirs')?.textContent || '').trim();
    if (!raw || raw === '-') return null;
    const homes = raw
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    return homes.length ? homes : null;
  `)
  const statusProvider = await tauriInvoke(driver, 'provider_switchboard_set_target', {
    cliHomes,
    target: 'provider',
    provider: directProvider,
  })
  if (!statusProvider || String(statusProvider?.mode || '').trim() === '') {
    throw new Error('Switchboard provider target did not return status.')
  }

  const statusGateway = await tauriInvoke(driver, 'provider_switchboard_set_target', {
    cliHomes,
    target: 'gateway',
    provider: null,
  })
  if (String(statusGateway?.mode || '').toLowerCase() !== 'gateway') {
    throw new Error(`Switchboard gateway target failed, got mode=${statusGateway?.mode ?? 'unknown'}`)
  }
}

export async function runFontBaselineCase(driver, baselinePath, screenshotPath) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))
  const checks = Array.isArray(baseline?.checks) ? baseline.checks : []
  if (!checks.length) throw new Error(`Font baseline has no checks: ${baselinePath}`)

  for (const check of checks) {
    const shot = await driver.executeScript(
      `
        const cfg = arguments[0];
        const selector = cfg.selector;
        const expectedText = cfg.text ? String(cfg.text).trim() : '';
        const nodes = Array.from(document.querySelectorAll(selector));
        let target = nodes[0] || null;
        if (expectedText) {
          target = nodes.find((n) => ((n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim()) === expectedText) || target;
        }
        if (!target) return { missing: true };
        const cs = getComputedStyle(target);
        return {
          missing: false,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          letterSpacing: cs.letterSpacing
        };
      `,
      check,
    )

    if (!shot || shot.missing) {
      const b64 = await driver.takeScreenshot()
      fs.writeFileSync(screenshotPath.replace('.png', `-font-missing-${check.name}.png`), Buffer.from(b64, 'base64'))
      throw new Error(`Font baseline target missing: ${check.name} (${check.selector})`)
    }

    const expect = check.expect || {}
    if (expect.fontSize) assertPxClose(shot.fontSize, expect.fontSize, 0.15, `${check.name}.fontSize`)
    if (expect.letterSpacing) assertPxClose(shot.letterSpacing, expect.letterSpacing, 0.2, `${check.name}.letterSpacing`)
    if (expect.fontWeight && String(shot.fontWeight) !== String(expect.fontWeight)) {
      throw new Error(`Font baseline mismatch (${check.name}.fontWeight): expected ${expect.fontWeight}, got ${shot.fontWeight}`)
    }
    if (Array.isArray(expect.fontFamilyIncludesAny) && expect.fontFamilyIncludesAny.length) {
      const actual = String(shot.fontFamily || '')
      const matched = expect.fontFamilyIncludesAny.some((needle) => actual.includes(String(needle)))
      if (!matched) {
        throw new Error(
          `Font baseline mismatch (${check.name}.fontFamily): expected contains one of "${expect.fontFamilyIncludesAny.join(', ')}", got "${actual}"`,
        )
      }
    } else if (expect.fontFamilyIncludes) {
      const actual = String(shot.fontFamily || '')
      if (!actual.includes(expect.fontFamilyIncludes)) {
        throw new Error(
          `Font baseline mismatch (${check.name}.fontFamily): expected contains "${expect.fontFamilyIncludes}", got "${actual}"`,
        )
      }
    }
  }
}

export function centerY(r) {
  return r.top + r.height / 2
}

export function centerX(r) {
  return r.left + r.width / 2
}
