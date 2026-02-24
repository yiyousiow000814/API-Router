import type { Config, UsageStatistics } from '../types'

export function buildDevUsageStatistics(params: {
  now: number
  usageWindowHours: number
  usageFilterProviders: string[]
  usageFilterModels: string[]
  usageFilterOrigins: string[]
  config?: Config | null
}): UsageStatistics {
  const { now, usageWindowHours, usageFilterProviders, usageFilterModels, usageFilterOrigins, config = null } = params
  const normalizedProviderFilters = usageFilterProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean)
  const includeProvider =
    normalizedProviderFilters.length === 0
      ? (_provider: string) => true
      : (provider: string) => normalizedProviderFilters.includes(provider.trim().toLowerCase())
  const normalizedOrigins = usageFilterOrigins.map((origin) => origin.trim().toLowerCase()).filter(Boolean)
  const includeOrigin = (origin: string) => normalizedOrigins.length === 0 || normalizedOrigins.includes(origin)
  const orderedProviderNames = (() => {
    const providerMap = config?.providers ?? {}
    const all = Object.keys(providerMap).filter((name) => {
      if (name === 'official') return false
      return !providerMap[name]?.disabled
    })
    const ordered = (config?.provider_order ?? []).filter((name) => all.includes(name))
    const leftovers = all.filter((name) => !ordered.includes(name)).sort((a, b) => a.localeCompare(b))
    const merged = [...ordered, ...leftovers]
    return merged.length ? merged : ['provider_1', 'provider_2']
  })()
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
    const cacheCreationTokens = Math.max(0, Math.round((index % 5 === 0 ? 140 : 0) * usageOriginFactor))
    const cacheReadTokens = Math.max(0, Math.round((index % 3 === 0 ? 320 : 80) * usageOriginFactor))
    return {
      bucket_unix_ms:
        now -
        (usageWindowHours <= 48 ? (timelineCount - 1 - index) * 60 * 60 * 1000 : (timelineCount - 1 - index) * 24 * 60 * 60 * 1000),
      requests,
      total_tokens: Math.max(100, Math.round((3200 + Math.cos(index / 2.2) * 1600) * usageOriginFactor)),
      cache_creation_tokens: cacheCreationTokens,
      cache_read_tokens: cacheReadTokens,
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

  const providerRowsRaw = orderedProviderNames.flatMap((providerName, index) => {
    const providerCfg = config?.providers?.[providerName]
    const apiKeyRef = (providerCfg?.key_preview ?? '').trim() || `sk-dev********p${index + 1}`
    const totalRequests = Math.max(8, 180 - index * 36)
    const totalTokens = totalRequests * Math.max(380, 640 - index * 80)
    const avgCost = Math.max(0.015, 0.08 - index * 0.01)
    const windowsRequests = Math.max(1, Math.round(totalRequests * 0.67))
    const wslRequests = Math.max(1, totalRequests - windowsRequests)
    const windowsTokens = Math.max(1, Math.round(totalTokens * 0.67))
    const wslTokens = Math.max(1, totalTokens - windowsTokens)
    return [
      {
        provider: providerName,
        api_key_ref: apiKeyRef,
        origin: 'windows',
        requests: windowsRequests,
        total_tokens: windowsTokens,
        estimated_total_cost_usd: Number((windowsRequests * avgCost).toFixed(2)),
        estimated_avg_request_cost_usd: Number(avgCost.toFixed(3)),
        estimated_cost_request_count: windowsRequests,
        pricing_source: 'manual_per_request',
      },
      {
        provider: providerName,
        api_key_ref: apiKeyRef,
        origin: 'wsl2',
        requests: wslRequests,
        total_tokens: wslTokens,
        estimated_total_cost_usd: Number((wslRequests * avgCost).toFixed(2)),
        estimated_avg_request_cost_usd: Number(avgCost.toFixed(3)),
        estimated_cost_request_count: wslRequests,
        pricing_source: 'manual_per_request',
      },
    ]
  })

  const byProvider = providerRowsRaw
    .filter((row) => includeOrigin(row.origin))
    .filter((row) => includeProvider(row.provider))

  const totalRequests = byProvider.reduce((sum, row) => sum + row.requests, 0)
  const totalTokens = byProvider.reduce((sum, row) => sum + row.total_tokens, 0)
  const totalCost = byProvider.reduce((sum, row) => sum + row.estimated_total_cost_usd, 0)
  const totalCacheCreation = timeline.reduce((sum, row) => sum + (row.cache_creation_tokens ?? 0), 0)
  const totalCacheRead = timeline.reduce((sum, row) => sum + (row.cache_read_tokens ?? 0), 0)

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
      providers: orderedProviderNames,
      models: ['gpt-5.x', 'gpt-4.1'],
      origins: ['windows', 'wsl2'],
    },
    bucket_seconds: usageWindowHours <= 48 ? 3600 : 86400,
    summary: {
      total_requests: totalRequests,
      total_tokens: totalTokens,
      cache_creation_tokens: totalCacheCreation,
      cache_read_tokens: totalCacheRead,
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
