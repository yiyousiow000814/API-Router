import type { UsagePricingGroup, UsagePricingMode } from '../types/usage'
import type { Config, UsageStatistics } from '../types'

type UsageProviderRow = UsageStatistics['summary']['by_provider'][number]

export function buildUsageProviderFilterOptions(usageCatalogProviders: string[]): string[] {
  return [...usageCatalogProviders].sort((a, b) => a.localeCompare(b))
}

export function buildUsageModelFilterOptions(usageCatalogModels: string[]): string[] {
  return [...usageCatalogModels].sort((a, b) => a.localeCompare(b))
}

export function buildUsageOriginFilterOptions(usageCatalogOrigins: string[]): string[] {
  const required = ['windows', 'wsl2']
  const merged = new Set<string>([...required, ...usageCatalogOrigins])
  return [...merged].sort((a, b) => a.localeCompare(b))
}

export function sanitizeSelectedFilterValues(selected: string[], options: string[]): string[] {
  return selected.filter((name) => options.includes(name))
}

export function usageProviderRowKey(row: UsageProviderRow): string {
  const provider = String(row.provider)
  const keyRef = String(row.api_key_ref ?? '').trim() || '-'
  return `${provider}::${keyRef}`
}

const isSharedAccountSource = (sourceRaw?: string | null): boolean => {
  const source = (sourceRaw ?? '').trim().toLowerCase()
  if (!source || source === 'none') return false
  return (
    source.startsWith('manual_package_') ||
    source === 'token_rate' ||
    source === 'provider_token_rate' ||
    source.startsWith('provider_budget_api')
  )
}

export function buildUsageSharedCostView(usageByProvider: UsageProviderRow[]): {
  zeroRowKeys: Set<string>
  effectiveDailyByRowKey: Map<string, number | null>
  effectiveTotalByRowKey: Map<string, number | null>
} {
  const keyMap = new Map<string, UsageProviderRow[]>()
  usageByProvider.forEach((row) => {
    if (!isSharedAccountSource(row.pricing_source)) return
    const apiKeyRef = String(row.api_key_ref ?? '').trim()
    if (!apiKeyRef || apiKeyRef === '-') return
    const arr = keyMap.get(apiKeyRef) ?? []
    arr.push(row)
    keyMap.set(apiKeyRef, arr)
  })

  const zeroRowKeys = new Set<string>()
  for (const rows of keyMap.values()) {
    if (rows.length <= 1) continue
    const keeper =
      [...rows].sort(
        (a, b) =>
          (b.requests ?? 0) - (a.requests ?? 0) ||
          String(a.api_key_ref ?? '').localeCompare(String(b.api_key_ref ?? '')) ||
          String(a.provider).localeCompare(String(b.provider)),
      )[0] ?? rows[0]
    rows.forEach((row) => {
      if (usageProviderRowKey(row) !== usageProviderRowKey(keeper)) {
        zeroRowKeys.add(usageProviderRowKey(row))
      }
    })
  }

  const effectiveDailyByRowKey = new Map<string, number | null>()
  const effectiveTotalByRowKey = new Map<string, number | null>()
  usageByProvider.forEach((row) => {
    const rowKey = usageProviderRowKey(row)
    const zeroed = zeroRowKeys.has(rowKey)
    const daily = zeroed
      ? 0
      : row.estimated_daily_cost_usd != null && Number.isFinite(row.estimated_daily_cost_usd)
        ? Number(row.estimated_daily_cost_usd)
        : null
    const total = zeroed
      ? 0
      : row.total_used_cost_usd != null && Number.isFinite(row.total_used_cost_usd)
        ? Number(row.total_used_cost_usd)
        : null
    effectiveDailyByRowKey.set(rowKey, daily)
    effectiveTotalByRowKey.set(rowKey, total)
  })

  return {
    zeroRowKeys,
    effectiveDailyByRowKey,
    effectiveTotalByRowKey,
  }
}

export function buildUsageProviderDisplayGroups(
  usageByProvider: UsageProviderRow[],
  usageSharedCostView: {
    effectiveDailyByRowKey: Map<string, number | null>
    effectiveTotalByRowKey: Map<string, number | null>
  },
): Array<{
  id: string
  providers: string[]
  rows: UsageProviderRow[]
  displayName: string
  detailLabel: string
  requests: number
  totalTokens: number
  tokensPerRequest: number | null
  estimatedAvgRequestCostUsd: number | null
  usdPerMillionTokens: number | null
  effectiveDaily: number | null
  effectiveTotal: number | null
  pricingSource: string | null
}> {
  const groups = new Map<
    string,
    {
      apiKeyRef: string
      providers: string[]
      rows: UsageProviderRow[]
    }
  >()
  usageByProvider.forEach((row) => {
    const provider = String(row.provider)
    const apiKeyRef = String(row.api_key_ref ?? '').trim()
    const groupKey = apiKeyRef && apiKeyRef !== '-' ? `key:${apiKeyRef}` : `provider:${provider}`
    const existing = groups.get(groupKey)
    if (existing) {
      if (!existing.providers.includes(provider)) existing.providers.push(provider)
      existing.rows.push(row)
    } else {
      groups.set(groupKey, {
        apiKeyRef,
        providers: [provider],
        rows: [row],
      })
    }
  })

  return Array.from(groups.values()).map((group) => {
    const requests = group.rows.reduce((sum, row) => sum + (row.requests ?? 0), 0)
    const totalTokens = group.rows.reduce((sum, row) => sum + (row.total_tokens ?? 0), 0)
    const effectiveDailyValues = group.rows
      .map((row) => usageSharedCostView.effectiveDailyByRowKey.get(usageProviderRowKey(row)))
      .filter((value): value is number => value != null && Number.isFinite(value))
    const effectiveTotalValues = group.rows
      .map((row) => usageSharedCostView.effectiveTotalByRowKey.get(usageProviderRowKey(row)))
      .filter((value): value is number => value != null && Number.isFinite(value))
    const effectiveTotal =
      effectiveTotalValues.length > 0 ? effectiveTotalValues.reduce((sum, value) => sum + value, 0) : null
    const pricingSources = Array.from(
      new Set(group.rows.map((row) => String(row.pricing_source ?? '').trim()).filter(Boolean)),
    )
    const groupId = `${group.providers.join('|')}::${group.apiKeyRef || '-'}`
    return {
      id: groupId,
      providers: group.providers,
      rows: group.rows,
      displayName: group.providers.join(' / '),
      detailLabel: group.apiKeyRef && group.apiKeyRef !== '-' ? group.apiKeyRef : '-',
      requests,
      totalTokens,
      tokensPerRequest: requests > 0 ? totalTokens / requests : null,
      estimatedAvgRequestCostUsd: effectiveTotal != null && requests > 0 ? effectiveTotal / requests : null,
      usdPerMillionTokens: totalTokens > 0 && effectiveTotal != null ? (effectiveTotal * 1_000_000) / totalTokens : null,
      effectiveDaily: effectiveDailyValues.length > 0 ? effectiveDailyValues.reduce((sum, value) => sum + value, 0) : null,
      effectiveTotal,
      pricingSource: pricingSources.length === 1 ? pricingSources[0] : pricingSources.length > 1 ? 'mixed' : null,
    }
  })
}

export function computeUsageProviderTotalsAndAverages(
  usageByProvider: UsageProviderRow[],
  usageSharedCostView: {
    zeroRowKeys: Set<string>
    effectiveDailyByRowKey: Map<string, number | null>
    effectiveTotalByRowKey: Map<string, number | null>
  },
): {
  totalReq: number
  totalTok: number
  totalTokPerReq: number | null
  avgUsdPerReq: number | null
  avgUsdPerMillion: number | null
  avgEstDaily: number | null
  avgTotalUsed: number | null
} | null {
  if (!usageByProvider.length) return null
  const totalReq = usageByProvider.reduce((sum, row) => sum + (row.requests ?? 0), 0)
  const totalTok = usageByProvider.reduce((sum, row) => sum + (row.total_tokens ?? 0), 0)
  const totalTokPerReq = totalReq > 0 ? totalTok / totalReq : null
  const mean = (values: Array<number | null | undefined>) => {
    const valid = values.filter((v): v is number => Number.isFinite(v as number))
    if (!valid.length) return null
    return valid.reduce((sum, value) => sum + value, 0) / valid.length
  }
  return {
    totalReq,
    totalTok,
    totalTokPerReq,
    avgUsdPerReq: mean(usageByProvider.map((row) => row.estimated_avg_request_cost_usd)),
    avgUsdPerMillion: mean(usageByProvider.map((row) => row.usd_per_million_tokens)),
    avgEstDaily: mean(
      usageByProvider
        .filter((row) => !usageSharedCostView.zeroRowKeys.has(usageProviderRowKey(row)))
        .map((row) => usageSharedCostView.effectiveDailyByRowKey.get(usageProviderRowKey(row))),
    ),
    avgTotalUsed: mean(
      usageByProvider
        .filter((row) => !usageSharedCostView.zeroRowKeys.has(usageProviderRowKey(row)))
        .map((row) => usageSharedCostView.effectiveTotalByRowKey.get(usageProviderRowKey(row))),
    ),
  }
}

export function buildUsagePricingGroups(
  usagePricingProviderNames: string[],
  config: Config | null,
  providerApiKeyLabel: (providerName: string) => string,
): UsagePricingGroup[] {
  const modePriority = (providerName: string) => {
    const mode = (config?.providers?.[providerName]?.manual_pricing_mode ?? 'none') as UsagePricingMode
    if (mode === 'package_total') return 2
    if (mode === 'per_request') return 1
    return 0
  }
  const groups = new Map<string, string[]>()
  usagePricingProviderNames.forEach((providerName) => {
    const keyLabel = providerApiKeyLabel(providerName).trim()
    const groupKey =
      keyLabel && keyLabel !== '-' && keyLabel !== 'set' ? `key:${keyLabel}` : `provider:${providerName}`
    const members = groups.get(groupKey) ?? []
    members.push(providerName)
    groups.set(groupKey, members)
  })
  return Array.from(groups.values()).map((providers) => {
    const primaryProvider =
      [...providers].sort((a, b) => modePriority(b) - modePriority(a) || a.localeCompare(b))[0] ?? providers[0]
    return {
      id: providers.join('|'),
      providers,
      primaryProvider,
      displayName: providers.join(' / '),
      keyLabel: providerApiKeyLabel(primaryProvider),
    }
  })
}
