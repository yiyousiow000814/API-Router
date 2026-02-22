import { describe, expect, it } from 'vitest'
import { resolveRequestTableSummary } from './UsageStatisticsPanel'

describe('resolveRequestTableSummary', () => {
  it('uses backend summary when available', () => {
    const summary = resolveRequestTableSummary({
      usageRequestSummary: {
        ok: true,
        requests: 1003,
        input_tokens: 10_000,
        output_tokens: 2_000,
        total_tokens: 12_000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 1_500,
      },
      displayedRows: [],
      hasMore: true,
      preferBackendSummary: true,
    })

    expect(summary).toEqual({
      requests: 1003,
      input: 10_000,
      output: 2_000,
      total: 12_000,
      cacheCreate: 500,
      cacheRead: 1_500,
    })
  })

  it('does not return partial totals when more pages exist', () => {
    const summary = resolveRequestTableSummary({
      usageRequestSummary: null,
      displayedRows: [
        {
          provider: 'official',
          api_key_ref: '-',
          model: 'gpt-5.2-codex',
          origin: 'wsl2',
          session_id: 's1',
          unix_ms: 1,
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      ],
      hasMore: true,
      preferBackendSummary: true,
    })

    expect(summary).toBeNull()
  })

  it('falls back to rows only when all pages are loaded', () => {
    const summary = resolveRequestTableSummary({
      usageRequestSummary: null,
      displayedRows: [
        {
          provider: 'official',
          api_key_ref: '-',
          model: 'gpt-5.2-codex',
          origin: 'wsl2',
          session_id: 's1',
          unix_ms: 1,
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 7,
        },
        {
          provider: 'official',
          api_key_ref: '-',
          model: 'gpt-5.2-codex',
          origin: 'wsl2',
          session_id: 's2',
          unix_ms: 2,
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 4,
        },
      ],
      hasMore: false,
      preferBackendSummary: true,
    })

    expect(summary).toEqual({
      requests: 2,
      input: 110,
      output: 25,
      total: 135,
      cacheCreate: 5,
      cacheRead: 11,
    })
  })
})
