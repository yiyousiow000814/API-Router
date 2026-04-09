import { describe, expect, it } from 'vitest'
import {
  buildUsageRequestEntriesArgs,
  intersectUsageRequestFilterValues,
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
      sessions: null,
    })
  })
})
