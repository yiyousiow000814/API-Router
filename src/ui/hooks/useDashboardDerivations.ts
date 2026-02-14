import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useMemo } from 'react'
import type { Config, ProviderSwitchboardStatus, Status, UsageStatistics } from '../types'
import { computeUsageAnomalies } from '../utils/usageAnomalies'
import { buildUsageChartModel, fmtUsageBucketLabel } from '../utils/usageDisplay'
import {
  buildManagedProviderNames,
  buildProviderGroupLabelByName,
  buildProviderNamesByKeyLabel,
  buildSwitchboardModelProviderLabel,
  buildSwitchboardProviderCards,
  linkedProvidersForApiKey as resolveLinkedProvidersForApiKey,
} from '../utils/switchboard'
import {
  buildUsageModelFilterOptions,
  buildUsagePricingGroups,
  buildUsageProviderDisplayGroups,
  buildUsageProviderFilterOptions,
  buildUsageSharedCostView,
  computeUsageProviderTotalsAndAverages,
  usageProviderRowKey,
} from '../utils/usageStatisticsView'

type Params = {
  config: Config | null
  orderedConfigProviders: string[]
  providerSwitchStatus: ProviderSwitchboardStatus | null
  status: Status | null
  providerApiKeyLabel: (providerName: string) => string
  fmtPct: (value: number | null) => string
  fmtAmount: (value: number | null | undefined) => string
  fmtUsd: (value: number | null | undefined) => string
  pctOf: (part?: number | null, total?: number | null) => number | null
  usageStatistics: UsageStatistics | null
  usageFilterProviders: string[]
  setUsageFilterProviders: Dispatch<SetStateAction<string[]>>
  usageFilterModels: string[]
  setUsageFilterModels: Dispatch<SetStateAction<string[]>>
  usageWindowHours: number
  setUsageChartHover: Dispatch<
    SetStateAction<{
      x: number
      y: number
      title: string
      subtitle: string
    } | null>
  >
  formatUsdMaybe: (value: number | null | undefined) => string
}

export function useDashboardDerivations(params: Params) {
  const {
    config,
    orderedConfigProviders,
    providerSwitchStatus,
    status,
    providerApiKeyLabel,
    fmtPct,
    fmtAmount,
    fmtUsd,
    pctOf,
    usageStatistics,
    setUsageFilterProviders,
    setUsageFilterModels,
    usageWindowHours,
    setUsageChartHover,
    formatUsdMaybe,
  } = params

  const managedProviderNames = useMemo(
    () => buildManagedProviderNames(config, orderedConfigProviders, providerSwitchStatus, status),
    [config, orderedConfigProviders, providerSwitchStatus, status],
  )
  const providerGroupLabelByName = useMemo(
    () => buildProviderGroupLabelByName(managedProviderNames, providerApiKeyLabel),
    [managedProviderNames, config],
  )
  const providerNamesByKeyLabel = useMemo(
    () => buildProviderNamesByKeyLabel(managedProviderNames, providerApiKeyLabel),
    [managedProviderNames, config],
  )
  const linkedProvidersForApiKey = useCallback(
    (apiKeyRef: string, fallbackProvider: string): string[] =>
      resolveLinkedProvidersForApiKey(providerNamesByKeyLabel, apiKeyRef, fallbackProvider),
    [providerNamesByKeyLabel],
  )
  const switchboardProviderCards = useMemo(
    () =>
      buildSwitchboardProviderCards(managedProviderNames, config, status, {
        fmtPct,
        fmtAmount,
        fmtUsd,
        pctOf,
      }),
    [config, status, managedProviderNames],
  )

  const switchboardModeLabel = providerSwitchStatus?.mode ?? '-'
  const switchboardModelProviderLabel = useMemo(
    () => buildSwitchboardModelProviderLabel(providerSwitchStatus),
    [providerSwitchStatus],
  )
  const switchboardTargetDirsLabel =
    providerSwitchStatus?.dirs?.map((d) => d.cli_home).join(' | ') || '-'

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
  const usageTotalInputTokens = usageByModel.reduce((sum: number, x) => sum + (x.input_tokens ?? 0), 0)
  const usageTotalOutputTokens = usageByModel.reduce((sum: number, x) => sum + (x.output_tokens ?? 0), 0)
  const usageAvgTokensPerRequest =
    (usageSummary?.total_requests ?? 0) > 0
      ? Math.round((usageSummary?.total_tokens ?? 0) / (usageSummary?.total_requests ?? 1))
      : 0
  const usageTopModel = usageByModel[0] ?? null
  const usageCatalogProviders = usageStatistics?.catalog?.providers ?? []
  const usageCatalogModels = usageStatistics?.catalog?.models ?? []
  const usageProviderFilterOptions = useMemo(
    () => buildUsageProviderFilterOptions(usageCatalogProviders),
    [usageCatalogProviders],
  )
  const usageModelFilterOptions = useMemo(
    () => buildUsageModelFilterOptions(usageCatalogModels),
    [usageCatalogModels],
  )
  const usageSharedCostView = useMemo(() => buildUsageSharedCostView(usageByProvider), [usageByProvider])
  const usageProviderDisplayGroups = useMemo(
    () => buildUsageProviderDisplayGroups(usageByProvider, usageSharedCostView),
    [usageByProvider, usageSharedCostView],
  )
  const usagePricedRequestCount = usageByProvider.reduce((sum: number, row) => {
    const total = usageSharedCostView.effectiveTotalByRowKey.get(usageProviderRowKey(row))
    if (total == null || !Number.isFinite(total) || total <= 0) return sum
    return sum + (row.requests ?? 0)
  }, 0)
  const usageDedupedTotalUsedUsd = usageByProvider.reduce((sum: number, row) => {
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
    const activeBucketCount = usageTimeline.reduce(
      (sum: number, point) => sum + ((point.requests ?? 0) > 0 ? 1 : 0),
      0,
    )
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
  const usageProviderTotalsAndAverages = useMemo(
    () => computeUsageProviderTotalsAndAverages(usageByProvider, usageSharedCostView),
    [usageByProvider, usageSharedCostView],
  )
  const usagePricingProviderNames = managedProviderNames
  const usagePricingGroups = useMemo(
    () => buildUsagePricingGroups(usagePricingProviderNames, config, providerApiKeyLabel),
    [usagePricingProviderNames, config],
  )
  const usageScheduleProviderOptions = managedProviderNames
  const usageAnomalies = useMemo(
    () =>
      computeUsageAnomalies(
        usageTimeline,
        usageByProvider,
        usageStatistics?.window_hours ?? 24,
        usageProviderRowKey,
        formatUsdMaybe,
      ),
    [usageTimeline, usageByProvider, usageStatistics?.window_hours],
  )

  const toggleUsageProviderFilter = useCallback((name: string) => {
    setUsageFilterProviders((prev: string[]) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name],
    )
  }, [])
  const toggleUsageModelFilter = useCallback((name: string) => {
    setUsageFilterModels((prev: string[]) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name],
    )
  }, [])

  const usageChart = useMemo(
    () => buildUsageChartModel(usageTimeline, usageMaxTimelineRequests, usageMaxTimelineTokens),
    [usageTimeline, usageMaxTimelineRequests, usageMaxTimelineTokens],
  )

  function showUsageChartHover(
    event: {
      clientX: number
      clientY: number
      currentTarget: { ownerSVGElement?: SVGSVGElement | null }
    },
    bucketUnixMs: number,
    requests: number,
    totalTokens: number,
  ) {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect) return
    const rawX = event.clientX - rect.left
    const rawY = event.clientY - rect.top
    const maxX = Math.max(8, rect.width - 176)
    const maxY = Math.max(8, rect.height - 54)
    setUsageChartHover({
      x: Math.min(Math.max(rawX + 10, 8), maxX),
      y: Math.min(Math.max(rawY - 42, 8), maxY),
      title: fmtUsageBucketLabel(bucketUnixMs, usageStatistics?.window_hours ?? 24),
      subtitle: `Requests ${requests} | Tokens ${totalTokens.toLocaleString()}`,
    })
  }

  return {
    managedProviderNames,
    providerGroupLabelByName,
    linkedProvidersForApiKey,
    switchboardProviderCards,
    switchboardModeLabel,
    switchboardModelProviderLabel,
    switchboardTargetDirsLabel,
    usageSummary,
    usageTimeline,
    usageByModel,
    usageByProvider,
    usageTotalInputTokens,
    usageTotalOutputTokens,
    usageAvgTokensPerRequest,
    usageTopModel,
    usageProviderFilterOptions,
    usageModelFilterOptions,
    usageProviderDisplayGroups,
    usagePricedRequestCount,
    usageDedupedTotalUsedUsd,
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
    toggleUsageProviderFilter,
    toggleUsageModelFilter,
    usageChart,
    showUsageChartHover,
  }
}
