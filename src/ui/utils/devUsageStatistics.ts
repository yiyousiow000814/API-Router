import type { UsageStatistics } from '../types'

export function buildDevUsageStatistics(params: {
  now: number
  usageWindowHours: number
  usageFilterProviders: string[]
  usageFilterModels: string[]
  usageFilterOrigins: string[]
}): UsageStatistics {
  const { now, usageWindowHours, usageFilterProviders, usageFilterModels, usageFilterOrigins } = params
  const normalizedOrigins = usageFilterOrigins.map((origin) => origin.trim().toLowerCase()).filter(Boolean)
  const includeOrigin = (origin: string) => normalizedOrigins.length === 0 || normalizedOrigins.includes(origin)
  const usageOriginFactor = normalizedOrigins.includes('wsl2')
    ? normalizedOrigins.includes('windows')
      ? 1
      : 0.35
    : normalizedOrigins.includes('windows')
      ? 0.65
      : 1
  const timelineCount = usageWindowHours <= 48 ? 24 : 7
  const timeline = Array.from({ length: timelineCount }).map((_, index) => {
    const requests = Math.max(1, Math.round((6 + Math.sin(index / 2) * 4) * usageOriginFactor))
    return {
      bucket_unix_ms:
        now -
        (usageWindowHours <= 48 ? (timelineCount - 1 - index) * 60 * 60 * 1000 : (timelineCount - 1 - index) * 24 * 60 * 60 * 1000),
      requests,
      total_tokens: Math.max(100, Math.round((3200 + Math.cos(index / 2.2) * 1600) * usageOriginFactor)),
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    }
  })
  // Ensure dev preview always has at least one clear anomaly candidate.
  const spikeIndex = Math.max(0, timelineCount - 3)
  timeline[spikeIndex].requests = Math.max(1, Math.round(72 * usageOriginFactor))
  timeline[spikeIndex].total_tokens = Math.max(100, Math.round(21500 * usageOriginFactor))

  const byModelRaw = [
    {
      model: 'gpt-5.x',
      origin: 'windows',
      requests: 120,
      input_tokens: 46000,
      output_tokens: 24000,
      total_tokens: 70000,
      estimated_total_cost_usd: 4.72,
      estimated_avg_request_cost_usd: 0.039,
      estimated_cost_request_count: 120,
    },
    {
      model: 'gpt-5.x',
      origin: 'wsl2',
      requests: 60,
      input_tokens: 24000,
      output_tokens: 16000,
      total_tokens: 40000,
      estimated_total_cost_usd: 2.7,
      estimated_avg_request_cost_usd: 0.045,
      estimated_cost_request_count: 60,
    },
    {
      model: 'gpt-4.1',
      origin: 'windows',
      requests: 25,
      input_tokens: 9000,
      output_tokens: 5200,
      total_tokens: 14200,
      estimated_total_cost_usd: 1.08,
      estimated_avg_request_cost_usd: 0.043,
      estimated_cost_request_count: 25,
    },
    {
      model: 'gpt-4.1',
      origin: 'wsl2',
      requests: 17,
      input_tokens: 5000,
      output_tokens: 2600,
      total_tokens: 7600,
      estimated_total_cost_usd: 0.74,
      estimated_avg_request_cost_usd: 0.044,
      estimated_cost_request_count: 17,
    },
  ].filter((row) => includeOrigin(row.origin))

  const byModelMap = new Map<
    string,
    {
      model: string
      requests: number
      input_tokens: number
      output_tokens: number
      total_tokens: number
      estimated_total_cost_usd: number
      estimated_avg_request_cost_usd: number
      estimated_cost_request_count: number
    }
  >()
  byModelRaw.forEach((row) => {
    const existing = byModelMap.get(row.model)
    if (existing) {
      existing.requests += row.requests
      existing.input_tokens += row.input_tokens
      existing.output_tokens += row.output_tokens
      existing.total_tokens += row.total_tokens
      existing.estimated_total_cost_usd += row.estimated_total_cost_usd
      existing.estimated_cost_request_count += row.estimated_cost_request_count
      existing.estimated_avg_request_cost_usd =
        existing.estimated_cost_request_count > 0
          ? existing.estimated_total_cost_usd / existing.estimated_cost_request_count
          : 0
      return
    }
    byModelMap.set(row.model, {
      model: row.model,
      requests: row.requests,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      total_tokens: row.total_tokens,
      estimated_total_cost_usd: row.estimated_total_cost_usd,
      estimated_avg_request_cost_usd: row.estimated_avg_request_cost_usd,
      estimated_cost_request_count: row.estimated_cost_request_count,
    })
  })
  const byModel = Array.from(byModelMap.values())
    .sort((a, b) => b.requests - a.requests)
    .map((row) => {
      const totalRequests = byModelRaw.reduce((sum, item) => sum + item.requests, 0)
      const sharePct = totalRequests > 0 ? (row.requests / totalRequests) * 100 : 0
      return {
        ...row,
        share_pct: Number(sharePct.toFixed(2)),
        estimated_total_cost_usd: Number(row.estimated_total_cost_usd.toFixed(2)),
        estimated_avg_request_cost_usd: Number(row.estimated_avg_request_cost_usd.toFixed(3)),
      }
    })

  const byProvider = [
    {
      provider: 'provider_1',
      api_key_ref: 'sk-dev********a11',
      origin: 'windows',
      requests: 140,
      total_tokens: 84000,
      estimated_total_cost_usd: 30.8,
      estimated_avg_request_cost_usd: 0.22,
      estimated_cost_request_count: 140,
      pricing_source: 'manual_per_request',
    },
    {
      provider: 'provider_1',
      api_key_ref: 'sk-dev********a11',
      origin: 'wsl2',
      requests: 70,
      total_tokens: 44400,
      estimated_total_cost_usd: 15.4,
      estimated_avg_request_cost_usd: 0.22,
      estimated_cost_request_count: 70,
      pricing_source: 'manual_per_request',
    },
    {
      provider: 'provider_2',
      api_key_ref: 'sk-dev********b22',
      origin: 'windows',
      requests: 7,
      total_tokens: 2100,
      estimated_total_cost_usd: 0.21,
      estimated_avg_request_cost_usd: 0.03,
      estimated_cost_request_count: 7,
      pricing_source: 'manual_per_request',
    },
    {
      provider: 'provider_2',
      api_key_ref: 'sk-dev********b22',
      origin: 'wsl2',
      requests: 5,
      total_tokens: 1300,
      estimated_total_cost_usd: 0.15,
      estimated_avg_request_cost_usd: 0.03,
      estimated_cost_request_count: 5,
      pricing_source: 'manual_per_request',
    },
    {
      provider: 'official',
      api_key_ref: 'sk-dev********c33',
      origin: 'windows',
      requests: 16,
      total_tokens: 5600,
      estimated_total_cost_usd: 0.32,
      estimated_avg_request_cost_usd: 0.02,
      estimated_cost_request_count: 16,
      pricing_source: 'manual_per_request',
    },
    {
      provider: 'official',
      api_key_ref: 'sk-dev********c33',
      origin: 'wsl2',
      requests: 10,
      total_tokens: 3500,
      estimated_total_cost_usd: 0.2,
      estimated_avg_request_cost_usd: 0.02,
      estimated_cost_request_count: 10,
      pricing_source: 'manual_per_request',
    },
  ].filter((row) => includeOrigin(row.origin))

  const totalRequests = byProvider.reduce((sum, row) => sum + row.requests, 0)
  const totalTokens = byProvider.reduce((sum, row) => sum + row.total_tokens, 0)
  const totalCost = byProvider.reduce((sum, row) => sum + row.estimated_total_cost_usd, 0)

  return {
    ok: true,
    generated_at_unix_ms: now,
    window_hours: usageWindowHours,
    filter: {
      providers: usageFilterProviders,
      models: usageFilterModels,
      origins: usageFilterOrigins,
    },
    catalog: {
      providers: ['provider_1', 'provider_2'],
      models: ['gpt-5.x', 'gpt-4.1'],
      origins: ['windows', 'wsl2'],
    },
    bucket_seconds: usageWindowHours <= 48 ? 3600 : 86400,
    summary: {
      total_requests: totalRequests,
      total_tokens: totalTokens,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      unique_models: byModel.length,
      estimated_total_cost_usd: Number(totalCost.toFixed(2)),
      estimated_daily_cost_usd: Number(totalCost.toFixed(2)),
      by_model: byModel,
      by_provider: byProvider.map((row) => ({
        provider: row.provider,
        api_key_ref: row.api_key_ref,
        requests: row.requests,
        total_tokens: row.total_tokens,
        estimated_total_cost_usd: row.estimated_total_cost_usd,
        estimated_avg_request_cost_usd: row.estimated_avg_request_cost_usd,
        estimated_cost_request_count: row.estimated_cost_request_count,
        pricing_source: row.pricing_source,
      })),
      timeline,
    },
  }
}
