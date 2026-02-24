import { describe, expect, it } from 'vitest'
import { buildUsageProviderDetailRows } from './UsageProviderStatsTable'

describe('buildUsageProviderDetailRows', () => {
  it('keeps case-distinct api key refs separated', () => {
    const rows = [
      {
        provider: 'provider_1',
        api_key_ref: 'Key-A',
        requests: 1,
        total_tokens: 10,
        estimated_daily_cost_usd: 1,
        total_used_cost_usd: 1,
        pricing_source: 'manual',
      },
      {
        provider: 'provider_1',
        api_key_ref: 'key-a',
        requests: 2,
        total_tokens: 20,
        estimated_daily_cost_usd: 2,
        total_used_cost_usd: 2,
        pricing_source: 'manual',
      },
    ]
    const detailRows = buildUsageProviderDetailRows(
      rows as any,
      (row) => `${row.provider}::${row.api_key_ref}` as string,
    )
    expect(detailRows).toHaveLength(2)
    expect(new Set(detailRows.map((row) => row.apiKeyRef))).toEqual(new Set(['Key-A', 'key-a']))
  })
})
