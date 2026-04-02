import { describe, expect, it } from 'vitest'

import {
  appendPendingRefreshKey,
  shouldApplyRefreshResult,
} from './useRefreshScheduler'

describe('useRefreshScheduler helpers', () => {
  it('deduplicates pending refresh keys while preserving order', () => {
    expect(appendPendingRefreshKey([], 'status')).toEqual(['status'])
    expect(appendPendingRefreshKey(['status'], 'status')).toEqual(['status'])
    expect(appendPendingRefreshKey(['status'], 'config')).toEqual(['status', 'config'])
  })

  it('applies results only when the generation is current', () => {
    expect(shouldApplyRefreshResult('dashboard', 'any', 2, 2)).toBe(true)
    expect(shouldApplyRefreshResult('dashboard', 'any', 1, 2)).toBe(false)
  })

  it('drops page-owned results after the user leaves that page', () => {
    expect(shouldApplyRefreshResult('dashboard', 'dashboard', 3, 3)).toBe(true)
    expect(shouldApplyRefreshResult('usage_requests', 'dashboard', 3, 3)).toBe(false)
  })
})
