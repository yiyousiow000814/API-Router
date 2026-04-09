import { describe, expect, it } from 'vitest'
import {
  configPollIntervalMs,
  shouldPollSwapStatusOnStatusRefresh,
  statusPollDetailLevel,
  statusPollIntervalMs,
} from './useAppPolling'

describe('useAppPolling', () => {
  it('keeps dashboard polling fast while visible', () => {
    expect(statusPollIntervalMs('dashboard', true)).toBe(1500)
    expect(statusPollIntervalMs('provider_switchboard', true)).toBe(1500)
  })

  it('slows non-dashboard polling while visible', () => {
    expect(statusPollIntervalMs('web_codex', true)).toBe(5000)
    expect(statusPollIntervalMs('event_log', true)).toBe(5000)
  })

  it('uses the slowest poll interval when hidden', () => {
    expect(statusPollIntervalMs('dashboard', false)).toBe(15000)
    expect(statusPollIntervalMs('web_codex', false)).toBe(15000)
  })

  it('keeps config polling responsive only while visible', () => {
    expect(configPollIntervalMs(true)).toBe(2000)
    expect(configPollIntervalMs(false)).toBe(15000)
  })

  it('only polls swap status in switchboard-focused flows', () => {
    expect(shouldPollSwapStatusOnStatusRefresh('dashboard', false)).toBe(false)
    expect(shouldPollSwapStatusOnStatusRefresh('provider_switchboard', false)).toBe(true)
    expect(shouldPollSwapStatusOnStatusRefresh('dashboard', true)).toBe(true)
  })

  it('uses dashboard detail only on dashboard polls', () => {
    expect(statusPollDetailLevel('dashboard')).toBe('dashboard')
    expect(statusPollDetailLevel('provider_switchboard')).toBe('full')
    expect(statusPollDetailLevel('usage_requests')).toBe('full')
  })
})
