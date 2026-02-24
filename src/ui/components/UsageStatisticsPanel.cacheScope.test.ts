import { describe, expect, it } from 'vitest'
import {
  buildUsageRequestsQueryKey,
  filterUsageRequestRowsByProviderIds,
  normalizeUsageRequestProviderFilter,
  pickUsageRequestGraphBaseRows,
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
        providers: [],
        models: [],
        origins: [],
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

  it('keeps requests tab anchored to current request rows before canonical cache', () => {
    const requestRows = makeRows('request_provider')
    const canonicalRows = makeRows('canonical_provider')
    const picked = pickUsageRequestGraphBaseRows({
      isRequestsTab: true,
      requestRows: [...requestRows],
      scopedPageRows: [],
      canonicalPageRows: [...canonicalRows],
      cachedGraphRows: [],
      fallbackRows: [],
    })
    expect(picked[0]?.provider).toBe('request_provider')
  })

  it('allows analytics tab to keep canonical cache precedence', () => {
    const requestRows = makeRows('request_provider')
    const canonicalRows = makeRows('canonical_provider')
    const picked = pickUsageRequestGraphBaseRows({
      isRequestsTab: false,
      requestRows: [...requestRows],
      scopedPageRows: [],
      canonicalPageRows: [...canonicalRows],
      cachedGraphRows: [],
      fallbackRows: [],
    })
    expect(picked[0]?.provider).toBe('canonical_provider')
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
