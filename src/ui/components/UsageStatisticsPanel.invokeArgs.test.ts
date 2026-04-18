import { describe, expect, it } from 'vitest'
import {
  buildUsageRequestEntriesArgs,
  hasImpossibleSummaryRequestFilters,
  intersectUsageRequestFilterValues,
  resolveUsageRequestEmptyStateLabel,
  resolveUsageRequestFooterStatusLabel,
  resolveEffectiveSummaryRequestFilters,
} from './UsageStatisticsPanel'

describe('buildUsageRequestEntriesArgs', () => {
  it('uses camelCase range keys for tauri command args', () => {
    const args = buildUsageRequestEntriesArgs({
      hours: 24,
      fromUnixMs: 1_738_800_000_000,
      toUnixMs: 1_738_886_400_000,
      providers: ['official'],
      models: null,
      origins: null,
      sessions: null,
      limit: 200,
      offset: 0,
    })

    expect(args).toMatchObject({
      hours: 24,
      fromUnixMs: 1_738_800_000_000,
      toUnixMs: 1_738_886_400_000,
      providers: ['official'],
      limit: 200,
      offset: 0,
    })
    expect('from_unix_ms' in (args as Record<string, unknown>)).toBe(false)
    expect('to_unix_ms' in (args as Record<string, unknown>)).toBe(false)
  })
})

describe('intersectUsageRequestFilterValues', () => {
  it('returns the available side when the other side is unset', () => {
    expect(intersectUsageRequestFilterValues(['Local'], null)).toEqual(['Local'])
    expect(intersectUsageRequestFilterValues(null, ['Local'])).toEqual(['Local'])
  })

  it('intersects values case-insensitively', () => {
    expect(intersectUsageRequestFilterValues(['Local', 'Peer A'], ['local'])).toEqual(['Local'])
  })
})

describe('resolveEffectiveSummaryRequestFilters', () => {
  it('includes column filters so filtered summary follows the table filters', () => {
    expect(
      resolveEffectiveSummaryRequestFilters({
        globalNodes: null,
        globalProviders: ['official'],
        globalModels: null,
        globalOrigins: null,
        globalSessions: null,
        columnNodes: ['Local'],
        columnProviders: ['official'],
        columnModels: ['gpt-5.4'],
        columnOrigins: ['windows'],
        columnSessions: ['session-1'],
      }),
    ).toEqual({
      nodes: ['Local'],
      providers: ['official'],
      models: ['gpt-5.4'],
      origins: ['windows'],
      transports: null,
      sessions: ['session-1'],
    })
  })

  it('intersects global and column filters instead of dropping one side', () => {
    expect(
      resolveEffectiveSummaryRequestFilters({
        globalNodes: ['Local', 'Peer A'],
        globalProviders: ['official', 'openrouter'],
        globalModels: null,
        globalOrigins: null,
        globalSessions: null,
        columnNodes: ['peer a'],
        columnProviders: ['official'],
        columnModels: null,
        columnOrigins: null,
        columnSessions: null,
      }),
    ).toEqual({
      nodes: ['Peer A'],
      providers: ['official'],
      models: null,
      origins: null,
      transports: null,
      sessions: null,
    })
  })

  it('keeps empty intersections so impossible summary filters can be detected', () => {
    expect(
      resolveEffectiveSummaryRequestFilters({
        globalNodes: ['Local'],
        globalProviders: ['official'],
        globalModels: null,
        globalOrigins: null,
        globalSessions: null,
        columnNodes: ['Peer A'],
        columnProviders: ['openrouter'],
        columnModels: null,
        columnOrigins: null,
        columnSessions: null,
      }),
    ).toEqual({
      nodes: [],
      providers: [],
      models: null,
      origins: null,
      transports: null,
      sessions: null,
    })
  })
})

describe('hasImpossibleSummaryRequestFilters', () => {
  it('treats empty intersections as impossible', () => {
    expect(
      hasImpossibleSummaryRequestFilters({
        nodes: [],
        providers: null,
        models: null,
        origins: null,
        sessions: null,
      }),
    ).toBe(true)
  })

  it('keeps non-empty filter sets valid', () => {
    expect(
      hasImpossibleSummaryRequestFilters({
        nodes: ['Local'],
        providers: ['official'],
        models: null,
        origins: null,
        sessions: null,
      }),
    ).toBe(false)
  })
})

describe('resolveUsageRequestEmptyStateLabel', () => {
  it('prefers no-match message over loading when filters are impossible', () => {
    expect(
      resolveUsageRequestEmptyStateLabel({
        usageRequestLoading: true,
        hasImpossibleRequestFilters: true,
        defaultTodayOnly: false,
        usageRequestHasMore: true,
        totalRequestRowsForDisplay: 0,
      }),
    ).toBe('No request rows match current filters.')
  })

  it('keeps loading message for normal in-flight fetches', () => {
    expect(
      resolveUsageRequestEmptyStateLabel({
        usageRequestLoading: true,
        hasImpossibleRequestFilters: false,
        defaultTodayOnly: false,
        usageRequestHasMore: true,
        totalRequestRowsForDisplay: 0,
      }),
    ).toBe('Loading rows...')
  })
})

describe('resolveUsageRequestFooterStatusLabel', () => {
  it('prefers all-loaded when filters are impossible', () => {
    expect(
      resolveUsageRequestFooterStatusLabel({
        usageRequestLoading: true,
        hasImpossibleRequestFilters: true,
        usageRequestHasMore: true,
        hasExplicitRequestFilters: true,
      }),
    ).toBe('All loaded')
  })

  it('keeps loading-more for normal in-flight pagination', () => {
    expect(
      resolveUsageRequestFooterStatusLabel({
        usageRequestLoading: true,
        hasImpossibleRequestFilters: false,
        usageRequestHasMore: true,
        hasExplicitRequestFilters: true,
      }),
    ).toBe('Loading more...')
  })
})
