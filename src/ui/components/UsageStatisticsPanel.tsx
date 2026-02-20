import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
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
type UsageDetailsTab = 'overview' | 'requests'
type UsageRequestEntry = {
  provider: string
  api_key_ref: string
  model: string
  origin: string
  session_id: string
  unix_ms: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}
type UsageRequestEntriesResponse = {
  ok: boolean
  rows: UsageRequestEntry[]
  has_more: boolean
  next_offset: number
}
const USAGE_REQUEST_PAGE_SIZE = 200

function readTestFlagFromLocation(): boolean {
  if (typeof window === 'undefined') return false
  const raw = new URLSearchParams(window.location.search).get('test')
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function buildUsageRequestTestRows(stats: UsageStatistics | null, usageWindowHours: number): UsageRequestEntry[] {
  const summary = stats?.summary
  const totalRequests = Math.max(0, Math.min(800, summary?.total_requests ?? 0))
  if (!summary || totalRequests <= 0) return []
  const providers = summary.by_provider.length
    ? summary.by_provider
        .filter((row) => row.requests > 0)
        .map((row) => ({ provider: row.provider, model: 'unknown', requests: row.requests, apiKeyRef: row.api_key_ref ?? '-' }))
    : [{ provider: 'unknown', model: 'unknown', requests: totalRequests, apiKeyRef: '-' }]
  const models = summary.by_model.length
    ? summary.by_model.filter((row) => row.requests > 0).map((row) => ({ model: row.model, requests: row.requests }))
    : [{ model: 'unknown', requests: totalRequests }]
  const generatedAt = stats?.generated_at_unix_ms ?? Date.now()
  const windowMs = Math.max(1, usageWindowHours) * 60 * 60 * 1000
  const avgTotalTokens = Math.max(1, Math.round((summary.total_tokens || totalRequests * 1200) / totalRequests))
  let seed = (generatedAt + totalRequests * 13) >>> 0
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return seed / 4294967296
  }
  const pick = <T extends { requests: number }>(rows: T[]) => {
    const sum = rows.reduce((acc, row) => acc + Math.max(0, row.requests), 0)
    if (sum <= 0) return rows[0]
    let marker = rand() * sum
    for (const row of rows) {
      marker -= Math.max(0, row.requests)
      if (marker <= 0) return row
    }
    return rows[rows.length - 1]
  }
  const rows: UsageRequestEntry[] = []
  for (let i = 0; i < totalRequests; i += 1) {
    const provider = pick(providers)
    const model = pick(models)
    const origin = i % 2 === 0 ? 'windows' : 'wsl2'
    const total = Math.max(1, Math.round(avgTotalTokens * (0.65 + rand() * 0.8)))
    const input = Math.max(1, Math.round(total * (0.62 + rand() * 0.24)))
    const output = Math.max(0, total - input)
    const cacheCreate = i % 7 === 0 ? Math.max(0, Math.round(total * 0.08)) : 0
    const cacheRead = i % 4 === 0 ? Math.max(0, Math.round(total * 0.1)) : 0
    rows.push({
      provider: provider.provider,
      api_key_ref: provider.apiKeyRef,
      model: model.model,
      origin,
      session_id: `test-session-${(i % 24) + 1}`,
      unix_ms: generatedAt - Math.floor(rand() * windowMs),
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead,
    })
  }
  return rows.sort((a, b) => b.unix_ms - a.unix_ms)
}

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
  usageFilterOrigins: string[]
  setUsageFilterOrigins: (origins: string[]) => void
  usageOriginFilterOptions: string[]
  toggleUsageOriginFilter: (originName: string) => void
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
  forceDetailsTab?: UsageDetailsTab
  showDetailsTabs?: boolean
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
  usageFilterOrigins,
  setUsageFilterOrigins,
  usageOriginFilterOptions,
  toggleUsageOriginFilter,
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
  forceDetailsTab,
  showDetailsTabs = true,
}: Props) {
  const [usageDetailsTab, setUsageDetailsTab] = useState<UsageDetailsTab>('overview')
  const [usageRequestRows, setUsageRequestRows] = useState<UsageRequestEntry[]>([])
  const [usageRequestHasMore, setUsageRequestHasMore] = useState(false)
  const [usageRequestLoading, setUsageRequestLoading] = useState(false)
  const [usageRequestError, setUsageRequestError] = useState('')
  const [usageRequestUsingTestFallback, setUsageRequestUsingTestFallback] = useState(false)
  const usageRequestTestFallbackEnabled = useMemo(() => readTestFlagFromLocation() || import.meta.env.DEV, [])
  const usageRequestTestRows = useMemo(
    () => buildUsageRequestTestRows(usageStatistics, usageWindowHours),
    [usageStatistics, usageWindowHours],
  )
  const [dismissedAnomalyIds, setDismissedAnomalyIds] = useState<Set<string>>(new Set())
  const anomalyEntries = useMemo(
    () => {
      const messageCounts = new Map<string, number>()
      return usageAnomalies.messages
        .map((message) => message.trim())
        .filter((message) => message.length > 0)
        .map((message) => {
          const nextCount = (messageCounts.get(message) ?? 0) + 1
          messageCounts.set(message, nextCount)
          return { id: `${message}::${nextCount}`, message }
        })
    },
    [usageAnomalies.messages],
  )
  useEffect(() => {
    setDismissedAnomalyIds((prev) => {
      if (!prev.size) return prev
      const idSet = new Set(anomalyEntries.map((entry) => entry.id))
      const next = new Set<string>()
      for (const id of prev) {
        if (idSet.has(id)) next.add(id)
      }
      return next.size === prev.size ? prev : next
    })
  }, [anomalyEntries])
  const visibleAnomalyEntries = useMemo(
    () => anomalyEntries.filter((entry) => !dismissedAnomalyIds.has(entry.id)),
    [anomalyEntries, dismissedAnomalyIds],
  )
  const effectiveDetailsTab = forceDetailsTab ?? usageDetailsTab
  useEffect(() => {
    if (effectiveDetailsTab !== 'requests') return
    let cancelled = false
    const fetchRequests = async () => {
      setUsageRequestLoading(true)
      setUsageRequestError('')
      setUsageRequestUsingTestFallback(false)
      try {
        const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
          hours: usageWindowHours,
          providers: usageFilterProviders.length ? usageFilterProviders : null,
          models: usageFilterModels.length ? usageFilterModels : null,
          origins: usageFilterOrigins.length ? usageFilterOrigins : null,
          limit: USAGE_REQUEST_PAGE_SIZE,
          offset: 0,
        })
        if (cancelled) return
        setUsageRequestRows(res.rows ?? [])
        setUsageRequestHasMore(Boolean(res.has_more))
      } catch (e) {
        if (cancelled) return
        if (usageRequestTestFallbackEnabled) {
          const next = usageRequestTestRows.slice(0, USAGE_REQUEST_PAGE_SIZE)
          setUsageRequestRows(next)
          setUsageRequestHasMore(usageRequestTestRows.length > next.length)
          setUsageRequestUsingTestFallback(true)
          setUsageRequestError('')
        } else {
          setUsageRequestRows([])
          setUsageRequestHasMore(false)
          setUsageRequestError(String(e))
        }
      } finally {
        if (!cancelled) setUsageRequestLoading(false)
      }
    }
    void fetchRequests()
    return () => {
      cancelled = true
    }
  }, [
    effectiveDetailsTab,
    usageWindowHours,
    usageFilterProviders,
    usageFilterModels,
    usageFilterOrigins,
    usageRequestTestFallbackEnabled,
    usageRequestTestRows,
  ])

  const loadMoreUsageRequests = async () => {
    if (usageRequestLoading || !usageRequestHasMore) return
    if (usageRequestUsingTestFallback) {
      const merged = usageRequestTestRows.slice(0, usageRequestRows.length + USAGE_REQUEST_PAGE_SIZE)
      setUsageRequestRows(merged)
      setUsageRequestHasMore(merged.length < usageRequestTestRows.length)
      return
    }
    setUsageRequestLoading(true)
    setUsageRequestError('')
    try {
      const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
        hours: usageWindowHours,
        providers: usageFilterProviders.length ? usageFilterProviders : null,
        models: usageFilterModels.length ? usageFilterModels : null,
        origins: usageFilterOrigins.length ? usageFilterOrigins : null,
        limit: USAGE_REQUEST_PAGE_SIZE,
        offset: usageRequestRows.length,
      })
      setUsageRequestRows((prev) => [...prev, ...(res.rows ?? [])])
      setUsageRequestHasMore(Boolean(res.has_more))
    } catch (e) {
      setUsageRequestError(String(e))
    } finally {
      setUsageRequestLoading(false)
    }
  }

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
        usageFilterOrigins={usageFilterOrigins}
        setUsageFilterOrigins={setUsageFilterOrigins}
        usageOriginFilterOptions={usageOriginFilterOptions}
        toggleUsageOriginFilter={toggleUsageOriginFilter}
      />
      {showDetailsTabs ? (
        <div className="aoUsageDetailsTabs" role="tablist" aria-label="Usage details views">
        <button
          type="button"
          role="tab"
          aria-selected={usageDetailsTab === 'overview'}
          className={`aoUsageDetailsTabBtn${usageDetailsTab === 'overview' ? ' is-active' : ''}`}
          onClick={() => setUsageDetailsTab('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={usageDetailsTab === 'requests'}
          className={`aoUsageDetailsTabBtn${usageDetailsTab === 'requests' ? ' is-active' : ''}`}
          onClick={() => setUsageDetailsTab('requests')}
        >
          Requests
        </button>
        </div>
      ) : null}
      {effectiveDetailsTab === 'requests' ? (
        <div className="aoUsageRequestsCard">
          <div className="aoSwitchboardSectionHead">
            <div className="aoMiniLabel">Request Details</div>
            <div className="aoHint">Per-request rows (newest first), aligned with current filters/window.</div>
          </div>
          {usageRequestUsingTestFallback ? (
            <div className="aoHint">Test mode fallback rows are shown because backend request details are unavailable.</div>
          ) : null}
          {usageRequestError ? <div className="aoHint">Failed to load request details: {usageRequestError}</div> : null}
          <div className="aoUsageRequestsTableWrap">
            <table className="aoUsageRequestsTable">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Total</th>
                  <th>Cache Create</th>
                  <th>Cache Read</th>
                  <th>Origin</th>
                  <th>Session</th>
                </tr>
              </thead>
              <tbody>
                {!usageRequestRows.length && !usageRequestLoading ? (
                  <tr>
                    <td colSpan={10} className="aoHint">
                      No request rows in this window.
                    </td>
                  </tr>
                ) : (
                  usageRequestRows.map((row, idx) => (
                    <tr key={`${row.unix_ms}-${row.provider}-${row.session_id}-${idx}`}>
                      <td>{fmtWhen(row.unix_ms)}</td>
                      <td className="aoUsageRequestsMono">{row.provider}</td>
                      <td className="aoUsageRequestsMono">{row.model}</td>
                      <td>{row.input_tokens.toLocaleString()}</td>
                      <td>{row.output_tokens.toLocaleString()}</td>
                      <td>{row.total_tokens.toLocaleString()}</td>
                      <td>{row.cache_creation_input_tokens.toLocaleString()}</td>
                      <td>{row.cache_read_input_tokens.toLocaleString()}</td>
                      <td>{row.origin}</td>
                      <td className="aoUsageRequestsMono">{row.session_id}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="aoUsageRequestsFooter">
            <button
              type="button"
              className="aoTinyBtn"
              onClick={() => {
                if (usageRequestLoading) return
                void loadMoreUsageRequests()
              }}
              disabled={!usageRequestHasMore || usageRequestLoading}
            >
              {usageRequestLoading ? 'Loading...' : usageRequestHasMore ? 'Load 200 more' : 'All loaded'}
            </button>
            <span className="aoHint">{usageRequestRows.length.toLocaleString()} rows loaded</span>
          </div>
        </div>
      ) : null}
      {effectiveDetailsTab === 'overview' ? (
        <>
      {visibleAnomalyEntries.length ? (
        <div className="aoUsageAnomalyBanner" role="status" aria-live="polite">
          <div className="aoMiniLabel">Anomaly Watch</div>
          {visibleAnomalyEntries.map((entry) => (
            <div key={`usage-anomaly-${entry.id}`} className="aoUsageAnomalyItem">
              <div className="aoUsageAnomalyDot" aria-hidden="true" />
              <div className="aoUsageAnomalyText">{entry.message}</div>
              <button
                type="button"
                className="aoUsageAnomalyDismissIcon"
                onClick={() =>
                  setDismissedAnomalyIds((prev) => {
                    if (prev.has(entry.id)) return prev
                    const next = new Set(prev)
                    next.add(entry.id)
                    return next
                  })
                }
                aria-label="Dismiss anomaly notice"
              >
                ✕
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
        </>
      ) : null}
    </div>
  )
}
