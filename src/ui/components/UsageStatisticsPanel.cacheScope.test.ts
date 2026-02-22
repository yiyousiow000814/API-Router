import { describe, expect, it } from 'vitest'
import { resolveRequestPageCached, resolveSummaryFetchWindow } from './UsageStatisticsPanel'

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

describe('resolveSummaryFetchWindow', () => {
  const makeRow = (unixMs: number) =>
    ({ unix_ms: unixMs } as unknown as Parameters<typeof resolveSummaryFetchWindow>[0]['rowsForRequestRender'][number])

  it('falls back to unbounded summary when no rows are from default day', () => {
    const window = resolveSummaryFetchWindow({
      requestFetchFromUnixMs: null,
      hasExplicitRequestFilters: false,
      rowsForRequestRender: [makeRow(new Date(2026, 1, 20, 12, 0, 0, 0).getTime())],
      requestDefaultDay: new Date(2026, 1, 22, 0, 0, 0, 0).getTime(),
    })
    expect(window.fromUnixMs).toBeNull()
    expect(window.toUnixMs).toBeNull()
  })

  it('keeps today-only summary when rendered rows include default day', () => {
    const day = new Date(2026, 1, 22, 0, 0, 0, 0).getTime()
    const window = resolveSummaryFetchWindow({
      requestFetchFromUnixMs: null,
      hasExplicitRequestFilters: false,
      rowsForRequestRender: [makeRow(day + 1000)],
      requestDefaultDay: day,
    })
    expect(window.fromUnixMs).toBe(day)
    expect(window.toUnixMs).toBe(day + 24 * 60 * 60 * 1000)
  })
})
