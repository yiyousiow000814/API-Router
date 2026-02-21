import fs from 'node:fs'
import path from 'node:path'
import { By, until } from 'selenium-webdriver'
import { warnOrFail } from './runtime-utils.mjs'

const TOP_NAV_MAX_STEP_LATENCY_MS = 10

export async function waitVisible(driver, locator, timeoutMs = 12000) {
  try {
    const el = await driver.wait(until.elementLocated(locator), timeoutMs)
    await driver.wait(until.elementIsVisible(el), timeoutMs)
    return el
  } catch (error) {
    const detail = locator?.toString ? locator.toString() : String(locator)
    throw new Error(`waitVisible timeout for locator: ${detail} (${String(error?.message || error)})`)
  }
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

export async function waitTopNavLabel(driver, label, timeoutMs = 12000) {
  await waitVisible(
    driver,
    By.xpath(`//button[contains(@class,'aoTopNavBtn')][.//span[normalize-space()='${label}']]`),
    timeoutMs,
  )
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

function ensureUiCheckCliHome(uiProfileDir) {
  const cliHome = path.join(uiProfileDir, 'ui-check', '.codex')
  fs.mkdirSync(cliHome, { recursive: true })

  const authPath = path.join(cliHome, 'auth.json')
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({ OPENAI_API_KEY: 'sk-ui-check-cli-home' }, null, 2)}\n`,
    'utf-8',
  )

  const cfgPath = path.join(cliHome, 'config.toml')
  const cfg = [
    'model = "gpt-5"',
    '',
    '[model_providers.openai]',
    'name = "openai"',
    'base_url = "https://api.openai.com/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\n')
  fs.writeFileSync(cfgPath, cfg, 'utf-8')

  return cliHome
}

function normalizeCliPath(input) {
  return path.win32.normalize(String(input || '').trim()).toLowerCase()
}

async function applyUiCheckCliHomeInConfigureDirs(driver, cliHome) {
  await clickButtonByText(driver, 'Configure Dirs', 12000)
  await waitVisible(
    driver,
    By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Codex CLI directories']]`),
    12000,
  )
  const applied = await driver.executeScript(
    `
      const target = arguments[0];
      const modals = Array.from(document.querySelectorAll('.aoModal'));
      const modal = modals.find((m) => {
        const t = m.querySelector('.aoModalTitle');
        return t && (t.textContent || '').trim() === 'Codex CLI directories';
      });
      if (!modal) return { ok: false, reason: 'modal_not_found' };
      const cardByLabel = (label) =>
        Array.from(modal.querySelectorAll('.aoCardInset')).find((card) => {
          const mini = card.querySelector('.aoMiniLabel');
          return mini && (mini.textContent || '').trim() === label;
        });
      const windowsCard = cardByLabel('Windows');
      const wslCard = cardByLabel('WSL2');
      if (!windowsCard) return { ok: false, reason: 'windows_card_not_found' };
      if (!wslCard) return { ok: false, reason: 'wsl_card_not_found' };
      const windowsCheck = windowsCard.querySelector('input[type="checkbox"]');
      const wslCheck = wslCard.querySelector('input[type="checkbox"]');
      const windowsInput = windowsCard.querySelector('input.aoInput');
      const wslInput = wslCard.querySelector('input.aoInput');
      if (!windowsCheck) return { ok: false, reason: 'windows_checkbox_not_found' };
      if (!wslCheck) return { ok: false, reason: 'wsl_checkbox_not_found' };
      if (!windowsInput) return { ok: false, reason: 'windows_input_not_found' };
      if (!wslInput) return { ok: false, reason: 'wsl_input_not_found' };
      const setVal = (el, value) => {
        if (!el) return;
        const desc =
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value') ||
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc && typeof desc.set === 'function') {
          desc.set.call(el, value);
        } else {
          el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(windowsInput, target);
      setVal(wslInput, '');
      return { ok: true, windowsChecked: windowsCheck.checked, windowsDisabled: windowsCheck.disabled };
    `,
    cliHome,
  )
  if (!applied?.ok) {
    throw new Error(`Failed to apply ui check cli home in Codex CLI directories modal: ${applied?.reason || 'unknown'}`)
  }
  await driver.wait(
    async () => {
      const state = await driver.executeScript(`
        const modals = Array.from(document.querySelectorAll('.aoModal'));
        const modal = modals.find((m) => {
          const t = m.querySelector('.aoModalTitle');
          return t && (t.textContent || '').trim() === 'Codex CLI directories';
        });
        if (!modal) return { ok: false };
        const windowsCard = Array.from(modal.querySelectorAll('.aoCardInset')).find((card) => {
          const mini = card.querySelector('.aoMiniLabel');
          return mini && (mini.textContent || '').trim() === 'Windows';
        });
        const wslCard = Array.from(modal.querySelectorAll('.aoCardInset')).find((card) => {
          const mini = card.querySelector('.aoMiniLabel');
          return mini && (mini.textContent || '').trim() === 'WSL2';
        });
        const windowsCheck = windowsCard ? windowsCard.querySelector('input[type="checkbox"]') : null;
        const wslCheck = wslCard ? wslCard.querySelector('input[type="checkbox"]') : null;
        if (!windowsCheck || !wslCheck) return { ok: false };
        return { ok: true, ready: windowsCheck.disabled === false };
      `)
      return state?.ok === true && state?.ready === true
    },
    10000,
    'Codex CLI directories modal should enable Windows target checkbox',
  )
  const targetState = await driver.executeScript(`
    const modals = Array.from(document.querySelectorAll('.aoModal'));
    const modal = modals.find((m) => {
      const t = m.querySelector('.aoModalTitle');
      return t && (t.textContent || '').trim() === 'Codex CLI directories';
    });
    if (!modal) return { ok: false, reason: 'modal_not_found' };
    const cardByLabel = (label) =>
      Array.from(modal.querySelectorAll('.aoCardInset')).find((card) => {
        const mini = card.querySelector('.aoMiniLabel');
        return mini && (mini.textContent || '').trim() === label;
      });
    const windowsCard = cardByLabel('Windows');
    const wslCard = cardByLabel('WSL2');
    const windowsCheck = windowsCard ? windowsCard.querySelector('input[type="checkbox"]') : null;
    const wslCheck = wslCard ? wslCard.querySelector('input[type="checkbox"]') : null;
    if (!windowsCheck) return { ok: false, reason: 'windows_checkbox_not_found' };
    if (!wslCheck) return { ok: false, reason: 'wsl_checkbox_not_found' };
    if (windowsCheck.disabled) return { ok: false, reason: 'windows_checkbox_disabled' };
    if (!windowsCheck.checked) windowsCheck.click();
    if (wslCheck.checked) wslCheck.click();
    return { ok: true };
  `)
  if (!targetState?.ok) {
    throw new Error(`Failed to set Windows-only target state in Codex CLI directories modal: ${targetState?.reason || 'unknown'}`)
  }
  await driver.wait(
    async () => {
      const state = await driver.executeScript(`
        const modals = Array.from(document.querySelectorAll('.aoModal'));
        const modal = modals.find((m) => {
          const t = m.querySelector('.aoModalTitle');
          return t && (t.textContent || '').trim() === 'Codex CLI directories';
        });
        if (!modal) return { ok: false };
        const cardByLabel = (label) =>
          Array.from(modal.querySelectorAll('.aoCardInset')).find((card) => {
            const mini = card.querySelector('.aoMiniLabel');
            return mini && (mini.textContent || '').trim() === label;
          });
        const windowsCard = cardByLabel('Windows');
        const wslCard = cardByLabel('WSL2');
        const windowsCheck = windowsCard ? windowsCard.querySelector('input[type="checkbox"]') : null;
        const wslCheck = wslCard ? wslCard.querySelector('input[type="checkbox"]') : null;
        if (!windowsCheck || !wslCheck) return { ok: false };
        return { ok: true, ready: windowsCheck.checked === true && wslCheck.checked === false };
      `)
      return state?.ok === true && state?.ready === true
    },
    10000,
    'Codex CLI directories modal should apply Windows-only target state',
  )
  await clickButtonByText(driver, 'Apply', 12000)
  await driver.wait(
    async () => {
      const found = await driver.findElements(
        By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Codex CLI directories']]`),
      )
      return found.length === 0
    },
    10000,
    'Codex CLI directories modal should close after Apply',
  )
}

export async function runUsageHistoryScrollCase(driver, screenshotPath) {
  await clickButtonByText(driver, 'Daily History', 12000)
  const modal = await waitVisible(
    driver,
    By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Daily History']]`),
    15000,
  )
  await driver.wait(
    async () => {
      const state = await driver.executeScript(`
        const root = arguments[0];
        const wrap = root ? root.querySelector('.aoUsageHistoryTableWrap') : null;
        const hint = root ? root.querySelector('.aoUsageHistoryHint') : null;
        return {
          hasWrap: Boolean(wrap),
          loadingText: hint ? (hint.textContent || '').toLowerCase() : '',
        };
      `, modal)
      if (state?.hasWrap) return true
      if (String(state?.loadingText || '').includes('loading')) return false
      return false
    },
    30000,
    'Daily History table did not become ready in time',
  )
  const wrapEl = await modal.findElement(By.css('.aoUsageHistoryTableWrap'))
  await driver.wait(until.elementIsVisible(wrapEl), 12000)

  const scrollState = await driver.executeScript(`
    const root = arguments[0];
    const wrap = root ? root.querySelector('.aoUsageHistoryTableWrap') : null;
    const head = root ? root.querySelector('.aoUsageHistoryTableHead') : null;
    const rows = root ? root.querySelectorAll('.aoUsageHistoryTableBody tbody tr').length : 0;
    if (!wrap || !head) return null;
    return {
      rows,
      maxScroll: Math.max(0, wrap.scrollHeight - wrap.clientHeight),
      wrapTop: wrap.getBoundingClientRect().top,
      headTop: head.getBoundingClientRect().top
    };
  `, modal)
  if (!scrollState) throw new Error('Daily History elements missing.')
  if (scrollState.rows < 20) throw new Error(`Daily History rows too few for scroll test: ${scrollState.rows}`)
  if (!(scrollState.maxScroll > 40)) throw new Error('Daily History list is not scrollable after seeding.')

  await driver.executeScript(`
    const root = arguments[0];
    const wrap = root ? root.querySelector('.aoUsageHistoryTableWrap') : null;
    if (!wrap) return;
    const next = Math.floor((wrap.scrollHeight - wrap.clientHeight) * 0.58);
    wrap.scrollTop = Math.max(0, next);
    wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
  `, modal)
  await new Promise((r) => setTimeout(r, 120))

  const afterScroll = await driver.executeScript(`
    const root = arguments[0];
    const wrap = root ? root.querySelector('.aoUsageHistoryTableWrap') : null;
    const head = root ? root.querySelector('.aoUsageHistoryTableHead') : null;
    const overlay = root ? root.querySelector('.aoUsageHistoryScrollbarOverlay') : null;
    if (!wrap || !head || !overlay) return null;
    return {
      scrollTop: wrap.scrollTop,
      headTop: head.getBoundingClientRect().top,
      overlayVisible: overlay.classList.contains('aoUsageHistoryScrollbarOverlayVisible')
    };
  `, modal)
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
    const root = arguments[0];
    const overlay = root ? root.querySelector('.aoUsageHistoryScrollbarOverlay') : null;
    return overlay ? overlay.classList.contains('aoUsageHistoryScrollbarOverlayVisible') : null;
  `, modal)
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
  await clickTopNav(driver, 'Events')
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

export async function runDashboardViewJumpFocusStabilityCase(driver, screenshotPath) {
  await clickTopNav(driver, 'Dashboard')
  await waitSectionHeading(driver, 'Providers', 15000)

  const allRows = await tauriInvoke(driver, 'get_event_log_entries', {
    fromUnixMs: null,
    toUnixMs: null,
    limit: 2000,
  })
  const sortedRows = Array.isArray(allRows) ? [...allRows].sort((a, b) => Number(b?.unix_ms || 0) - Number(a?.unix_ms || 0)) : []
  const candidate = sortedRows.slice(0, 200).find((row) => row?.level === 'error') || sortedRows.find((row) => row?.level === 'error')
  if (!candidate) {
    warnOrFail('Dashboard view jump focus test skipped: no error row in event log entries.')
    return { skipped: true }
  }

  const jumped = await driver.executeScript(`
    const payload = arguments[0];
    const hook = window.__ui_check__;
    if (!hook || typeof hook.jumpToEventLogError !== 'function') return false;
    return Boolean(hook.jumpToEventLogError(payload));
  `, {
    provider: String(candidate.provider || ''),
    unixMs: Number(candidate.unix_ms || 0),
    message: String(candidate.message || ''),
  })
  if (!jumped) {
    warnOrFail('Dashboard view jump focus test skipped: ui-check hook did not find an error event.')
    return { skipped: true }
  }
  await waitSectionHeading(driver, 'Event Log', 20000)
  await waitVisible(driver, By.css('.aoEventsTableWrap'), 12000)

  const directProvider = await pickDirectProvider(driver)

  const probe = await driver.executeAsyncScript(`
    const provider = arguments[0];
    const done = arguments[arguments.length - 1];
    const minFlashMs = 900;
    const timeoutMs = 4500;
    const start = performance.now();
    let seenAt = null;
    let endedAt = null;
    let updatesStarted = false;

    const invokeFn =
      (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
      (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
    const emitUpdates = async () => {
      if (typeof invokeFn !== 'function') return;
      for (let i = 0; i < 3; i += 1) {
        try {
          await invokeFn('set_provider_key', {
            provider,
            key: 'sk-ui-check-focus-refresh-' + Date.now() + '-' + i,
          });
        } catch {}
        await new Promise((r) => setTimeout(r, 120));
      }
    };

    const loop = (ts) => {
      const active = document.querySelector('tr.aoEventRowFocusFlash');
      if (active && seenAt == null) seenAt = ts;
      if (active && !updatesStarted) {
        updatesStarted = true;
        void emitUpdates();
      }
      if (!active && seenAt != null && endedAt == null) endedAt = ts;

      if (seenAt != null && ts - seenAt >= minFlashMs) {
        done({
          ok: Boolean(active),
          seenAt,
          endedAt,
          elapsed: ts - seenAt,
        });
        return;
      }

      if (ts - start >= timeoutMs) {
        done({
          ok: false,
          seenAt,
          endedAt,
          timeout: true,
        });
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  `, directProvider)

  if (!probe?.ok) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-dashboard-view-focus-interrupted.png'), Buffer.from(b64, 'base64'))
    const detail = JSON.stringify(probe || {})
    throw new Error(`Dashboard->Events focus flash interrupted or missing: ${detail}`)
  }

  return probe
}

export async function runEventLogScrollAnchorStabilityCase(driver, screenshotPath, directProvider) {
  await clickTopNav(driver, 'Events')
  await waitSectionHeading(driver, 'Event Log', 20000)
  await waitVisible(driver, By.css('.aoEventsTableWrap'), 12000)

  const before = await driver.executeScript(`
    const wrap = document.querySelector('.aoEventsTableWrap');
    if (!wrap) return null;
    const maxScroll = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    wrap.scrollTop = Math.floor(maxScroll * 0.45);
    const wrapRect = wrap.getBoundingClientRect();
    const rows = Array.from(wrap.querySelectorAll('tbody tr'));
    const firstVisible = rows.find((row) => row.getBoundingClientRect().bottom > wrapRect.top + 1) || null;
    if (!firstVisible) return null;
    return {
      key: (firstVisible.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
      top: firstVisible.getBoundingClientRect().top - wrapRect.top,
      scrollTop: wrap.scrollTop,
    };
  `)
  if (!before?.key) {
    warnOrFail('Event log scroll anchor test skipped: no visible row found.')
    return { skipped: true }
  }

  for (let i = 0; i < 4; i += 1) {
    await tauriInvoke(driver, 'set_provider_key', {
      provider: directProvider,
      key: `sk-ui-check-scroll-anchor-${Date.now()}-${i}`,
    })
    await new Promise((r) => setTimeout(r, 180))
  }
  await new Promise((r) => setTimeout(r, 220))

  const after = await driver.executeScript(`
    const wrap = document.querySelector('.aoEventsTableWrap');
    if (!wrap) return null;
    const wrapRect = wrap.getBoundingClientRect();
    const rows = Array.from(wrap.querySelectorAll('tbody tr'));
    const firstVisible = rows.find((row) => row.getBoundingClientRect().bottom > wrapRect.top + 1) || null;
    if (!firstVisible) return null;
    return {
      key: (firstVisible.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
      top: firstVisible.getBoundingClientRect().top - wrapRect.top,
      scrollTop: wrap.scrollTop,
    };
  `)
  if (!after?.key) {
    warnOrFail('Event log scroll anchor test skipped: no visible row found after updates.')
    return { skipped: true }
  }

  if (before.key !== after.key || Math.abs(Number(after.top) - Number(before.top)) > 6) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-event-log-scroll-anchor-drift.png'), Buffer.from(b64, 'base64'))
    throw new Error(
      `Event Log scroll anchor drifted during prepend updates (before="${before.key}", after="${after.key}", topDelta=${(Number(after.top) - Number(before.top)).toFixed(1)})`,
    )
  }
  return { before, after }
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

export async function runTopNavSwitchResponsivenessCase(driver, screenshotPath) {
  await waitTopNavLabel(driver, 'Analytics', 15000)
  await waitTopNavLabel(driver, 'Requests', 15000)
  await waitTopNavLabel(driver, 'Dashboard', 15000)
  await waitTopNavLabel(driver, 'Events', 15000)
  await waitTopNavLabel(driver, 'Provider Switchboard', 15000)

  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const readNavLabels = () => {
      const buttons = Array.from(document.querySelectorAll('button.aoTopNavBtn'));
      return buttons
        .map((btn) => (btn.querySelector('span')?.textContent || '').trim())
        .filter(Boolean);
    };
    const navLabels = readNavLabels();
    const core = ['Analytics', 'Requests', 'Dashboard', 'Events', 'Provider Switchboard'];
    const existingCore = core.filter((label) => navLabels.includes(label));
    const extra = navLabels.filter((label) => !existingCore.includes(label));
    const labels = [...existingCore, ...extra, 'Analytics'];
    const buttonByLabel = (label) => {
      const buttons = Array.from(document.querySelectorAll('button.aoTopNavBtn'));
      return buttons.find((btn) => {
        const span = btn.querySelector('span');
        return (span?.textContent || '').trim() === label;
      }) || null;
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const hasText = (selector, expected) => {
      const nodes = Array.from(document.querySelectorAll(selector));
      return nodes.some((n) => isVisible(n) && ((n.textContent || '').replace(/\\s+/g, ' ').trim()) === expected);
    };
    const isPageReadyForLabel = (label) => {
      if (label === 'Dashboard') return hasText('.aoH3', 'Providers');
      if (label === 'Analytics') return hasText('.aoMiniLabel', 'Provider Statistics');
      if (label === 'Requests') return hasText('.aoMiniLabel', 'Request Details');
      if (label === 'Events') return hasText('.aoH3', 'Event Log');
      if (label === 'Provider Switchboard') {
        return hasText('.aoPagePlaceholderTitle', 'Provider Switchboard');
      }
      // For future tabs: require active nav + any visible page placeholder title or section heading.
      const active = buttonByLabel(label);
      if (!active) return false;
      if (!(active.getAttribute('aria-selected') === 'true' || active.classList.contains('is-active'))) return false;
      const titles = Array.from(document.querySelectorAll('.aoPagePlaceholderTitle, .aoH3'));
      return titles.some((n) => (n.textContent || '').trim().length > 0);
    };
    const clickButton = (btn) => {
      if (!btn) return;
      try {
        btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      } catch {}
      btn.click();
    };
    const stepLatencies = [];
    let stepIndex = 0;
    let waitingSince = 0;
    let rafStarted = performance.now();
    let prevTs = rafStarted;
    let maxFrameGap = 0;
    const clickGapMs = 80;
    let rafCount = 0;

    const loop = (ts) => {
      rafCount += 1;
      const gap = ts - prevTs;
      if (gap > maxFrameGap) maxFrameGap = gap;
      prevTs = ts;

      if (stepIndex < labels.length && ts - rafStarted >= stepIndex * clickGapMs && waitingSince === 0) {
        const btn = buttonByLabel(labels[stepIndex]);
        clickButton(btn);
        waitingSince = performance.now();
      }

      if (waitingSince > 0 && isPageReadyForLabel(labels[stepIndex])) {
        stepLatencies.push(performance.now() - waitingSince);
        waitingSince = 0;
        stepIndex += 1;
      }

      const doneSteps = stepIndex >= labels.length;
      const elapsed = ts - rafStarted;
      if (doneSteps && elapsed > labels.length * clickGapMs + 220) {
        done({ ok: true, labels, stepLatencies, maxFrameGap, rafCount });
        return;
      }
      if (elapsed > 5000) {
        done({ ok: false, labels, stepLatencies, maxFrameGap, rafCount, reason: 'timeout' });
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  `)

  if (!result?.ok) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-top-nav-switch-timeout.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Top nav responsiveness probe failed: ${String(result?.reason || 'unknown')}`)
  }

  const latencies = Array.isArray(result.stepLatencies) ? result.stepLatencies : []
  const expectedSteps = Array.isArray(result?.labels) ? result.labels.length : 6
  if (latencies.length < expectedSteps) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-top-nav-switch-incomplete.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Top nav responsiveness probe incomplete: ${latencies.length}/${expectedSteps}`)
  }

  const maxLatency = Math.max(...latencies)
  const maxFrameGap = Number(result.maxFrameGap || 0)
  if (maxLatency > TOP_NAV_MAX_STEP_LATENCY_MS) {
    throw new Error(
      `Top nav switch latency exceeded contract: max=${maxLatency.toFixed(1)}ms > ${TOP_NAV_MAX_STEP_LATENCY_MS}ms, steps=${latencies.map((v) => v.toFixed(1)).join(',')}ms`,
    )
  }
  if (maxFrameGap > 120) {
    warnOrFail(`Top nav frame gap high during rapid switch: maxFrameGap=${maxFrameGap.toFixed(1)}ms`)
  }
  return {
    stepLatencies: latencies,
    maxLatency,
    maxFrameGap,
  }
}

export async function runRequestsFirstPaintStabilityCase(driver, screenshotPath) {
  await clickTopNav(driver, 'Analytics')
  await waitVisible(
    driver,
    By.xpath(`//div[contains(@class,'aoMiniLabel') and normalize-space()='Provider Statistics']`),
    15000,
  )
  await clickTopNav(driver, 'Requests')
  await waitVisible(
    driver,
    By.xpath(`//div[contains(@class,'aoMiniLabel') and normalize-space()='Request Details']`),
    15000,
  )

  const probe = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const readShown = () => {
      const heads = Array.from(document.querySelectorAll('.aoUsageRequestChartCard .aoSwitchboardSectionHead .aoHint'));
      for (const el of heads) {
        const txt = (el.textContent || '').trim();
        const m = txt.match(/([\\d,]+)\\s+requests shown/i);
        if (m) return Number(String(m[1]).replaceAll(',', ''));
      }
      return null;
    };
    const start = performance.now();
    const samples = [];
    const loop = () => {
      const v = readShown();
      if (v != null) samples.push(v);
      if (performance.now() - start >= 1200) {
        done({ ok: true, samples });
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  `)

  const samples = Array.isArray(probe?.samples) ? probe.samples : []
  const maxShown = samples.length ? Math.max(...samples) : 0
  const sawZero = samples.includes(0)
  if (maxShown > 0 && sawZero) {
    const b64 = await driver.takeScreenshot()
    fs.writeFileSync(screenshotPath.replace('.png', '-requests-first-paint-flash-zero.png'), Buffer.from(b64, 'base64'))
    throw new Error(`Requests first paint unstable: saw 0 before non-zero (${samples.join(',')})`)
  }
}

export async function runRequestsAnalyticsSwitchNoReloadCase(driver, screenshotPath) {
  await driver.executeScript(`
    const globalObj = window;
    const bucket = (globalObj.__ui_check__ = globalObj.__ui_check__ || {});
    bucket.__requestsEntriesInvokeCount = 0;

    const now = Date.now();
    const yesterday = now - 24 * 60 * 60 * 1000;
    const dayAgo = yesterday - (6 * 60 * 60 * 1000);
    const rows = Array.from({ length: 180 }, (_, idx) => ({
      provider: idx % 2 === 0 ? 'official' : 'provider_1',
      api_key_ref: '-',
      model: 'gpt-5.2-codex',
      origin: idx % 2 === 0 ? 'windows' : 'wsl2',
      session_id: 'ui-check-session-' + String(idx + 1).padStart(3, '0'),
      unix_ms: dayAgo - idx * 60 * 1000,
      input_tokens: 1000 + idx,
      output_tokens: 100 + idx,
      total_tokens: 1100 + idx * 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }));
    const daily = [{
      day_start_unix_ms: new Date(yesterday).setHours(0, 0, 0, 0),
      provider_totals: { official: 80000, provider_1: 70000 },
      total_tokens: 150000,
    }];
    const providers = [
      { provider: 'official', total_tokens: 80000 },
      { provider: 'provider_1', total_tokens: 70000 },
    ];

    if (!bucket.primeRequestsPrefetchCache || typeof bucket.primeRequestsPrefetchCache !== 'function') {
      throw new Error('primeRequestsPrefetchCache is not available on window.__ui_check__.');
    }
    bucket.primeRequestsPrefetchCache({
      rows,
      hasMore: true,
      dailyTotals: { days: daily, providers },
    });

    const patchInvoke = (target, key) => {
      if (!target || typeof target[key] !== 'function') return;
      if (target.__uiCheckRequestsInvokePatched) return;
      const original = target[key].bind(target);
      target.__uiCheckRequestsOriginalInvoke = original;
      target[key] = function patchedInvoke(cmd, payload) {
        if (cmd === 'get_usage_request_entries') {
          bucket.__requestsEntriesInvokeCount = (bucket.__requestsEntriesInvokeCount || 0) + 1;
        }
        return original(cmd, payload);
      };
      target.__uiCheckRequestsInvokePatched = true;
    };

    patchInvoke(globalObj.__TAURI_INTERNALS__, 'invoke');
    patchInvoke(globalObj.__TAURI__ && globalObj.__TAURI__.core, 'invoke');
  `)

  try {
    await clickTopNav(driver, 'Requests')
    await waitVisible(
      driver,
      By.xpath(`//div[contains(@class,'aoMiniLabel') and normalize-space()='Request Details']`),
      15000,
    )
    await new Promise((r) => setTimeout(r, 700))

    await driver.executeScript(`
      const bucket = (window.__ui_check__ = window.__ui_check__ || {});
      bucket.__requestsEntriesInvokeCount = 0;
    `)

    await clickTopNav(driver, 'Analytics')
    await waitVisible(
      driver,
      By.xpath(`//div[contains(@class,'aoMiniLabel') and normalize-space()='Provider Statistics']`),
      15000,
    )

    await clickTopNav(driver, 'Requests')
    await waitVisible(
      driver,
      By.xpath(`//div[contains(@class,'aoMiniLabel') and normalize-space()='Request Details']`),
      15000,
    )
    await new Promise((r) => setTimeout(r, 550))

    const probe = await driver.executeScript(`
      const bucket = (window.__ui_check__ = window.__ui_check__ || {});
      const invokeCount = Number(bucket.__requestsEntriesInvokeCount || 0);
      const footerHints = Array.from(document.querySelectorAll('.aoUsageRequestsFooter .aoHint'))
        .map((el) => (el.textContent || '').trim());
      const tableHint = document.querySelector('.aoUsageHistoryTableBody td.aoHint');
      const tableHintText = tableHint ? (tableHint.textContent || '').trim() : '';
      return { invokeCount, footerHints, tableHintText };
    `)
    const hasReloadHint = String(probe?.tableHintText || '') === "Loading today's rows..."
    const rowsHint = Array.isArray(probe?.footerHints) ? String(probe.footerHints[1] || '') : ''
    const collapsedToZeroRows = /^0\s*\/\s*\d+\s+rows$/i.test(rowsHint)
    if (hasReloadHint || Number(probe?.invokeCount || 0) > 0 || collapsedToZeroRows) {
      const b64 = await driver.takeScreenshot()
      fs.writeFileSync(screenshotPath.replace('.png', '-requests-analytics-switch-reload.png'), Buffer.from(b64, 'base64'))
      throw new Error(
        `Requests tab should not collapse visible rows after returning from Analytics, but detected reload-like state (hint="${probe.tableHintText}", invokeCount=${probe.invokeCount}, rowsHint="${rowsHint}"). footer=${JSON.stringify(probe.footerHints || [])}`,
      )
    }
  } finally {
    await driver.executeScript(`
      const globalObj = window;
      const restore = (target, key) => {
        if (!target || !target.__uiCheckRequestsInvokePatched) return;
        const original = target.__uiCheckRequestsOriginalInvoke;
        if (typeof original === 'function') target[key] = original;
        target.__uiCheckRequestsInvokePatched = false;
        target.__uiCheckRequestsOriginalInvoke = undefined;
      };
      restore(globalObj.__TAURI_INTERNALS__, 'invoke');
      restore(globalObj.__TAURI__ && globalObj.__TAURI__.core, 'invoke');
    `)
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
  const cliHome = ensureUiCheckCliHome(uiProfileDir)
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
  await applyUiCheckCliHomeInConfigureDirs(driver, cliHome)
  const readCliHomes = async () =>
    await driver.executeScript(`
      return Array.from(document.querySelectorAll('.aoSwitchMetaDirs'))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);
    `)
  const expectedCliHomeNorm = normalizeCliPath(cliHome)
  await driver.wait(
    async () => {
      const homes = await readCliHomes()
      return Array.isArray(homes) && homes.length === 1 && normalizeCliPath(homes[0]) === expectedCliHomeNorm
    },
    10000,
    'Switchboard target dirs should converge to isolated ui check cli home',
  )
  const cliHomes = await readCliHomes()
  if (!Array.isArray(cliHomes) || cliHomes.length !== 1) {
    throw new Error(`Switchboard target dirs should be exactly one isolated dir, got: ${Array.isArray(cliHomes) ? cliHomes.join(' | ') : 'invalid'}`)
  }
  if (normalizeCliPath(cliHomes[0]) !== normalizeCliPath(cliHome)) {
    throw new Error(`Switchboard target dirs mismatch: expected ${cliHome}, got ${cliHomes.join(' | ')}`)
  }
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
