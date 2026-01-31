import { describe, expect, it } from 'vitest'
import { computeActiveRefreshDelayMs, computeIdleRefreshDelayMs } from './usageRefresh'

describe('usage refresh scheduling', () => {
  it('computes the next idle refresh at the half-hour boundary when jitter is zero', () => {
    const nowMs = Date.UTC(2026, 0, 1, 10, 5, 30)
    const delay = computeIdleRefreshDelayMs(nowMs, 0)
    const expected = (24 * 60 + 30) * 1000
    expect(delay).toBe(expected)
  })

  it('pushes idle refresh into the next half-hour window when jitter is too early', () => {
    const nowMs = Date.UTC(2026, 0, 1, 10, 29, 30)
    const jitterMs = -5 * 60 * 1000
    const delay = computeIdleRefreshDelayMs(nowMs, jitterMs)
    const expected = (25 * 60 + 30) * 1000
    expect(delay).toBe(expected)
  })

  it('computes active refresh delay from base and jitter', () => {
    const delay = computeActiveRefreshDelayMs(-60 * 1000)
    expect(delay).toBe(4 * 60 * 1000)
  })
})
