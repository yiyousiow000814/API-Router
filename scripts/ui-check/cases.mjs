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

