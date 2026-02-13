import type { UsageStatistics } from '../types'

export function buildDevUsageStatistics(params: {
  now: number
  usageWindowHours: number
  usageFilterProviders: string[]
  usageFilterModels: string[]
}): UsageStatistics {
  const { now, usageWindowHours, usageFilterProviders, usageFilterModels } = params
  const timelineCount = usageWindowHours <= 48 ? 24 : 7
  const timeline = Array.from({ length: timelineCount }).map((_, index) => {
    const requests = Math.max(1, Math.round(6 + Math.sin(index / 2) * 4))
    return {
      bucket_unix_ms:
        now -
        (usageWindowHours <= 48 ? (timelineCount - 1 - index) * 60 * 60 * 1000 : (timelineCount - 1 - index) * 24 * 60 * 60 * 1000),
      requests,
      total_tokens: Math.max(100, Math.round(3200 + Math.cos(index / 2.2) * 1600)),
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    }
  })
  // Ensure dev preview always has at least one clear anomaly candidate.
  const spikeIndex = Math.max(0, timelineCount - 3)
  timeline[spikeIndex].requests = 72
  timeline[spikeIndex].total_tokens = 21500

  return {
    ok: true,
    generated_at_unix_ms: now,
    window_hours: usageWindowHours,
    filter: {
      providers: usageFilterProviders,
      models: usageFilterModels,
    },
    catalog: {
      providers: ['provider_1', 'provider_2'],
      models: ['gpt-5.x', 'gpt-4.1'],
    },
    bucket_seconds: usageWindowHours <= 48 ? 3600 : 86400,
    summary: {
      total_requests: 222,
      total_tokens: 131800,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      unique_models: 2,
      estimated_total_cost_usd: 9.24,
      estimated_daily_cost_usd: 9.24,
      by_model: [
        {
          model: 'gpt-5.x',
          requests: 180,
          input_tokens: 70000,
          output_tokens: 40000,
          total_tokens: 110000,
          share_pct: 81.08,
          estimated_total_cost_usd: 7.42,
          estimated_avg_request_cost_usd: 0.041,
          estimated_cost_request_count: 180,
        },
        {
          model: 'gpt-4.1',
          requests: 42,
          input_tokens: 14000,
          output_tokens: 7800,
          total_tokens: 21800,
          share_pct: 18.92,
          estimated_total_cost_usd: 1.82,
          estimated_avg_request_cost_usd: 0.043,
          estimated_cost_request_count: 42,
        },
      ],
      by_provider: [
        {
          provider: 'provider_1',
          api_key_ref: 'sk-dev********a11',
          requests: 210,
          total_tokens: 128400,
          estimated_total_cost_usd: 46.2,
          estimated_avg_request_cost_usd: 0.22,
          estimated_cost_request_count: 210,
          pricing_source: 'manual_per_request',
        },
        {
          provider: 'provider_2',
          api_key_ref: 'sk-dev********b22',
          requests: 12,
          total_tokens: 3400,
          estimated_total_cost_usd: 0.36,
          estimated_avg_request_cost_usd: 0.03,
          estimated_cost_request_count: 12,
          pricing_source: 'manual_per_request',
        },
        {
          provider: 'official',
          api_key_ref: 'sk-dev********c33',
          requests: 26,
          total_tokens: 9100,
          estimated_total_cost_usd: 0.52,
          estimated_avg_request_cost_usd: 0.02,
          estimated_cost_request_count: 26,
          pricing_source: 'manual_per_request',
        },
      ],
      timeline,
    },
  }
}
