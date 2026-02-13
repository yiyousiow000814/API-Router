import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { Config, UsageStatistics } from '../types'
import './UsageStatisticsPanel.css'
import {
  UsageProviderStatisticsSection,
  type UsageProviderDisplayGroup,
  type UsageProviderTotalsAndAverages,
} from './UsageProviderStatisticsSection'
import {
  UsageTimelineChart,
  type UsageChartHover,
  type UsageChartModel,
} from './UsageTimelineChart'
import { UsageStatsFiltersBar } from './UsageStatsFiltersBar'

type UsageSummary = UsageStatistics['summary']
type UsageProviderRow = UsageSummary['by_provider'][number]

type Props = {
  config: Config | null
  usageWindowHours: number
  setUsageWindowHours: (hours: number) => void
  usageStatisticsLoading: boolean
  usageFilterProviders: string[]
  setUsageFilterProviders: (providers: string[]) => void
  usageProviderFilterOptions: string[]
  toggleUsageProviderFilter: (providerName: string) => void
  usageFilterModels: string[]
  setUsageFilterModels: (models: string[]) => void
  usageModelFilterOptions: string[]
  toggleUsageModelFilter: (modelName: string) => void
  usageAnomalies: {
    messages: string[]
    highCostRowKeys: Set<string>
  }
  usageSummary: UsageSummary | null
  formatKpiTokens: (value: number | null | undefined) => string
  usageTopModel: {
    model: string
    share_pct?: number | null
  } | null
  formatUsdMaybe: (value: number | null | undefined) => string
  usageDedupedTotalUsedUsd: number
  usageTotalInputTokens: number
  usageTotalOutputTokens: number
  usageAvgTokensPerRequest: number
  usageActiveWindowHours: number
  usagePricedRequestCount: number
  usagePricedCoveragePct: number
  usageAvgRequestsPerHour: number
  usageAvgTokensPerHour: number
  usageWindowLabel: string
  usageStatistics: UsageStatistics | null
  fmtWhen: (unixMs: number) => string
  usageChart: UsageChartModel | null
  setUsageChartHover: (hover: UsageChartHover | null) => void
  showUsageChartHover: (
    event: {
      clientX: number
      clientY: number
      currentTarget: { ownerSVGElement?: SVGSVGElement | null }
    },
    bucketUnixMs: number,
    requests: number,
    totalTokens: number,
  ) => void
  usageChartHover: UsageChartHover | null
  formatUsageBucketLabel: (bucketUnixMs: number, windowHours: number) => string
  setUsageHistoryModalOpen: (open: boolean) => void
  setUsagePricingModalOpen: (open: boolean) => void
  usageScheduleProviderOptions: string[]
  usageByProvider: UsageProviderRow[]
  openUsageScheduleModal: (providerName: string, currency: string) => Promise<void>
  providerPreferredCurrency: (providerName: string) => string
  setUsageProviderShowDetails: Dispatch<SetStateAction<boolean>>
  usageProviderShowDetails: boolean
  usageProviderShowDetailsStorageKey: string
  usageProviderDisplayGroups: UsageProviderDisplayGroup[]
  usageProviderRowKey: (row: UsageProviderRow) => string
  formatPricingSource: (source: string | null | undefined) => string
  usageProviderTotalsAndAverages: UsageProviderTotalsAndAverages | null
}

export function UsageStatisticsPanel({
  config,
  usageWindowHours,
  setUsageWindowHours,
  usageStatisticsLoading,
  usageFilterProviders,
  setUsageFilterProviders,
  usageProviderFilterOptions,
  toggleUsageProviderFilter,
  usageFilterModels,
  setUsageFilterModels,
  usageModelFilterOptions,
  toggleUsageModelFilter,
  usageAnomalies,
  usageSummary,
  formatKpiTokens,
  usageTopModel,
  formatUsdMaybe,
  usageDedupedTotalUsedUsd,
  usageTotalInputTokens,
  usageTotalOutputTokens,
  usageAvgTokensPerRequest,
  usageActiveWindowHours,
  usagePricedRequestCount,
  usagePricedCoveragePct,
  usageAvgRequestsPerHour,
  usageAvgTokensPerHour,
  usageWindowLabel,
  usageStatistics,
  fmtWhen,
  usageChart,
  setUsageChartHover,
  showUsageChartHover,
  usageChartHover,
  formatUsageBucketLabel,
  setUsageHistoryModalOpen,
  setUsagePricingModalOpen,
  usageScheduleProviderOptions,
  usageByProvider,
  openUsageScheduleModal,
  providerPreferredCurrency,
  setUsageProviderShowDetails,
  usageProviderShowDetails,
  usageProviderShowDetailsStorageKey,
  usageProviderDisplayGroups,
  usageProviderRowKey,
  formatPricingSource,
  usageProviderTotalsAndAverages,
}: Props) {
  const [dismissedAnomalyMessages, setDismissedAnomalyMessages] = useState<Set<string>>(new Set())
  const anomalyMessages = useMemo(
    () => usageAnomalies.messages.map((message) => message.trim()).filter((message) => message.length > 0),
    [usageAnomalies.messages],
  )
  useEffect(() => {
    setDismissedAnomalyMessages((prev) => {
      if (!prev.size) return prev
      const messageSet = new Set(anomalyMessages)
      const next = new Set<string>()
      for (const message of prev) {
        if (messageSet.has(message)) next.add(message)
      }
      return next.size === prev.size ? prev : next
    })
  }, [anomalyMessages])
  const visibleAnomalyMessages = useMemo(
    () => anomalyMessages.filter((message) => !dismissedAnomalyMessages.has(message)),
    [anomalyMessages, dismissedAnomalyMessages],
  )

  return (
    <div className="aoCard aoUsageStatsPage">
      <UsageStatsFiltersBar
        usageWindowHours={usageWindowHours}
        setUsageWindowHours={setUsageWindowHours}
        usageStatisticsLoading={usageStatisticsLoading}
        usageFilterProviders={usageFilterProviders}
        setUsageFilterProviders={setUsageFilterProviders}
        usageProviderFilterOptions={usageProviderFilterOptions}
        toggleUsageProviderFilter={toggleUsageProviderFilter}
        usageFilterModels={usageFilterModels}
        setUsageFilterModels={setUsageFilterModels}
        usageModelFilterOptions={usageModelFilterOptions}
        toggleUsageModelFilter={toggleUsageModelFilter}
      />
      {visibleAnomalyMessages.length ? (
        <div className="aoUsageAnomalyBanner" role="status" aria-live="polite">
          <div className="aoMiniLabel">Anomaly Watch</div>
          {visibleAnomalyMessages.map((message) => (
            <div key={`usage-anomaly-${message}`} className="aoUsageAnomalyItem">
              <div className="aoUsageAnomalyDot" aria-hidden="true" />
              <div className="aoUsageAnomalyText">{message}</div>
              <button
                type="button"
                className="aoUsageAnomalyDismissIcon"
                onClick={() =>
                  setDismissedAnomalyMessages((prev) => {
                    if (prev.has(message)) return prev
                    const next = new Set(prev)
                    next.add(message)
                    return next
                  })
                }
                aria-label="Dismiss anomaly notice"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="aoUsageKpiGrid">
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Total Requests</div>
          <div className="aoUsageKpiValue">{usageSummary?.total_requests?.toLocaleString() ?? '-'}</div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Total Tokens</div>
          <div className="aoUsageKpiValue">{formatKpiTokens(usageSummary?.total_tokens)}</div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Top Model</div>
          <div className="aoUsageKpiValue aoUsageKpiValueSmall">{usageTopModel ? usageTopModel.model : '-'}</div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Total $ Used</div>
          <div className="aoUsageKpiValue">{formatUsdMaybe(usageDedupedTotalUsedUsd)}</div>
        </div>
      </div>
      <div className="aoUsageFactsCard">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Window Details</div>
          <div className="aoHint">Top model share is request share. Priced coverage means calculable-cost requests.</div>
        </div>
        <table className="aoUsageFactsTable">
          <tbody>
            <tr>
              <th>Top Model Share</th>
              <td>{usageTopModel ? `${Math.round(usageTopModel.share_pct ?? 0)}% of requests` : '-'}</td>
              <th>Unique Models</th>
              <td>{usageSummary?.unique_models?.toLocaleString() ?? '-'}</td>
            </tr>
            <tr>
              <th>Input / Output Tokens</th>
              <td>
                {usageTotalInputTokens.toLocaleString()} / {usageTotalOutputTokens.toLocaleString()}
              </td>
              <th>Avg Tokens / Request</th>
              <td>{usageSummary?.total_requests ? usageAvgTokensPerRequest.toLocaleString() : '-'}</td>
            </tr>
            <tr>
              <th>Window Data</th>
              <td>
                {(usageSummary?.total_requests ?? 0).toLocaleString()} captured requests
                {usageActiveWindowHours > 0 ? ` · ${usageActiveWindowHours.toFixed(1)} active h` : ''}
              </td>
              <th>Priced Coverage</th>
              <td>
                {usagePricedRequestCount.toLocaleString()} / {(usageSummary?.total_requests ?? 0).toLocaleString()} req ({usagePricedCoveragePct}%)
              </td>
            </tr>
            <tr>
              <th>Window Pace</th>
              <td>
                {usageAvgRequestsPerHour.toFixed(2)} req/h · {Math.round(usageAvgTokensPerHour).toLocaleString()} tok/h
              </td>
              <th>Selected Window</th>
              <td>{usageWindowLabel}</td>
            </tr>
            <tr>
              <th>Data Freshness</th>
              <td>{usageStatistics?.generated_at_unix_ms ? fmtWhen(usageStatistics.generated_at_unix_ms) : '-'}</td>
              <th>Sample Coverage</th>
              <td>
                {(usageSummary?.total_requests ?? 0).toLocaleString()} req · {usageActiveWindowHours.toFixed(1)} active h
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="aoUsageChartsGrid">
        <div className="aoUsageChartCard">
          <div className="aoSwitchboardSectionHead">
            <div className="aoMiniLabel">Requests Timeline</div>
            <div className="aoHint">
              {usageSummary?.total_requests ? `${usageSummary.total_requests.toLocaleString()} requests in window` : 'No request data yet'}
            </div>
          </div>
          <UsageTimelineChart
            usageChart={usageChart}
            usageChartHover={usageChartHover}
            usageWindowHours={usageStatistics?.window_hours ?? 24}
            formatUsageBucketLabel={formatUsageBucketLabel}
            setUsageChartHover={setUsageChartHover}
            showUsageChartHover={showUsageChartHover}
          />
        </div>
      </div>

      <UsageProviderStatisticsSection
        config={config}
        setUsageHistoryModalOpen={setUsageHistoryModalOpen}
        setUsagePricingModalOpen={setUsagePricingModalOpen}
        usageScheduleProviderOptions={usageScheduleProviderOptions}
        usageByProvider={usageByProvider}
        openUsageScheduleModal={openUsageScheduleModal}
        providerPreferredCurrency={providerPreferredCurrency}
        setUsageProviderShowDetails={setUsageProviderShowDetails}
        usageProviderShowDetails={usageProviderShowDetails}
        usageProviderShowDetailsStorageKey={usageProviderShowDetailsStorageKey}
        usageProviderDisplayGroups={usageProviderDisplayGroups}
        usageProviderRowKey={usageProviderRowKey}
        usageAnomaliesHighCostRowKeys={usageAnomalies.highCostRowKeys}
        formatUsdMaybe={formatUsdMaybe}
        formatPricingSource={formatPricingSource}
        usageProviderTotalsAndAverages={usageProviderTotalsAndAverages}
      />
    </div>
  )
}
