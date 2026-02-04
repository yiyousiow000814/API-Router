import { describe, expect, it } from 'vitest'

import { fmtAgo } from './format'

describe('fmtAgo', () => {
  it('shows just now for very recent timestamps', () => {
    expect(fmtAgo(1000, 1000)).toBe('just now')
    expect(fmtAgo(1000, 9000)).toBe('just now')
  })

  it('shows seconds/minutes/hours/days', () => {
    expect(fmtAgo(0, 0)).toBe('-')
    expect(fmtAgo(0)).toBe('-')

    expect(fmtAgo(1, 15_001)).toBe('15s ago')
    expect(fmtAgo(1, 1 + 2 * 60_000)).toBe('2m ago')
    expect(fmtAgo(1, 1 + 3 * 60 * 60_000)).toBe('3h ago')
    expect(fmtAgo(1, 1 + 4 * 24 * 60 * 60_000)).toBe('4d ago')
  })

  it('shows months/years for older timestamps', () => {
    const day = 24 * 60 * 60_000
    expect(fmtAgo(1, 1 + 45 * day)).toBe('1mo ago')
    expect(fmtAgo(1, 1 + 365 * day)).toBe('1y ago')
    expect(fmtAgo(1, 1 + 800 * day)).toBe('2y ago')
  })
})
