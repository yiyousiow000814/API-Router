import { describe, expect, it } from 'vitest'
import { buildUsageRequestCalendarIndex } from './UsageStatisticsPanel'

describe('buildUsageRequestCalendarIndex', () => {
  it('marks calendar days from daily totals materialized index even when page rows are empty', () => {
    const day = new Date(2026, 1, 20).setHours(0, 0, 0, 0)
    const index = buildUsageRequestCalendarIndex({
      isRequestsTab: true,
      rowsForRequestRender: [],
      usageRequestDailyTotalsDays: [
        {
          day_start_unix_ms: day,
          provider_totals: { official: 123 },
          total_tokens: 123,
          total_requests: 2,
          windows_request_count: 0,
          wsl_request_count: 2,
        },
      ],
    })

    expect(index.daysWithRecords.has(day)).toBe(true)
    expect(index.dayOriginFlags.get(day)).toEqual({ win: false, wsl: true })
  })

  it('returns empty index when requests tab is not active', () => {
    const day = new Date(2026, 1, 22).setHours(0, 0, 0, 0)
    const index = buildUsageRequestCalendarIndex({
      isRequestsTab: false,
      rowsForRequestRender: [
        {
          provider: 'official',
          api_key_ref: '-',
          model: 'gpt-5.2-codex',
          origin: 'windows',
          session_id: 's1',
          unix_ms: day + 3600_000,
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      ],
      usageRequestDailyTotalsDays: [],
    })

    expect(index.daysWithRecords.size).toBe(0)
    expect(index.dayOriginFlags.size).toBe(0)
  })

  it('keeps days with zero-token requests from daily totals in calendar index', () => {
    const day = new Date(2026, 1, 23).setHours(0, 0, 0, 0)
    const index = buildUsageRequestCalendarIndex({
      isRequestsTab: true,
      rowsForRequestRender: [],
      usageRequestDailyTotalsDays: [
        {
          day_start_unix_ms: day,
          provider_totals: { official: 0 },
          total_tokens: 0,
          total_requests: 3,
          windows_request_count: 0,
          wsl_request_count: 0,
        },
      ],
    })

    expect(index.daysWithRecords.has(day)).toBe(true)
    expect(index.dayOriginFlags.get(day)).toEqual({ win: true, wsl: false })
  })
})
