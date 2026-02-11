import { useCallback, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { UsagePricingGroup, UsagePricingMode } from '../appTypes'
import type { UsageStatistics } from '../types'

type UsageByProviderRow = UsageStatistics['summary']['by_provider'][number]

export type UsageChartHover = {
  x: number
  y: number
  title: string
  subtitle: string
}

type UsageViewModelArgs = {
  usageStatistics: UsageStatistics | null
  usageWindowHours: number
  managedProviderNames: string[]
  providerApiKeyLabel: (providerName: string) => string
  configProviders: Record<string, { manual_pricing_mode?: 'per_request' | 'package_total' | null } | undefined>
  setUsageChartHover: Dispatch<SetStateAction<UsageChartHover | null>>
}

function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    const c1x = p1.x + (p2.x - p0.x) / 6
    const yMin = Math.min(p1.y, p2.y)
    const yMax = Math.max(p1.y, p2.y)
    const c1y = clamp(p1.y + (p2.y - p0.y) / 6, yMin, yMax)
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = clamp(p2.y - (p3.y - p1.y) / 6, yMin, yMax)
    path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`
  }
  return path
}

export function useUsageViewModel({
  usageStatistics,
  usageWindowHours,
  managedProviderNames,
  providerApiKeyLabel,
  configProviders,
  setUsageChartHover,
}: UsageViewModelArgs) {
  const usageSummary = usageStatistics?.summary ?? null
  const usageTimelineRaw = usageSummary?.timeline ?? []
  const usageTimeline = useMemo(
    () => [...usageTimelineRaw].sort((a, b) => a.bucket_unix_ms - b.bucket_unix_ms),
    [usageTimelineRaw],
  )
  const usageByModel = usageSummary?.by_model ?? []
  const usageByProvider = usageSummary?.by_provider ?? []
  const usageMaxTimelineRequests = Math.max(1, ...usageTimeline.map((x) => x.requests ?? 0))
  const usageMaxTimelineTokens = Math.max(1, ...usageTimeline.map((x) => x.total_tokens ?? 0))
  const usageTotalInputTokens = usageByModel.reduce((sum, x) => sum + (x.input_tokens ?? 0), 0)
  const usageTotalOutputTokens = usageByModel.reduce((sum, x) => sum + (x.output_tokens ?? 0), 0)
  const usageAvgTokensPerRequest =
    (usageSummary?.total_requests ?? 0) > 0
      ? Math.round((usageSummary?.total_tokens ?? 0) / (usageSummary?.total_requests ?? 1))
      : 0
  const usageTopModel = usageByModel[0] ?? null
  const usageCatalogProviders = usageStatistics?.catalog?.providers ?? []
  const usageCatalogModels = usageStatistics?.catalog?.models ?? []
  const usageProviderFilterOptions = useMemo(
    () => [...usageCatalogProviders].sort((a, b) => a.localeCompare(b)),
    [usageCatalogProviders],
  )
  const usageModelFilterOptions = useMemo(
    () => [...usageCatalogModels].sort((a, b) => a.localeCompare(b)),
    [usageCatalogModels],
  )
  const usageProviderRowKey = (row: UsageByProviderRow) => {
    const provider = String(row.provider)
    const keyRef = String(row.api_key_ref ?? '').trim() || '-'
    return `${provider}::${keyRef}`
  }
  const usageSharedCostView = useMemo(() => {
    const isSharedAccountSource = (sourceRaw?: string | null) => {
      const source = (sourceRaw ?? '').trim().toLowerCase()
      if (!source || source === 'none') return false
      return (
        source.startsWith('manual_package_') ||
        source === 'token_rate' ||
        source === 'provider_token_rate' ||
        source.startsWith('provider_budget_api')
      )
    }
    const keyMap = new Map<string, UsageByProviderRow[]>()
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
  }, [usageByProvider])
  const usageProviderDisplayGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        apiKeyRef: string
        providers: string[]
        rows: UsageByProviderRow[]
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
        effectiveTotalValues.length > 0
          ? effectiveTotalValues.reduce((sum, value) => sum + value, 0)
          : null
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
        effectiveDaily:
          effectiveDailyValues.length > 0 ? effectiveDailyValues.reduce((sum, value) => sum + value, 0) : null,
        effectiveTotal,
        pricingSource:
          pricingSources.length === 1 ? pricingSources[0] : pricingSources.length > 1 ? 'mixed' : null,
      }
    })
  }, [usageByProvider, usageSharedCostView])
  const usagePricedRequestCount = usageByProvider.reduce((sum, row) => {
    const total = usageSharedCostView.effectiveTotalByRowKey.get(usageProviderRowKey(row))
    if (total == null || !Number.isFinite(total) || total <= 0) {
      return sum
    }
    return sum + (row.requests ?? 0)
  }, 0)
  const usageDedupedTotalUsedUsd = usageByProvider.reduce((sum, row) => {
    const total = usageSharedCostView.effectiveTotalByRowKey.get(usageProviderRowKey(row))
    if (total != null && Number.isFinite(total) && total > 0) return sum + total
    return sum
  }, 0)
  const usagePricedCoveragePct =
    (usageSummary?.total_requests ?? 0) > 0
      ? Math.round((usagePricedRequestCount / (usageSummary?.total_requests ?? 1)) * 100)
      : 0
  const usageActiveWindowHours = useMemo(() => {
    const summaryActiveHours = usageSummary?.active_window_hours
    if (summaryActiveHours != null && Number.isFinite(summaryActiveHours) && summaryActiveHours > 0) {
      return summaryActiveHours
    }
    const bucketSeconds = usageStatistics?.bucket_seconds ?? 0
    if (bucketSeconds <= 0) return 0
    const activeBucketCount = usageTimeline.reduce((sum, point) => sum + ((point.requests ?? 0) > 0 ? 1 : 0), 0)
    if (activeBucketCount <= 0) return 0
    return (activeBucketCount * bucketSeconds) / 3600
  }, [usageSummary?.active_window_hours, usageTimeline, usageStatistics?.bucket_seconds])
  const usageAvgRequestsPerHour =
    (usageSummary?.total_requests ?? 0) > 0 && usageActiveWindowHours > 0
      ? (usageSummary?.total_requests ?? 0) / usageActiveWindowHours
      : 0
  const usageAvgTokensPerHour =
    (usageSummary?.total_tokens ?? 0) > 0 && usageActiveWindowHours > 0
      ? (usageSummary?.total_tokens ?? 0) / usageActiveWindowHours
      : 0
  const usageWindowLabel = useMemo(() => {
    if (usageWindowHours === 24) return '24 hours'
    if (usageWindowHours === 7 * 24) return '7 days'
    if (usageWindowHours === 30 * 24) return '1 month'
    return `${usageWindowHours} hours`
  }, [usageWindowHours])
  const usageProviderTotalsAndAverages = useMemo(() => {
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
  }, [usageByProvider, usageSharedCostView])
  const usagePricingProviderNames = managedProviderNames
  const usagePricingGroups = useMemo<UsagePricingGroup[]>(() => {
    const modePriority = (providerName: string) => {
      const mode = (configProviders[providerName]?.manual_pricing_mode ?? 'none') as UsagePricingMode
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
  }, [usagePricingProviderNames, configProviders, providerApiKeyLabel])
  const usageScheduleProviderOptions = managedProviderNames
  const usageAnomalies = useMemo(() => {
    const messages: string[] = []
    const highCostRowKeys = new Set<string>()
    const isPerRequestComparableSource = (sourceRaw?: string | null) => {
      const source = (sourceRaw ?? '').trim().toLowerCase()
      if (!source || source === 'none') return false
      return (
        source === 'manual_per_request' ||
        source === 'manual_per_request_timeline' ||
        source === 'gap_fill_per_request'
      )
    }
    const formatBucket = (unixMs: number) => {
      const d = new Date(unixMs)
      const pad = (n: number) => String(n).padStart(2, '0')
      if ((usageStatistics?.window_hours ?? 24) <= 48) return `${pad(d.getHours())}:00`
      return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}`
    }

    const reqValues = usageTimeline
      .map((point) => point.requests ?? 0)
      .filter((value) => value > 0)
      .sort((a, b) => a - b)
    if (reqValues.length >= 4) {
      const providerCount = Math.max(1, usageByProvider.length)
      const mid = Math.floor(reqValues.length / 2)
      const reqMedian = reqValues.length % 2 === 0 ? (reqValues[mid - 1] + reqValues[mid]) / 2 : reqValues[mid]
      const peakPoint = usageTimeline.reduce(
        (best, point) => ((point.requests ?? 0) > (best?.requests ?? 0) ? point : best),
        usageTimeline[0],
      )
      const peakReq = peakPoint?.requests ?? 0
      const medianPerProvider = reqMedian / providerCount
      const peakPerProvider = peakReq / providerCount
      if (medianPerProvider > 0 && peakPerProvider >= medianPerProvider * 5) {
        messages.push(
          `Request spike around ${formatBucket(peakPoint.bucket_unix_ms)}: ${peakPerProvider.toFixed(1)}/provider vs median ${medianPerProvider.toFixed(1)}/provider`,
        )
      }
    }

    const priceValues = usageByProvider
      .filter(
        (row) =>
          isPerRequestComparableSource(row.pricing_source) &&
          row.estimated_avg_request_cost_usd != null &&
          Number.isFinite(row.estimated_avg_request_cost_usd) &&
          (row.estimated_avg_request_cost_usd ?? 0) > 0 &&
          (row.requests ?? 0) >= 3,
      )
      .map((row) => row.estimated_avg_request_cost_usd as number)
      .sort((a, b) => a - b)
    if (priceValues.length >= 2) {
      const mid = Math.floor(priceValues.length / 2)
      const priceMedian = priceValues.length % 2 === 0 ? (priceValues[mid - 1] + priceValues[mid]) / 2 : priceValues[mid]
      usageByProvider.forEach((row) => {
        if (!isPerRequestComparableSource(row.pricing_source)) return
        const value = row.estimated_avg_request_cost_usd
        if (value == null || !Number.isFinite(value) || value <= 0) return
        if ((row.requests ?? 0) < 3) return
        if (priceMedian > 0 && value >= priceMedian * 2 && value - priceMedian >= 0.05) {
          highCostRowKeys.add(usageProviderRowKey(row))
          messages.push(`High $/req: ${row.provider} at ${fmtUsdMaybe(value)} vs median ${fmtUsdMaybe(priceMedian)}`)
        }
      })
    }

    return { messages, highCostRowKeys }
  }, [usageTimeline, usageByProvider, usageStatistics?.window_hours])

  const usageChart = useMemo(() => {
    if (!usageTimeline.length) return null
    const w = 1000
    const h = 220
    const padL = 26
    const padR = 14
    const padT = 16
    const padB = 34
    const plotW = w - padL - padR
    const plotH = h - padT - padB
    const n = usageTimeline.length
    const step = n > 1 ? plotW / (n - 1) : 0
    const barW = Math.max(8, Math.min(24, Math.floor((plotW / Math.max(n, 1)) * 0.55)))
    const hoverW = n > 1 ? Math.max(12, step) : Math.max(24, barW * 2)
    const yBase = padT + plotH
    const points = usageTimeline.map((point, index) => {
      const x = padL + (n === 1 ? plotW / 2 : index * step)
      const reqH = Math.max(2, Math.round((point.requests / usageMaxTimelineRequests) * plotH))
      const barY = yBase - reqH
      const tokenY = yBase - Math.round((point.total_tokens / usageMaxTimelineTokens) * plotH)
      return { point, x, barY, reqH, tokenY }
    })
    const linePath = buildSmoothPath(points.map((p) => ({ x: p.x, y: p.tokenY })))
    const tickIndexes = Array.from(new Set([0, Math.floor((n - 1) / 2), n - 1]))
    return { w, h, yBase, points, linePath, tickIndexes, barW, hoverW }
  }, [usageTimeline, usageMaxTimelineRequests, usageMaxTimelineTokens])

  function fmtKpiTokens(value?: number | null): string {
    if (value == null || !Number.isFinite(value) || value < 0) return '-'
    if (value >= 1_000_000_000_000) {
      const compact = value / 1_000_000_000_000
      const rounded = compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)
      return rounded.replace(/\.0$/, '') + 'T'
    }
    if (value >= 1_000_000_000) {
      const compact = value / 1_000_000_000
      const rounded = compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)
      return rounded.replace(/\.0$/, '') + 'B'
    }
    if (value >= 10_000_000) {
      const compact = value / 1_000_000
      const rounded = compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)
      return rounded.replace(/\.0$/, '') + 'M'
    }
    return Math.round(value).toLocaleString()
  }

  function fmtUsdMaybe(value?: number | null): string {
    if (value == null || !Number.isFinite(value) || value <= 0) return '-'
    return `$${value >= 10 ? value.toFixed(2) : value.toFixed(3)}`
  }

  function fmtPricingSource(source?: string | null): string {
    if (!source || source === 'none') return 'unconfigured'
    if (source === 'token_rate') return 'monthly credit'
    if (source === 'provider_budget_api') return 'monthly credit'
    if (source === 'provider_budget_api+manual_history') return 'monthly credit'
    if (source === 'provider_budget_api_latest_day') return 'monthly credit'
    if (source === 'provider_token_rate') return 'monthly credit'
    if (source === 'manual_per_request') return 'manual'
    if (source === 'manual_per_request_timeline') return 'manual'
    if (source === 'manual_package_total') return 'manual package total'
    if (source === 'manual_package_timeline') return 'scheduled'
    if (source === 'manual_package_timeline+manual_history') return 'scheduled + manual'
    if (source === 'manual_history') return 'history manual'
    if (source === 'gap_fill_per_request') return 'gap fill $/req'
    if (source === 'gap_fill_total') return 'gap fill total'
    if (source === 'gap_fill_per_day_average') return 'gap fill $/day'
    return source
  }

  function fmtUsageBucketLabel(unixMs: number): string {
    const d = new Date(unixMs)
    const pad = (n: number) => String(n).padStart(2, '0')
    if ((usageStatistics?.window_hours ?? 24) <= 48) return `${pad(d.getHours())}:00`
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}`
  }

  const showUsageChartHover = useCallback(
    (
      event: {
        clientX: number
        clientY: number
        currentTarget: { ownerSVGElement?: SVGSVGElement | null }
      },
      bucketUnixMs: number,
      requests: number,
      totalTokens: number,
    ) => {
      const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
      if (!rect) return
      const rawX = event.clientX - rect.left
      const rawY = event.clientY - rect.top
      const maxX = Math.max(8, rect.width - 176)
      const maxY = Math.max(8, rect.height - 54)
      setUsageChartHover({
        x: Math.min(Math.max(rawX + 10, 8), maxX),
        y: Math.min(Math.max(rawY - 42, 8), maxY),
        title: fmtUsageBucketLabel(bucketUnixMs),
        subtitle: `Requests ${requests} | Tokens ${totalTokens.toLocaleString()}`,
      })
    },
    [setUsageChartHover, usageStatistics?.window_hours],
  )

  return {
    usageSummary,
    usageByProvider,
    usageTopModel,
    usageProviderFilterOptions,
    usageModelFilterOptions,
    usageProviderRowKey,
    usageProviderDisplayGroups,
    usageDedupedTotalUsedUsd,
    usageTotalInputTokens,
    usageTotalOutputTokens,
    usageAvgTokensPerRequest,
    usagePricedRequestCount,
    usagePricedCoveragePct,
    usageActiveWindowHours,
    usageAvgRequestsPerHour,
    usageAvgTokensPerHour,
    usageWindowLabel,
    usageProviderTotalsAndAverages,
    usagePricingProviderNames,
    usagePricingGroups,
    usageScheduleProviderOptions,
    usageAnomalies,
    usageChart,
    fmtUsdMaybe,
    fmtKpiTokens,
    fmtPricingSource,
    fmtUsageBucketLabel,
    showUsageChartHover,
  }
}
