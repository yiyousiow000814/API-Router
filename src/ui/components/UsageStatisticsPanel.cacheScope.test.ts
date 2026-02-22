import { describe, expect, it } from 'vitest'
import { resolveRequestPageCached } from './UsageStatisticsPanel'

describe('resolveRequestPageCached', () => {
  const exact = { queryKey: 'exact', rows: [], hasMore: false, usingTestFallback: false }
  const canonical = { queryKey: 'canonical', rows: [], hasMore: false, usingTestFallback: false }
  const last = { queryKey: 'last', rows: [], hasMore: false, usingTestFallback: false }

  it('keeps strict mode scoped to exact query cache', () => {
    const picked = resolveRequestPageCached({
      isRequestsTab: true,
      hasStrictRequestQuery: true,
      cached: exact,
      canonicalCached: canonical,
      lastNonEmpty: last,
    })
    expect(picked?.queryKey).toBe('exact')
  })

  it('does not fall back to canonical cache when exact cache is missing', () => {
    const picked = resolveRequestPageCached({
      isRequestsTab: true,
      hasStrictRequestQuery: false,
      cached: null,
      canonicalCached: canonical,
      lastNonEmpty: last,
    })
    expect(picked).toBeNull()
  })

  it('allows analytics to fall back to canonical cache', () => {
    const picked = resolveRequestPageCached({
      isRequestsTab: false,
      hasStrictRequestQuery: false,
      cached: null,
      canonicalCached: canonical,
      lastNonEmpty: last,
    })
    expect(picked?.queryKey).toBe('canonical')
  })
})
