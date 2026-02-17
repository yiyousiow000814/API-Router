import { describe, expect, it } from 'vitest'
import { buildDevUsageStatistics } from './devUsageStatistics'

describe('buildDevUsageStatistics', () => {
  it('applies origin filters to summary totals', () => {
    const baseParams = {
      now: Date.now(),
      usageWindowHours: 24,
      usageFilterProviders: [],
      usageFilterModels: [],
    }
    const all = buildDevUsageStatistics({
      ...baseParams,
      usageFilterOrigins: [],
    })
    const windowsOnly = buildDevUsageStatistics({
      ...baseParams,
      usageFilterOrigins: ['windows'],
    })
    const wsl2Only = buildDevUsageStatistics({
      ...baseParams,
      usageFilterOrigins: ['wsl2'],
    })

    expect(all.summary.total_requests).toBeGreaterThan(windowsOnly.summary.total_requests)
    expect(all.summary.total_requests).toBeGreaterThan(wsl2Only.summary.total_requests)
    expect(windowsOnly.summary.total_requests).toBeGreaterThan(0)
    expect(wsl2Only.summary.total_requests).toBeGreaterThan(0)
  })

  it('returns origin filter and catalog metadata', () => {
    const stats = buildDevUsageStatistics({
      now: Date.now(),
      usageWindowHours: 24,
      usageFilterProviders: [],
      usageFilterModels: [],
      usageFilterOrigins: ['wsl2'],
    })

    expect(stats.filter?.origins).toEqual(['wsl2'])
    expect(stats.catalog?.origins).toEqual(['windows', 'wsl2'])
  })
})
