import { describe, expect, it } from 'vitest'
import {
  calculateUsageRequestSlideOffsetX,
  detectUsageRequestLineShiftSteps,
  buildUsageRequestsQueryKey,
  filterUsageRequestRowsByProviderIds,
  isRequestsTabActivationEdge,
  mergeUsageRequestGraphRowsFromRealtime,
  normalizeUsageRequestProviderFilter,
  pickUsageRequestGraphBaseRows,
  resolveUsageRequestSlidingPreview,
  resolveRequestPageCached,
  resolveRequestTableSummary,
  resolveSummaryFetchWindow,
} from './UsageStatisticsPanel'

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
      hasExplicitTimeFilter: false,
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
      hasExplicitTimeFilter: false,
      rowsForRequestRender: [makeRow(day + 1000)],
      requestDefaultDay: day,
    })
    expect(window.fromUnixMs).toBe(day)
    expect(window.toUnixMs).toBe(day + 24 * 60 * 60 * 1000)
  })

  it('keeps today-only summary even when non-time filters are active', () => {
    const day = new Date(2026, 1, 22, 0, 0, 0, 0).getTime()
    const window = resolveSummaryFetchWindow({
      requestFetchFromUnixMs: null,
      hasExplicitTimeFilter: false,
      rowsForRequestRender: [makeRow(day + 5_000)],
      requestDefaultDay: day,
    })
    expect(window.fromUnixMs).toBe(day)
    expect(window.toUnixMs).toBe(day + 24 * 60 * 60 * 1000)
  })

  it('does not force today-only summary when an explicit date filter is active', () => {
    const day = new Date(2026, 1, 22, 0, 0, 0, 0).getTime()
    const window = resolveSummaryFetchWindow({
      requestFetchFromUnixMs: null,
      hasExplicitTimeFilter: true,
      rowsForRequestRender: [makeRow(day + 5_000)],
      requestDefaultDay: day,
    })
    expect(window.fromUnixMs).toBeNull()
    expect(window.toUnixMs).toBeNull()
  })
})

describe('resolveRequestTableSummary', () => {
  const row = {
    input_tokens: 100,
    output_tokens: 10,
    total_tokens: 110,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 7,
  } as unknown as Parameters<typeof resolveRequestTableSummary>[0]['displayedRows'][number]

  it('uses displayed row totals when backend summary is not preferred', () => {
    const summary = resolveRequestTableSummary({
      usageRequestSummary: {
        ok: true,
        requests: 999,
        input_tokens: 9999,
        output_tokens: 8888,
        total_tokens: 7777,
        cache_creation_input_tokens: 6666,
        cache_read_input_tokens: 5555,
      },
      displayedRows: [row],
      hasMore: false,
      preferBackendSummary: false,
    })
    expect(summary).toEqual({
      requests: 1,
      input: 100,
      output: 10,
      total: 110,
      cacheCreate: 3,
      cacheRead: 7,
    })
  })

  it('uses backend summary when preferred', () => {
    const summary = resolveRequestTableSummary({
      usageRequestSummary: {
        ok: true,
        requests: 5,
        input_tokens: 500,
        output_tokens: 50,
        total_tokens: 550,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      },
      displayedRows: [row],
      hasMore: false,
      preferBackendSummary: true,
    })
    expect(summary).toEqual({
      requests: 5,
      input: 500,
      output: 50,
      total: 550,
      cacheCreate: 20,
      cacheRead: 30,
    })
  })
})

describe('buildUsageRequestsQueryKey', () => {
  it('keeps canonical all-history key shape in sync with request query key fields', () => {
    const key = buildUsageRequestsQueryKey({
      hours: 24 * 365 * 20,
      fromUnixMs: null,
      toUnixMs: null,
      providers: null,
      models: null,
      origins: null,
      sessions: null,
    })
    expect(key).toBe(
      JSON.stringify({
        hours: 24 * 365 * 20,
        from_unix_ms: null,
        to_unix_ms: null,
        nodes: [],
        providers: [],
        models: [],
        origins: [],
        transports: [],
        sessions: [],
      }),
    )
  })
})

describe('pickUsageRequestGraphBaseRows', () => {
  const makeRows = (provider: string) =>
    [
      {
        provider,
        api_key_ref: '-',
        model: 'm',
        origin: 'o',
        session_id: 's',
        unix_ms: 1,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    ] as const

  it('always prefers canonical rows over scoped request rows', () => {
    const canonicalRows = makeRows('canonical_provider')
    const picked = pickUsageRequestGraphBaseRows({
      canonicalPageRows: [...canonicalRows],
      cachedGraphRows: [],
      fallbackRows: [],
    })
    expect(picked[0]?.provider).toBe('canonical_provider')
  })

  it('falls back to graph cache rows when canonical rows are unavailable', () => {
    const cachedRows = makeRows('cached_provider')
    const picked = pickUsageRequestGraphBaseRows({
      canonicalPageRows: [],
      cachedGraphRows: [...cachedRows],
      fallbackRows: [],
    })
    expect(picked[0]?.provider).toBe('cached_provider')
  })

  it('uses fallback rows only when canonical and cached rows are both unavailable', () => {
    const fallbackRows = makeRows('fallback_provider')
    const picked = pickUsageRequestGraphBaseRows({
      canonicalPageRows: [],
      cachedGraphRows: [],
      fallbackRows: [...fallbackRows],
    })
    expect(picked[0]?.provider).toBe('fallback_provider')
  })
})

describe('mergeUsageRequestGraphRowsFromRealtime', () => {
  const makeRow = (sessionId: string, unixMs: number) => ({
    provider: 'provider',
    api_key_ref: '-',
    model: 'm',
    origin: 'windows',
    session_id: sessionId,
    unix_ms: unixMs,
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  })

  it('prepends new realtime rows and keeps newest-first unique order', () => {
    const current = [makeRow('s2', 2000), makeRow('s1', 1000)]
    const incoming = [makeRow('s4', 4000), makeRow('s3', 3000), makeRow('s2', 2000)]
    const merged = mergeUsageRequestGraphRowsFromRealtime({
      currentGraphRows: current as any,
      incomingRows: incoming as any,
      limit: 10,
    })
    expect(merged.map((row) => row.session_id)).toEqual(['s4', 's3', 's2', 's1'])
  })

  it('returns previous array when incoming rows are already known', () => {
    const current = [makeRow('s2', 2000), makeRow('s1', 1000)]
    const incoming = [makeRow('s2', 2000)]
    const merged = mergeUsageRequestGraphRowsFromRealtime({
      currentGraphRows: current as any,
      incomingRows: incoming as any,
      limit: 10,
    })
    expect(merged).toBe(current)
  })
})

describe('request graph sliding helpers', () => {
  it('detects multi-step point-id shift for sliding animation', () => {
    const shift = detectUsageRequestLineShiftSteps(
      ['a', 'b', 'c', 'd', 'e'],
      5,
      ['c', 'd', 'e', 'f', 'g'],
      5,
    )
    expect(shift).toBe(2)
  })

  it('extracts preview tail values for multi-step live sliding', () => {
    const preview = resolveUsageRequestSlidingPreview({
      values: [10, 20, 30, 40, 50],
      currentCount: 5,
      shiftSteps: 3,
      maxShiftSteps: 4,
    })
    expect(preview.slideSteps).toBe(3)
    expect(preview.previewNextValues).toEqual([30, 40, 50])
    expect(preview.previewNextValue).toBe(50)
  })

  it('computes per-series slide offset with phase and step count', () => {
    const offset = calculateUsageRequestSlideOffsetX(0.5, 12, 3)
    expect(offset).toBe(18)
  })
})

describe('provider filter helpers', () => {
  it('keeps raw provider ids without display-name remapping', () => {
    const picked = normalizeUsageRequestProviderFilter(['Alpha', 'alpha', 'Alpha', '  '])
    expect(picked).toEqual(['Alpha', 'alpha'])
  })

  it('filters rows by raw provider ids only', () => {
    const rows = [
      {
        provider: 'groupA-provider-1',
        api_key_ref: '-',
        model: 'm',
        origin: 'o',
        session_id: 's1',
        unix_ms: 1,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      {
        provider: 'groupA-provider-2',
        api_key_ref: '-',
        model: 'm',
        origin: 'o',
        session_id: 's2',
        unix_ms: 2,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    ] as const
    const filtered = filterUsageRequestRowsByProviderIds(rows as any, ['groupA-provider-1'])
    expect(filtered).toHaveLength(1)
    expect(filtered[0].provider).toBe('groupA-provider-1')
  })
})

describe('isRequestsTabActivationEdge', () => {
  it('returns true on first transition into Requests tab', () => {
    expect(
      isRequestsTabActivationEdge({
        isRequestsTab: true,
        wasRequestsTab: false,
      }),
    ).toBe(true)
  })

  it('returns false when already staying on Requests tab', () => {
    expect(
      isRequestsTabActivationEdge({
        isRequestsTab: true,
        wasRequestsTab: true,
      }),
    ).toBe(false)
  })

  it('returns false when leaving Requests tab', () => {
    expect(
      isRequestsTabActivationEdge({
        isRequestsTab: false,
        wasRequestsTab: true,
      }),
    ).toBe(false)
  })
})
