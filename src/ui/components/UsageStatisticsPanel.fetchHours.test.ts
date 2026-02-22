import { describe, expect, it } from 'vitest'
import { resolveRequestFetchHours } from './UsageStatisticsPanel'

describe('resolveRequestFetchHours', () => {
  it('keeps analytics window on requests tab when filters are visible', () => {
    const hours = resolveRequestFetchHours({
      effectiveDetailsTab: 'requests',
      showFilters: true,
      usageWindowHours: 24,
    })
    expect(hours).toBe(24)
  })
})
