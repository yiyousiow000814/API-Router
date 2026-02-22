import { describe, expect, it } from 'vitest'
import { buildUsageRequestEntriesArgs } from './UsageStatisticsPanel'

describe('buildUsageRequestEntriesArgs', () => {
  it('uses camelCase range keys for tauri command args', () => {
    const args = buildUsageRequestEntriesArgs({
      hours: 24,
      fromUnixMs: 1_738_800_000_000,
      toUnixMs: 1_738_886_400_000,
      providers: ['official'],
      models: null,
      origins: null,
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