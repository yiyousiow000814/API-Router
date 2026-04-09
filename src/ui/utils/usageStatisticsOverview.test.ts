import { describe, expect, it } from 'vitest'
import type { UsageStatistics } from '../types'
import { buildUsageStatisticsOverviewFromFull } from './usageStatisticsOverview'

describe('buildUsageStatisticsOverviewFromFull', () => {
  it('keeps only dashboard-needed fields from full usage statistics', () => {
    const full: UsageStatistics = {
      ok: true,
      generated_at_unix_ms: 123,
      window_hours: 24,
      bucket_seconds: 3600,
      filter: {
        nodes: ['Desk A'],
        providers: ['official'],
        models: ['gpt-5'],
        origins: ['windows'],
      },
      catalog: {
        nodes: ['Desk A'],
        providers: ['official'],
        models: ['gpt-5'],
        origins: ['windows'],
      },
      summary: {
        total_requests: 9,
        total_tokens: 900,
        input_tokens: 600,
        output_tokens: 300,
        active_window_hours: 3,
        cache_creation_tokens: 11,
        cache_read_tokens: 12,
        unique_models: 2,
        top_model: {
          model: 'gpt-5',
          requests: 7,
          share_pct: 77.8,
        },
        estimated_total_cost_usd: 12.3,
        estimated_daily_cost_usd: 4.5,
        by_model: [
          {
            model: 'gpt-5',
            requests: 7,
            input_tokens: 400,
            output_tokens: 200,
            total_tokens: 600,
            share_pct: 77.8,
            estimated_total_cost_usd: 10,
            estimated_avg_request_cost_usd: 1.4,
            estimated_cost_request_count: 7,
          },
        ],
        by_provider: [
          {
            provider: 'official',
            api_key_ref: 'key-1',
            requests: 9,
            total_tokens: 900,
            tokens_per_request: 100,
            estimated_total_cost_usd: 12.3,
            estimated_avg_request_cost_usd: 1.36,
            usd_per_million_tokens: 13_666,
            estimated_daily_cost_usd: 4.5,
            total_used_cost_usd: 12.3,
            pricing_source: 'manual',
            estimated_cost_request_count: 9,
          },
        ],
        timeline: [
          {
            bucket_unix_ms: 111,
            requests: 9,
            total_tokens: 900,
            cache_creation_tokens: 11,
            cache_read_tokens: 12,
          },
        ],
      },
    }

    const overview = buildUsageStatisticsOverviewFromFull(full)
    expect(overview).toEqual({
      ok: true,
      generated_at_unix_ms: 123,
      window_hours: 24,
      bucket_seconds: 3600,
      summary: {
        total_requests: 9,
        total_tokens: 900,
        input_tokens: 600,
        output_tokens: 300,
        active_window_hours: 3,
        cache_creation_tokens: 11,
        cache_read_tokens: 12,
        unique_models: 2,
        top_model: {
          model: 'gpt-5',
          requests: 7,
          share_pct: 77.8,
        },
        estimated_total_cost_usd: 12.3,
        estimated_daily_cost_usd: 4.5,
        by_provider: [
          {
            provider: 'official',
            api_key_ref: 'key-1',
            requests: 9,
            total_tokens: 900,
            tokens_per_request: 100,
            estimated_total_cost_usd: 12.3,
            estimated_avg_request_cost_usd: 1.36,
            usd_per_million_tokens: 13_666,
            estimated_daily_cost_usd: 4.5,
            total_used_cost_usd: 12.3,
            pricing_source: 'manual',
            estimated_cost_request_count: 9,
          },
        ],
        timeline: [
          {
            bucket_unix_ms: 111,
            requests: 9,
            total_tokens: 900,
            cache_creation_tokens: 11,
            cache_read_tokens: 12,
          },
        ],
      },
    })
  })
})
