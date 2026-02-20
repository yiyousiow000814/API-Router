import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Config, UsageStatistics } from '../types'
import './UsageStatisticsPanel.css'
import './UsageHistoryModal.css'
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
import { useUsageHistoryScrollbar } from '../hooks/useUsageHistoryScrollbar'
import { isNearBottom } from '../utils/scroll'

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
type UsageRequestsPageCache = {
  queryKey: string
  rows: UsageRequestEntry[]
  hasMore: boolean
  usingTestFallback: boolean
}
const usageRequestRowIdentity = (row: UsageRequestEntry) =>
  [
    row.unix_ms,
    row.provider,
    row.api_key_ref,
    row.model,
    row.origin,
    row.session_id,
    row.input_tokens,
    row.output_tokens,
    row.total_tokens,
    row.cache_creation_input_tokens,
    row.cache_read_input_tokens,
  ].join('|')
type UsageRequestColumnFilterKey =
  | 'time'
  | 'provider'
  | 'model'
  | 'input'
  | 'output'
  | 'cacheCreate'
  | 'cacheRead'
  | 'origin'
  | 'session'
type UsageRequestMultiFilterKey = 'provider' | 'model' | 'origin' | 'session'
const USAGE_REQUEST_COLUMN_FILTERS: Array<{
  key: UsageRequestColumnFilterKey
  label: string
  filterable: boolean
}> = [
  { key: 'time', label: 'Time', filterable: true },
  { key: 'provider', label: 'Provider', filterable: true },
  { key: 'model', label: 'Model', filterable: true },
  { key: 'origin', label: 'Origin', filterable: true },
  { key: 'session', label: 'Session', filterable: true },
  { key: 'input', label: 'Input', filterable: false },
  { key: 'output', label: 'Output', filterable: false },
  { key: 'cacheCreate', label: 'Cache Create', filterable: false },
  { key: 'cacheRead', label: 'Cache Read', filterable: false },
]
const USAGE_REQUEST_PAGE_SIZE = 200
const USAGE_REQUEST_GRAPH_SOURCE_LIMIT = 120
const USAGE_REQUEST_TEST_MIN_ROWS = 401
const USAGE_REQUEST_TEST_MIN_WINDOW_HOURS = 24 * 60
const USAGE_REQUEST_GRAPH_COLORS = [
  '#21a8b7',
  '#f2c14d',
  '#ff6a88',
  '#7f7dff',
  '#30c48d',
  '#ff8a3d',
] as const
const isOfficialUsageProvider = (provider: string) => provider.trim().toLowerCase() === 'official'
const compareUsageProvidersForDisplay = (left: string, right: string) => {
  const leftOfficial = isOfficialUsageProvider(left)
  const rightOfficial = isOfficialUsageProvider(right)
  if (leftOfficial !== rightOfficial) return leftOfficial ? -1 : 1
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}
const TEST_CODEX_SESSION_IDS = [
  '019c4578-0f3c-7f82-a4f9-b41a1e65e242',
  '019c03fd-6ea4-7121-961f-9f9b64d2c1b5',
  '019c7f46-c5ec-7e2e-9205-4e00718a524e',
  '019c600a-56f3-77b2-8465-f64a4f0566ec',
  '019c7f4d-b7a5-7add-b7f9-f41049dbe667',
  '019c9f18-3d72-7ce3-a9a1-2fd7f4d9d100',
  '019c9f18-89aa-7b11-bc42-6fbe3dc89002',
  '019ca04e-b5f1-73d8-89fd-13ae6de95021',
] as const
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
let usageRequestsPageCache: UsageRequestsPageCache | null = null

function startOfDayUnixMs(unixMs: number): number {
  const date = new Date(unixMs)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function formatMonthDay(unixMs: number): string {
  const date = new Date(unixMs)
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}`
}

function dayStartToIso(unixMs: number): string {
  const d = new Date(unixMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseDateInputToDayStart(dateText: string): number | null {
  const t = dateText.trim()
  if (!t) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const dt = new Date(year, month - 1, day)
  if (Number.isNaN(dt.getTime())) return null
  if (dt.getFullYear() !== year || dt.getMonth() + 1 !== month || dt.getDate() !== day) return null
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime()
}

function startOfMonthMs(unixMs: number): number {
  const d = new Date(unixMs)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

function addMonths(unixMs: number, delta: number): number {
  const d = new Date(unixMs)
  return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime()
}

function normalizeUsageOrigin(origin: string): 'windows' | 'wsl2' | 'unknown' {
  const lowered = origin.trim().toLowerCase()
  if (lowered.includes('wsl')) return 'wsl2'
  if (lowered.includes('win')) return 'windows'
  return 'unknown'
}

function buildSmoothLinePath(
  points: Array<{ x: number; y: number }>,
  yBounds: { min: number; max: number },
): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`
  const clampY = (value: number) => Math.max(yBounds.min, Math.min(yBounds.max, value))
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = clampY(p1.y + (p2.y - p0.y) / 6)
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = clampY(p2.y - (p3.y - p1.y) / 6)
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
  }
  return d
}

function readTestFlagFromLocation(): boolean {
  if (typeof window === 'undefined') return false
  const raw = new URLSearchParams(window.location.search).get('test')
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function buildUsageRequestTestRows(stats: UsageStatistics | null, usageWindowHours: number): UsageRequestEntry[] {
  const summary = stats?.summary
  const summaryTotalRequests = summary?.total_requests ?? 0
  const baseTotalRequests = Math.max(0, Math.min(800, summaryTotalRequests))
  const totalRequests = Math.max(baseTotalRequests, USAGE_REQUEST_TEST_MIN_ROWS)
  if (totalRequests <= 0) return []
  const providers = summary?.by_provider?.length
    ? summary.by_provider
        .filter((row) => row.requests > 0)
        .map((row) => ({ provider: row.provider, model: 'unknown', requests: row.requests, apiKeyRef: row.api_key_ref ?? '-' }))
    : [{ provider: 'unknown', model: 'unknown', requests: totalRequests, apiKeyRef: '-' }]
  const models = [{ model: 'gpt-5.2-codex', requests: totalRequests }]
  const generatedAt = stats?.generated_at_unix_ms ?? Date.now()
  const windowMs = Math.max(usageWindowHours, USAGE_REQUEST_TEST_MIN_WINDOW_HOURS) * 60 * 60 * 1000
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
    const input = 100_000 + Math.floor(rand() * 900_000)
    const output = 1_000 + Math.floor(rand() * 9_000)
    const total = input + output
    const cacheCreate = i % 7 === 0 ? 100_000 + Math.floor(rand() * 900_000) : 0
    const cacheRead = i % 4 === 0 ? 100_000 + Math.floor(rand() * 900_000) : 0
    rows.push({
      provider: provider.provider,
      api_key_ref: provider.apiKeyRef,
      model: model.model,
      origin,
      session_id: TEST_CODEX_SESSION_IDS[i % TEST_CODEX_SESSION_IDS.length],
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
  usageActivityUnixMs?: number | null
  forceDetailsTab?: UsageDetailsTab
  showDetailsTabs?: boolean
  showFilters?: boolean
  onOpenRequestDetails?: () => void
  onBackToUsageOverview?: () => void
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
  usageActivityUnixMs = null,
  forceDetailsTab,
  showDetailsTabs = true,
  showFilters = true,
  onOpenRequestDetails,
  onBackToUsageOverview,
}: Props) {
  const [usageRequestTimeFilter, setUsageRequestTimeFilter] = useState('')
  const [usageRequestMultiFilters, setUsageRequestMultiFilters] = useState<Record<UsageRequestMultiFilterKey, string[] | null>>({
    provider: null,
    model: null,
    origin: null,
    session: null,
  })
  const [usageRequestFilterSearch, setUsageRequestFilterSearch] = useState<Record<UsageRequestMultiFilterKey, string>>({
    provider: '',
    model: '',
    origin: '',
    session: '',
  })
  const [activeUsageRequestFilterMenu, setActiveUsageRequestFilterMenu] = useState<{
    key: UsageRequestColumnFilterKey
    left: number
    top: number
    width: number
  } | null>(null)
  const [timePickerMonthStartMs, setTimePickerMonthStartMs] = useState<number>(() => startOfMonthMs(Date.now()))
  const usageRequestFilterMenuRef = useRef<HTMLDivElement | null>(null)
  const [usageDetailsTab, setUsageDetailsTab] = useState<UsageDetailsTab>('overview')
  const [usageRequestRows, setUsageRequestRows] = useState<UsageRequestEntry[]>([])
  const [usageRequestTableScrollLeft, setUsageRequestTableScrollLeft] = useState(0)
  const [usageRequestHasMore, setUsageRequestHasMore] = useState(false)
  const [usageRequestLoading, setUsageRequestLoading] = useState(false)
  const [usageRequestError, setUsageRequestError] = useState('')
  const [usageRequestUsingTestFallback, setUsageRequestUsingTestFallback] = useState(false)
  const [usageRequestMergeTick, setUsageRequestMergeTick] = useState(0)
  const usageRequestRefreshInFlightRef = useRef(false)
  const usageRequestFetchSeqRef = useRef(0)
  const usageRequestLoadedQueryKeyRef = useRef<string | null>(null)
  const usageRequestLastActivityRef = useRef<number | null>(null)
  const usageRequestWasNearBottomRef = useRef(false)
  const usageRequestTestFallbackEnabled = useMemo(() => readTestFlagFromLocation() || import.meta.env.DEV, [])
  const usageRequestTestRows = useMemo(
    () => buildUsageRequestTestRows(usageStatistics, usageWindowHours),
    [usageStatistics, usageWindowHours],
  )
  const useGlobalRequestFilters = showFilters
  const requestFetchProviders = useMemo(
    () => (useGlobalRequestFilters && usageFilterProviders.length ? usageFilterProviders : null),
    [useGlobalRequestFilters, usageFilterProviders],
  )
  const requestFetchModels = useMemo(
    () => (useGlobalRequestFilters && usageFilterModels.length ? usageFilterModels : null),
    [useGlobalRequestFilters, usageFilterModels],
  )
  const requestFetchOrigins = useMemo(
    () => (useGlobalRequestFilters && usageFilterOrigins.length ? usageFilterOrigins : null),
    [useGlobalRequestFilters, usageFilterOrigins],
  )
  const requestFetchHours =
    (forceDetailsTab ?? usageDetailsTab) === 'requests' && !showFilters
      ? 24 * 365 * 20
      : usageWindowHours
  const requestQueryKey = useMemo(
    () =>
      JSON.stringify({
        hours: requestFetchHours,
        providers: requestFetchProviders ?? [],
        models: requestFetchModels ?? [],
        origins: requestFetchOrigins ?? [],
      }),
    [requestFetchHours, requestFetchModels, requestFetchOrigins, requestFetchProviders],
  )
  const hasExplicitTimeFilter = usageRequestTimeFilter.trim().length > 0
  const hasExplicitRequestFilters =
    hasExplicitTimeFilter ||
    usageRequestMultiFilters.provider !== null ||
    usageRequestMultiFilters.model !== null ||
    usageRequestMultiFilters.origin !== null ||
    usageRequestMultiFilters.session !== null
  const hasImpossibleRequestFilters =
    (usageRequestMultiFilters.provider !== null && usageRequestMultiFilters.provider.length === 0) ||
    (usageRequestMultiFilters.model !== null && usageRequestMultiFilters.model.length === 0) ||
    (usageRequestMultiFilters.origin !== null && usageRequestMultiFilters.origin.length === 0) ||
    (usageRequestMultiFilters.session !== null && usageRequestMultiFilters.session.length === 0)
  const [requestDefaultDay, setRequestDefaultDay] = useState<number>(() =>
    startOfDayUnixMs(Date.now()),
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    let timer: number | null = null
    const schedule = () => {
      const now = Date.now()
      const nextDayStart = startOfDayUnixMs(now) + 24 * 60 * 60 * 1000
      const delay = Math.max(1000, nextDayStart - now + 50)
      timer = window.setTimeout(() => {
        setRequestDefaultDay(startOfDayUnixMs(Date.now()))
        schedule()
      }, delay)
    }
    schedule()
    return () => {
      if (timer != null) window.clearTimeout(timer)
    }
  }, [])
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
  const isRequestsOnlyPage = effectiveDetailsTab === 'requests' && !showFilters && !showDetailsTabs

  useEffect(() => {
    if (!isRequestsOnlyPage) return
    setUsageRequestTimeFilter('')
    setUsageRequestMultiFilters({ provider: null, model: null, origin: null, session: null })
    setUsageRequestFilterSearch({ provider: '', model: '', origin: '', session: '' })
    setActiveUsageRequestFilterMenu(null)
  }, [isRequestsOnlyPage])

  const {
    usageHistoryTableSurfaceRef: usageRequestTableSurfaceRef,
    usageHistoryTableWrapRef: usageRequestTableWrapRef,
    usageHistoryScrollbarOverlayRef: usageRequestScrollbarOverlayRef,
    usageHistoryScrollbarThumbRef: usageRequestScrollbarThumbRef,
    scheduleUsageHistoryScrollbarSync: scheduleUsageRequestScrollbarSync,
    activateUsageHistoryScrollbarUi: activateUsageRequestScrollbarUi,
    onUsageHistoryScrollbarPointerDown: onUsageRequestScrollbarPointerDown,
    onUsageHistoryScrollbarPointerMove: onUsageRequestScrollbarPointerMove,
    onUsageHistoryScrollbarPointerUp: onUsageRequestScrollbarPointerUp,
    onUsageHistoryScrollbarLostPointerCapture: onUsageRequestScrollbarLostPointerCapture,
    clearUsageHistoryScrollbarTimers: clearUsageRequestScrollbarTimers,
  } = useUsageHistoryScrollbar()

  useEffect(() => {
    if (effectiveDetailsTab !== 'requests' || typeof window === 'undefined') return
    const sync = () => {
      scheduleUsageRequestScrollbarSync()
      activateUsageRequestScrollbarUi()
    }
    const raf = window.requestAnimationFrame(sync)
    const onResize = () => sync()
    window.addEventListener('resize', onResize)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [
    effectiveDetailsTab,
    usageRequestRows,
    usageRequestLoading,
    scheduleUsageRequestScrollbarSync,
    activateUsageRequestScrollbarUi,
  ])

  useEffect(() => () => clearUsageRequestScrollbarTimers(), [clearUsageRequestScrollbarTimers])

  const refreshUsageRequests = useCallback(
    async (limit: number) => {
      if (usageRequestRefreshInFlightRef.current) return
      usageRequestRefreshInFlightRef.current = true
      const requestSeq = usageRequestFetchSeqRef.current + 1
      usageRequestFetchSeqRef.current = requestSeq
      setUsageRequestLoading(true)
      setUsageRequestError('')
      setUsageRequestUsingTestFallback(false)
      try {
        const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
          hours: requestFetchHours,
          providers: requestFetchProviders,
          models: requestFetchModels,
          origins: requestFetchOrigins,
          limit,
          offset: 0,
        })
        if (usageRequestFetchSeqRef.current !== requestSeq) return
        setUsageRequestRows(res.rows ?? [])
        setUsageRequestHasMore(Boolean(res.has_more))
      } catch (e) {
        if (usageRequestFetchSeqRef.current !== requestSeq) return
        if (usageRequestTestFallbackEnabled) {
          const next = usageRequestTestRows.slice(0, Math.min(limit, usageRequestTestRows.length))
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
        usageRequestRefreshInFlightRef.current = false
        if (usageRequestFetchSeqRef.current === requestSeq) {
          setUsageRequestLoading(false)
        }
      }
    },
    [
      requestFetchHours,
      requestFetchProviders,
      requestFetchModels,
      requestFetchOrigins,
      usageRequestTestFallbackEnabled,
      usageRequestTestRows,
    ],
  )
  const mergeLatestUsageRequests = useCallback(
    async (limit: number) => {
      if (usageRequestRefreshInFlightRef.current) return
      usageRequestRefreshInFlightRef.current = true
      const requestSeq = usageRequestFetchSeqRef.current + 1
      usageRequestFetchSeqRef.current = requestSeq
      try {
        const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
          hours: requestFetchHours,
          providers: requestFetchProviders,
          models: requestFetchModels,
          origins: requestFetchOrigins,
          limit,
          offset: 0,
        })
        if (usageRequestFetchSeqRef.current !== requestSeq) return
        const incoming = res.rows ?? []
        if (!incoming.length) return
        setUsageRequestRows((prev) => {
          if (!prev.length) return incoming
          const seen = new Set(prev.map(usageRequestRowIdentity))
          const prepend: UsageRequestEntry[] = []
          for (const row of incoming) {
            const id = usageRequestRowIdentity(row)
            if (seen.has(id)) continue
            prepend.push(row)
          }
          return prepend.length ? [...prepend, ...prev] : prev
        })
      } catch {
        // Keep current rows when background merge fails.
      } finally {
        usageRequestRefreshInFlightRef.current = false
        setUsageRequestMergeTick((tick) => tick + 1)
      }
    },
    [requestFetchHours, requestFetchModels, requestFetchOrigins, requestFetchProviders],
  )
  const initialRefreshLimit = 1000

  useEffect(() => {
    if (effectiveDetailsTab !== 'requests') return
    usageRequestWasNearBottomRef.current = false
    usageRequestLastActivityRef.current = usageActivityUnixMs ?? null
    const cached =
      usageRequestsPageCache != null && usageRequestsPageCache.queryKey === requestQueryKey
        ? usageRequestsPageCache
        : null
    if (usageRequestRows.length === 0 && cached != null) {
      usageRequestLoadedQueryKeyRef.current = requestQueryKey
      setUsageRequestRows(cached.rows)
      setUsageRequestHasMore(cached.hasMore)
      setUsageRequestUsingTestFallback(cached.usingTestFallback)
      void mergeLatestUsageRequests(USAGE_REQUEST_PAGE_SIZE)
      return
    }
    const shouldRefresh =
      usageRequestLoadedQueryKeyRef.current !== requestQueryKey || usageRequestRows.length === 0
    if (shouldRefresh) {
      usageRequestLoadedQueryKeyRef.current = requestQueryKey
      void refreshUsageRequests(initialRefreshLimit)
      return
    }
    void mergeLatestUsageRequests(USAGE_REQUEST_PAGE_SIZE)
  }, [
    effectiveDetailsTab,
    initialRefreshLimit,
    mergeLatestUsageRequests,
    requestQueryKey,
    refreshUsageRequests,
    usageRequestRows.length,
  ])
  useEffect(() => {
    if (effectiveDetailsTab !== 'requests') return
    if (!usageRequestRows.length) return
    usageRequestsPageCache = {
      queryKey: requestQueryKey,
      rows: usageRequestRows,
      hasMore: usageRequestHasMore,
      usingTestFallback: usageRequestUsingTestFallback,
    }
  }, [
    effectiveDetailsTab,
    requestQueryKey,
    usageRequestHasMore,
    usageRequestRows,
    usageRequestUsingTestFallback,
  ])

  useEffect(() => {
    if (effectiveDetailsTab !== 'requests') return
    if (usageActivityUnixMs == null) return
    const last = usageRequestLastActivityRef.current
    if (last == null) {
      usageRequestLastActivityRef.current = usageActivityUnixMs
      return
    }
    if (usageActivityUnixMs <= last) return
    usageRequestLastActivityRef.current = usageActivityUnixMs
    void mergeLatestUsageRequests(USAGE_REQUEST_PAGE_SIZE)
  }, [effectiveDetailsTab, usageActivityUnixMs, mergeLatestUsageRequests])

  const loadMoreUsageRequests = useCallback(async () => {
    if (usageRequestLoading || !usageRequestHasMore || usageRequestRefreshInFlightRef.current) return
    const requestSeq = usageRequestFetchSeqRef.current
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
        hours: requestFetchHours,
        providers: requestFetchProviders,
        models: requestFetchModels,
        origins: requestFetchOrigins,
        limit: USAGE_REQUEST_PAGE_SIZE,
        offset: usageRequestRows.length,
      })
      if (usageRequestFetchSeqRef.current !== requestSeq) return
      setUsageRequestRows((prev) => [...prev, ...(res.rows ?? [])])
      setUsageRequestHasMore(Boolean(res.has_more))
    } catch (e) {
      if (usageRequestFetchSeqRef.current !== requestSeq) return
      setUsageRequestError(String(e))
    } finally {
      if (usageRequestFetchSeqRef.current === requestSeq) {
        setUsageRequestLoading(false)
      }
    }
  }, [
    requestFetchHours,
    requestFetchModels,
    requestFetchOrigins,
    requestFetchProviders,
    usageRequestHasMore,
    usageRequestLoading,
    usageRequestRows.length,
    usageRequestTestRows,
    usageRequestUsingTestFallback,
  ])

  useEffect(() => {
    if (effectiveDetailsTab !== 'requests') return
    if (hasExplicitTimeFilter) return
    if (usageRequestLoading || !usageRequestHasMore || !usageRequestRows.length) return
    const loadedDays = new Set<number>()
    for (const row of usageRequestRows) loadedDays.add(startOfDayUnixMs(row.unix_ms))
    if (loadedDays.size >= 45) return
    void loadMoreUsageRequests()
  }, [
    effectiveDetailsTab,
    hasExplicitTimeFilter,
    loadMoreUsageRequests,
    usageRequestMergeTick,
    usageRequestHasMore,
    usageRequestLoading,
    usageRequestRows,
  ])

  const usageRequestProviderOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of usageRequestRows) {
      counts.set(row.provider, (counts.get(row.provider) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => {
        const providerOrder = compareUsageProvidersForDisplay(a[0], b[0])
        if (providerOrder !== 0) return providerOrder
        if (a[1] !== b[1]) return b[1] - a[1]
        return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })
      })
      .map(([provider]) => provider)
  }, [usageRequestRows])

  const activeRequestGraphProviders = useMemo(
    () => usageRequestProviderOptions.slice(0, Math.min(3, USAGE_REQUEST_GRAPH_COLORS.length)),
    [usageRequestProviderOptions],
  )

  const usageRequestGraphPointCount = USAGE_REQUEST_GRAPH_SOURCE_LIMIT

  const usageRequestRowsByProvider = useMemo(() => {
    const out = new Map<string, UsageRequestEntry[]>()
    for (const provider of activeRequestGraphProviders) out.set(provider, [])
    for (const row of usageRequestRows) {
      const list = out.get(row.provider)
      if (!list) continue
      if (list.length >= USAGE_REQUEST_GRAPH_SOURCE_LIMIT) continue
      list.push(row)
    }
    return out
  }, [activeRequestGraphProviders, usageRequestRows])

  const usageRequestLineSeries = useMemo(() => {
    const providers = [...activeRequestGraphProviders].sort(compareUsageProvidersForDisplay)
    if (!providers.length) return []
    const pointCount = usageRequestGraphPointCount
      const providerSeries = providers.map((provider, providerIndex) => {
        const values = new Array<number>(pointCount).fill(0)
        const present = new Array<boolean>(pointCount).fill(false)
        const rows = usageRequestRowsByProvider.get(provider) ?? []
      const count = Math.min(pointCount, rows.length)
      // Plot request points as left-old/right-new:
      // point 1 is the oldest entry within the latest-N window,
      // and the rightmost plotted point is the newest entry.
      for (let idx = 0; idx < count; idx += 1) {
        const row = rows[count - 1 - idx]
        values[idx] = row.total_tokens
        present[idx] = true
      }
      return {
        kind: 'provider' as const,
        provider,
        color: USAGE_REQUEST_GRAPH_COLORS[providerIndex % USAGE_REQUEST_GRAPH_COLORS.length],
        values,
        present,
      }
    })
    return providerSeries
  }, [activeRequestGraphProviders, usageRequestGraphPointCount, usageRequestRowsByProvider])

  const usageRequestLineMaxValue = useMemo(() => {
    let maxValue = 0
    for (const series of usageRequestLineSeries) {
      for (const value of series.values) {
        if (value > maxValue) maxValue = value
      }
    }
    return Math.max(1, maxValue)
  }, [usageRequestLineSeries])
  const usageRequestProviderSeries = useMemo(
    () => usageRequestLineSeries.filter((series) => series.kind === 'provider'),
    [usageRequestLineSeries],
  )
  const usageRequestLegendSeries = useMemo(
    () => usageRequestLineSeries.filter((series) => series.kind === 'provider'),
    [usageRequestLineSeries],
  )
  const usageRequestChartShownCount = useMemo(() => {
    let maxCount = 0
    for (const series of usageRequestLineSeries) {
      const count = series.present.reduce((sum, present) => sum + (present ? 1 : 0), 0)
      if (count > maxCount) maxCount = count
    }
    return maxCount
  }, [usageRequestLineSeries])

  const usageRequestDailyBars = useMemo(() => {
    if (!activeRequestGraphProviders.length) return []
    const byDay = new Map<number, Record<string, number>>()
    for (const row of usageRequestRows) {
      if (!activeRequestGraphProviders.includes(row.provider)) continue
      const day = startOfDayUnixMs(row.unix_ms)
      const slot = byDay.get(day) ?? {}
      slot[row.provider] = (slot[row.provider] ?? 0) + row.total_tokens
      byDay.set(day, slot)
    }
    if (!byDay.size) return []
    const latestDay = Math.max(...byDay.keys())
    const earliestDay = Math.min(...byDay.keys())
    const dayWindow = 45
    const dayMs = 86_400_000
    const loadedSpanDays = Math.floor((latestDay - earliestDay) / dayMs) + 1
    const windowStart =
      loadedSpanDays >= dayWindow
        ? latestDay - (dayWindow - 1) * dayMs
        : earliestDay
    const days = Array.from({ length: dayWindow }, (_, idx) => windowStart + idx * dayMs)
    const labelStride = days.length > 36 ? 3 : days.length > 24 ? 2 : 1
    return days.map((day, index) => {
      const providerTotals = byDay.get(day) ?? {}
      const total = activeRequestGraphProviders.reduce((sum, provider) => sum + (providerTotals[provider] ?? 0), 0)
      return {
        day,
        providerTotals,
        total,
        showLabel: (total > 0 && index % labelStride === 0) || index === days.length - 1,
      }
    })
  }, [activeRequestGraphProviders, usageRequestRows])

  const timeScopedUsageRequestRows = useMemo(() => {
    const timeDay = parseDateInputToDayStart(usageRequestTimeFilter)
    const defaultTodayOnly = effectiveDetailsTab === 'requests' && !hasExplicitTimeFilter
    if (timeDay == null && !defaultTodayOnly) return usageRequestRows
    return usageRequestRows.filter((row) =>
      timeDay != null
        ? startOfDayUnixMs(row.unix_ms) === timeDay
        : startOfDayUnixMs(row.unix_ms) === requestDefaultDay,
    )
  }, [
    effectiveDetailsTab,
    hasExplicitTimeFilter,
    requestDefaultDay,
    usageRequestRows,
    usageRequestTimeFilter,
  ])

  const usageRequestFilterOptions = useMemo(() => {
    const providers = new Set<string>()
    const models = new Set<string>()
    const origins = new Set<string>()
    const sessions = new Set<string>()
    for (const row of timeScopedUsageRequestRows) {
      providers.add(row.provider)
      models.add(row.model)
      origins.add(row.origin)
      sessions.add(row.session_id)
    }
    return {
      provider: [...providers].sort((a, b) => a.localeCompare(b)),
      model: [...models].sort((a, b) => a.localeCompare(b)),
      origin: [...origins].sort((a, b) => a.localeCompare(b)),
      session: [...sessions].sort((a, b) => a.localeCompare(b)),
    }
  }, [timeScopedUsageRequestRows])
  useEffect(() => {
    setUsageRequestMultiFilters((prev) => ({
      provider:
        prev.provider == null
          ? null
          : prev.provider.filter((item) => usageRequestFilterOptions.provider.includes(item)),
      model:
        prev.model == null ? null : prev.model.filter((item) => usageRequestFilterOptions.model.includes(item)),
      origin:
        prev.origin == null ? null : prev.origin.filter((item) => usageRequestFilterOptions.origin.includes(item)),
      session:
        prev.session == null
          ? null
          : prev.session.filter((item) => usageRequestFilterOptions.session.includes(item)),
    }))
  }, [usageRequestFilterOptions])
  const usageRequestDaysWithRecords = useMemo(() => {
    const out = new Set<number>()
    for (const row of usageRequestRows) out.add(startOfDayUnixMs(row.unix_ms))
    return out
  }, [usageRequestRows])
  const usageRequestDayOriginFlags = useMemo(() => {
    const out = new Map<number, { win: boolean; wsl: boolean }>()
    for (const row of usageRequestRows) {
      const day = startOfDayUnixMs(row.unix_ms)
      const prev = out.get(day) ?? { win: false, wsl: false }
      const isWsl = row.origin.toLowerCase().includes('wsl')
      out.set(day, {
        win: prev.win || !isWsl,
        wsl: prev.wsl || isWsl,
      })
    }
    return out
  }, [usageRequestRows])

  const usageRequestDailyMax = useMemo(
    () => Math.max(1, ...usageRequestDailyBars.map((row) => row.total)),
    [usageRequestDailyBars],
  )
  const filteredUsageRequestRows = useMemo(() => {
    const defaultTodayOnly = effectiveDetailsTab === 'requests' && !hasExplicitTimeFilter
    const timeDay = parseDateInputToDayStart(usageRequestTimeFilter)
    const timeNeedle = usageRequestTimeFilter.trim().toLowerCase()
    const contains = (text: string) => timeNeedle.length === 0 || text.toLowerCase().includes(timeNeedle)
    const providerFilterSet =
      usageRequestMultiFilters.provider == null ? null : new Set(usageRequestMultiFilters.provider)
    const modelFilterSet =
      usageRequestMultiFilters.model == null ? null : new Set(usageRequestMultiFilters.model)
    const originFilterSet =
      usageRequestMultiFilters.origin == null ? null : new Set(usageRequestMultiFilters.origin)
    const sessionFilterSet =
      usageRequestMultiFilters.session == null ? null : new Set(usageRequestMultiFilters.session)
    return usageRequestRows.filter((row) => {
      if (timeDay != null) {
        if (startOfDayUnixMs(row.unix_ms) !== timeDay) return false
      } else if (defaultTodayOnly) {
        if (startOfDayUnixMs(row.unix_ms) !== requestDefaultDay) return false
      } else if (!contains(fmtWhen(row.unix_ms))) {
        return false
      }
      if (providerFilterSet && !providerFilterSet.has(row.provider)) return false
      if (modelFilterSet && !modelFilterSet.has(row.model)) return false
      if (originFilterSet && !originFilterSet.has(row.origin)) return false
      if (sessionFilterSet && !sessionFilterSet.has(row.session_id)) return false
      return true
    })
  }, [
    effectiveDetailsTab,
    fmtWhen,
    hasExplicitTimeFilter,
    requestDefaultDay,
    usageRequestMultiFilters,
    usageRequestRows,
    usageRequestTimeFilter,
  ])
  const deferredFilteredUsageRequestRows = useDeferredValue(filteredUsageRequestRows)
  useEffect(() => {
    if (effectiveDetailsTab !== 'requests') return
    if (!hasExplicitTimeFilter) return
    if (hasImpossibleRequestFilters) return
    if (usageRequestLoading || !usageRequestHasMore) return
    if (filteredUsageRequestRows.length > 0) return
    void loadMoreUsageRequests()
  }, [
    effectiveDetailsTab,
    filteredUsageRequestRows.length,
    hasExplicitTimeFilter,
    hasImpossibleRequestFilters,
    loadMoreUsageRequests,
    usageRequestHasMore,
    usageRequestLoading,
  ])
  const requestChartWidth = 1000
  const requestChartHeight = 176
  const requestChartMinX = 54
  const requestChartMaxX = 982
  const requestChartTopY = 14
  const requestChartBottomY = 136
  const [lineHoverIndex, setLineHoverIndex] = useState<number | null>(null)
  const [lineHoverX, setLineHoverX] = useState<number | null>(null)
  const [dailyHoverDay, setDailyHoverDay] = useState<number | null>(null)
  const [dailyHoverPos, setDailyHoverPos] = useState<{ left: number; top: number } | null>(null)
  const dailyHoverWrapRef = useRef<HTMLDivElement | null>(null)
  const dailyHoverOverlayRef = useRef<HTMLDivElement | null>(null)
  const updateDailyHoverPos = useCallback((clientX: number, clientY: number) => {
    const wrap = dailyHoverWrapRef.current
    if (!wrap) return
    const wrapRect = wrap.getBoundingClientRect()
    const overlay = dailyHoverOverlayRef.current
    const overlayWidth = overlay?.offsetWidth ?? 260
    const overlayHeight = overlay?.offsetHeight ?? 44
    const offset = 12
    const pad = 8
    const maxLeft = Math.max(pad, wrapRect.width - overlayWidth - pad)
    const maxTop = Math.max(pad, wrapRect.height - overlayHeight - pad)
    const left = Math.max(pad, Math.min(clientX - wrapRect.left + offset, maxLeft))
    const top = Math.max(pad, Math.min(clientY - wrapRect.top + offset, maxTop))
    setDailyHoverPos({ left, top })
  }, [])
  const handleDailyBarsMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      updateDailyHoverPos(event.clientX, event.clientY)
      const wrap = dailyHoverWrapRef.current
      if (!wrap) {
        setDailyHoverDay(null)
        return
      }
      const groups = wrap.querySelectorAll<HTMLElement>('.aoUsageRequestDailyBarGroup[data-day]')
      if (!groups.length) {
        setDailyHoverDay(null)
        return
      }
      let nextDay: number | null = null
      let bestDist = Number.POSITIVE_INFINITY
      for (const group of groups) {
        const dayValue = group.dataset.day
        if (!dayValue) continue
        const rect = group.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const dist = Math.abs(event.clientX - centerX)
        if (dist < bestDist) {
          const parsed = Number(dayValue)
          if (Number.isFinite(parsed)) {
            bestDist = dist
            nextDay = parsed
          }
        }
      }
      setDailyHoverDay(nextDay)
    },
    [updateDailyHoverPos],
  )
  const lineHoverData = useMemo(() => {
    if (lineHoverIndex == null) return null
    if (lineHoverIndex < 0 || lineHoverIndex >= usageRequestGraphPointCount) return null
    const rows = usageRequestLineSeries.map((series) => ({
      provider: series.provider,
      color: series.color,
      value: series.values[lineHoverIndex] ?? 0,
    }))
    return {
      point: lineHoverIndex + 1,
      rows,
      total: rows.reduce((sum, row) => sum + row.value, 0),
    }
  }, [lineHoverIndex, usageRequestGraphPointCount, usageRequestLineSeries])
  const selectedTimeFilterDay = useMemo(
    () => parseDateInputToDayStart(usageRequestTimeFilter),
    [usageRequestTimeFilter],
  )
  const timeFilterCalendarCells = useMemo(() => {
    const monthStart = timePickerMonthStartMs
    const monthDate = new Date(monthStart)
    const firstWeekday = monthDate.getDay()
    const firstGridDayDate = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1 - firstWeekday)
    return Array.from({ length: 42 }, (_, idx) => {
      // Use calendar-day arithmetic instead of fixed 24h millis to avoid DST drift.
      const cellDate = new Date(
        firstGridDayDate.getFullYear(),
        firstGridDayDate.getMonth(),
        firstGridDayDate.getDate() + idx,
      )
      const dayStartMs = cellDate.getTime()
      const dayDate = new Date(dayStartMs)
      return {
        dayStartMs,
        label: dayDate.getDate(),
        inMonth: dayDate.getMonth() === monthDate.getMonth(),
      }
    })
  }, [timePickerMonthStartMs])
  const dailyHoverData = useMemo(() => {
    if (dailyHoverDay == null) return null
    const row = usageRequestDailyBars.find((item) => item.day === dailyHoverDay)
    if (!row) return null
    const rows = activeRequestGraphProviders
      .map((provider, idx) => ({
        provider,
        value: row.providerTotals[provider] ?? 0,
        color: USAGE_REQUEST_GRAPH_COLORS[idx % USAGE_REQUEST_GRAPH_COLORS.length],
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
    return {
      day: row.day,
      total: row.total,
      rows,
    }
  }, [activeRequestGraphProviders, dailyHoverDay, usageRequestDailyBars])
  const requestTableSummary = useMemo(() => {
    const requests = deferredFilteredUsageRequestRows.length
    const totals = deferredFilteredUsageRequestRows.reduce(
      (acc, row) => {
        acc.input += row.input_tokens
        acc.output += row.output_tokens
        acc.total += row.total_tokens
        acc.cacheCreate += row.cache_creation_input_tokens
        acc.cacheRead += row.cache_read_input_tokens
        return acc
      },
      { input: 0, output: 0, total: 0, cacheCreate: 0, cacheRead: 0 },
    )
    return { requests, ...totals }
  }, [deferredFilteredUsageRequestRows])
  const filteredSelectionCount = useCallback((selectedCount: number, totalCount: number) => {
    if (selectedCount <= 0) return 0
    if (totalCount <= 0) return selectedCount
    return selectedCount < totalCount ? selectedCount : 0
  }, [])
  const openUsageRequestFilterMenu = useCallback(
    (columnKey: UsageRequestColumnFilterKey, trigger: HTMLButtonElement) => {
      const rect = trigger.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 236))
      const top = rect.bottom + 6
      const width = Math.max(160, rect.width)
      if (columnKey === 'time') {
        setTimePickerMonthStartMs(startOfMonthMs(parseDateInputToDayStart(usageRequestTimeFilter) ?? Date.now()))
      }
      setActiveUsageRequestFilterMenu((prev) => {
        if (prev?.key === columnKey) return null
        return {
          key: columnKey,
          left,
          top,
          width,
        }
      })
    },
    [usageRequestTimeFilter],
  )

  useEffect(() => {
    if (!activeUsageRequestFilterMenu) return
    const activeColumn = USAGE_REQUEST_COLUMN_FILTERS.find((item) => item.key === activeUsageRequestFilterMenu.key)
    if (!activeColumn?.filterable) {
      setActiveUsageRequestFilterMenu(null)
      return
    }
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        setActiveUsageRequestFilterMenu(null)
        return
      }
      if (usageRequestFilterMenuRef.current?.contains(target)) return
      if (target.closest('.aoUsageReqHeadBtn')) return
      setActiveUsageRequestFilterMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveUsageRequestFilterMenu(null)
    }
    const onAnyScroll = () => {
      setActiveUsageRequestFilterMenu(null)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onAnyScroll, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onAnyScroll, true)
    }
  }, [activeUsageRequestFilterMenu])

  return (
    <div className={`aoCard aoUsageStatsPage${isRequestsOnlyPage ? ' is-requests-only' : ''}`}>
      {showFilters ? (
        <>
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
            headerExtraAction={
              effectiveDetailsTab === 'overview' && onOpenRequestDetails ? (
                <button type="button" className="aoTinyBtn" onClick={onOpenRequestDetails}>
                  Open Request Details
                </button>
              ) : undefined
            }
          />
        </>
      ) : null}
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
        <div className={`aoUsageRequestsCard${isRequestsOnlyPage ? ' is-page' : ''}`}>
          <div className="aoSwitchboardSectionHead">
            <div className="aoMiniLabel">Request Details</div>
            <div className="aoHint">
              {hasExplicitRequestFilters
                ? 'Per-request rows (newest first), aligned with current filters/window.'
                : 'Default view shows today only. Use column filters to query across all days.'}
            </div>
          </div>
          {onBackToUsageOverview ? (
            <div className="aoUsageRequestBackRow">
              <button type="button" className="aoTinyBtn" onClick={onBackToUsageOverview}>
                Back to Usage Statistics
              </button>
            </div>
          ) : null}
          {usageRequestUsingTestFallback ? (
            <div className="aoHint">Test mode fallback rows are shown because backend request details are unavailable.</div>
          ) : null}
          {usageRequestError ? <div className="aoHint">Failed to load request details: {usageRequestError}</div> : null}
          <div className="aoUsageRequestChartCard">
            <div className="aoSwitchboardSectionHead">
              <div className="aoMiniLabel">Latest 120 Requests (Total Tokens)</div>
              <div className="aoHint">{usageRequestChartShownCount.toLocaleString()} requests shown</div>
            </div>
            {usageRequestLineSeries.length ? (
              <div className="aoUsageRequestLineGraphWrap">
                <svg
                  className="aoUsageRequestLineGraph"
                  viewBox={`0 0 ${requestChartWidth} ${requestChartHeight}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="Request token trend by provider"
                  onMouseLeave={() => {
                    setLineHoverIndex(null)
                    setLineHoverX(null)
                  }}
                  onMouseMove={(event) => {
                    const rect = (event.currentTarget as SVGElement).getBoundingClientRect()
                    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
                    const rawX = ratio * requestChartWidth
                    const clampedX = Math.max(requestChartMinX, Math.min(requestChartMaxX, rawX))
                    const idx = Math.round(
                      ((clampedX - requestChartMinX) / Math.max(1, requestChartMaxX - requestChartMinX)) *
                        Math.max(1, usageRequestGraphPointCount - 1),
                    )
                    const snappedX =
                      requestChartMinX +
                      (idx / Math.max(1, usageRequestGraphPointCount - 1)) * (requestChartMaxX - requestChartMinX)
                    setLineHoverIndex(Math.max(0, Math.min(usageRequestGraphPointCount - 1, idx)))
                    setLineHoverX(snappedX)
                  }}
                >
                <line x1={requestChartMinX} y1={requestChartTopY} x2={requestChartMinX} y2={requestChartBottomY} stroke="rgba(13, 18, 32, 0.24)" strokeWidth="1" />
                <line x1={requestChartMinX} y1={requestChartBottomY} x2={requestChartMaxX} y2={requestChartBottomY} stroke="rgba(13, 18, 32, 0.24)" strokeWidth="1" />
                <line
                  x1={requestChartMinX}
                  y1={(requestChartTopY + requestChartBottomY) / 2}
                  x2={requestChartMaxX}
                  y2={(requestChartTopY + requestChartBottomY) / 2}
                  stroke="rgba(13, 18, 32, 0.14)"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
                <text x={requestChartMinX - 4} y={requestChartTopY + 4} textAnchor="end" fill="rgba(13, 18, 32, 0.55)" fontSize="10">
                  {usageRequestLineMaxValue.toLocaleString()}
                </text>
                <text x={requestChartMinX - 4} y={(requestChartTopY + requestChartBottomY) / 2 + 4} textAnchor="end" fill="rgba(13, 18, 32, 0.48)" fontSize="10">
                  {Math.round(usageRequestLineMaxValue / 2).toLocaleString()}
                </text>
                <text x={requestChartMinX - 4} y={requestChartBottomY + 4} textAnchor="end" fill="rgba(13, 18, 32, 0.48)" fontSize="10">
                  0
                </text>
                <text x={requestChartMinX} y={requestChartBottomY + 16} textAnchor="start" fill="rgba(13, 18, 32, 0.52)" fontSize="10">
                  Older
                </text>
                <text x={requestChartMaxX} y={requestChartBottomY + 16} textAnchor="end" fill="rgba(13, 18, 32, 0.52)" fontSize="10">
                  Newer
                </text>
                {usageRequestLineSeries.map((series) => {
                  const points = series.values.map((value, idx) => {
                    const x =
                      requestChartMinX +
                      (idx / Math.max(1, usageRequestGraphPointCount - 1)) * (requestChartMaxX - requestChartMinX)
                    const y =
                      requestChartBottomY -
                      (value / usageRequestLineMaxValue) * (requestChartBottomY - requestChartTopY)
                    return { x, y, present: series.present[idx] }
                  })
                  const providerPoints = points
                    .filter((point) => point.present)
                    .map((point) => ({ x: point.x, y: point.y }))
                  let pathD = ''
                  if (providerPoints.length > 1) {
                    pathD = buildSmoothLinePath(providerPoints, { min: requestChartTopY, max: requestChartBottomY })
                  }
                  if (!pathD.trim()) return null
                  return (
                    <path
                      key={`request-line-series-${series.provider}`}
                      d={pathD}
                      fill="none"
                      stroke={series.color}
                      strokeWidth={1.8}
                      opacity={0.82}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )
                })}
                {lineHoverX != null ? (
                  <line
                    x1={lineHoverX}
                    y1={requestChartTopY}
                    x2={lineHoverX}
                    y2={requestChartBottomY}
                    stroke="rgba(13, 18, 32, 0.22)"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                ) : null}
                {lineHoverIndex != null
                  ? usageRequestLineSeries.map((series) => {
                      if (!series.present[lineHoverIndex]) return null
                      const value = series.values[lineHoverIndex] ?? 0
                      const x =
                        requestChartMinX +
                        (lineHoverIndex / Math.max(1, usageRequestGraphPointCount - 1)) *
                          (requestChartMaxX - requestChartMinX)
                      const y =
                        requestChartBottomY -
                        (value / usageRequestLineMaxValue) * (requestChartBottomY - requestChartTopY)
                      return <circle key={`line-hover-dot-${series.provider}`} cx={x} cy={y} r="2.6" fill={series.color} />
                    })
                  : null}
                </svg>
                {lineHoverData ? (
                  <div className="aoUsageRequestHoverOverlay" aria-live="polite">
                    <span>
                      Point {lineHoverData.point}/{usageRequestGraphPointCount} · Total {lineHoverData.total.toLocaleString()}
                    </span>
                    {lineHoverData.rows.map((row) => (
                      <span key={`hover-overlay-${row.provider}`} className="aoUsageRequestHoverSummaryItem">
                        <i style={{ background: row.color }} />
                        {row.provider}: {row.value.toLocaleString()}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="aoHint">No recent rows for line graph.</div>
            )}
            {usageRequestLegendSeries.length ? (
              <div className="aoUsageRequestLegend">
                {usageRequestLegendSeries.map((series) => (
                  <span key={`request-line-legend-${series.provider}`} className="aoUsageRequestLegendItem">
                    <i style={{ background: series.color }} />
                    {series.provider}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div ref={usageRequestTableSurfaceRef} className="aoUsageHistoryTableSurface aoUsageRequestTableSurface">
            <div className="aoUsageHistoryTableHead aoUsageRequestTableHead" aria-hidden="true">
              <table
                className="aoUsageHistoryTable aoUsageRequestsTable"
                style={{ transform: `translateX(${-usageRequestTableScrollLeft}px)` }}
              >
                <colgroup>
                  <col className="aoUsageReqColTime" />
                  <col className="aoUsageReqColProvider" />
                  <col className="aoUsageReqColModel" />
                  <col className="aoUsageReqColOrigin" />
                  <col className="aoUsageReqColSession" />
                  <col className="aoUsageReqColInput" />
                  <col className="aoUsageReqColOutput" />
                  <col className="aoUsageReqColCacheCreate" />
                  <col className="aoUsageReqColCacheRead" />
                </colgroup>
                <thead>
                  <tr>
                    {USAGE_REQUEST_COLUMN_FILTERS.map((column) => {
                      const isOpen = activeUsageRequestFilterMenu?.key === column.key
                      const filterCount =
                        column.key === 'time'
                          ? usageRequestTimeFilter.trim().length > 0
                            ? 1
                            : 0
                          : column.key === 'provider'
                            ? Math.max(
                                  filteredSelectionCount(
                                    usageRequestMultiFilters.provider == null
                                      ? usageRequestFilterOptions.provider.length
                                      : usageRequestMultiFilters.provider.length,
                                    usageRequestFilterOptions.provider.length,
                                  ),
                                useGlobalRequestFilters
                                  ? filteredSelectionCount(
                                      usageFilterProviders.length,
                                      usageProviderFilterOptions.length,
                                    )
                                  : 0,
                              )
                            : column.key === 'model'
                              ? Math.max(
                                  filteredSelectionCount(
                                    usageRequestMultiFilters.model == null
                                      ? usageRequestFilterOptions.model.length
                                      : usageRequestMultiFilters.model.length,
                                    usageRequestFilterOptions.model.length,
                                  ),
                                  useGlobalRequestFilters
                                    ? filteredSelectionCount(
                                        usageFilterModels.length,
                                        usageModelFilterOptions.length,
                                      )
                                    : 0,
                                )
                              : column.key === 'origin'
                                ? Math.max(
                                    filteredSelectionCount(
                                      usageRequestMultiFilters.origin == null
                                        ? usageRequestFilterOptions.origin.length
                                        : usageRequestMultiFilters.origin.length,
                                      usageRequestFilterOptions.origin.length,
                                    ),
                                    useGlobalRequestFilters
                                      ? filteredSelectionCount(
                                          usageFilterOrigins.length,
                                          usageOriginFilterOptions.length,
                                        )
                                      : 0,
                                  )
                                : column.key === 'session'
                                  ? filteredSelectionCount(
                                      usageRequestMultiFilters.session == null
                                        ? usageRequestFilterOptions.session.length
                                        : usageRequestMultiFilters.session.length,
                                      usageRequestFilterOptions.session.length,
                                    )
                                  : 0
                      const hasFilter =
                        filterCount > 0
                      return (
                        <th key={`usage-requests-head-${column.key}`}>
                          <div className="aoUsageReqHeadCell">
                            {column.filterable ? (
                              <button
                                type="button"
                                className={`aoUsageReqHeadBtn${hasFilter ? ' is-filtered' : ''}${isOpen ? ' is-open' : ''}`}
                                onPointerDown={(event) => {
                                  event.stopPropagation()
                                  if (event.button !== 0) return
                                  openUsageRequestFilterMenu(column.key, event.currentTarget as HTMLButtonElement)
                                }}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                              >
                                <span className="aoUsageReqHeadLabel">{column.label}</span>
                                {hasFilter ? (
                                  <span className="aoUsageReqHeadFilterBadge is-single">{filterCount}</span>
                                ) : null}
                                <span className="aoUsageReqHeadChevron" aria-hidden="true">
                                  ▾
                                </span>
                              </button>
                            ) : (
                              <span className="aoUsageReqHeadLabel">{column.label}</span>
                            )}
                          </div>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
              </table>
            </div>
            {activeUsageRequestFilterMenu ? (
              <div
                ref={usageRequestFilterMenuRef}
                className={`aoUsageReqFilterMenu aoUsageReqFilterMenuFloating${activeUsageRequestFilterMenu.key === 'time' ? ' is-time' : ''}`}
                style={{
                  left: `${activeUsageRequestFilterMenu.left}px`,
                  top: `${activeUsageRequestFilterMenu.top}px`,
                  width: `${
                    activeUsageRequestFilterMenu.key === 'time'
                      ? 292
                      : activeUsageRequestFilterMenu.key === 'session'
                        ? Math.min(420, Math.max(activeUsageRequestFilterMenu.width + 180, 320))
                        : activeUsageRequestFilterMenu.key === 'model'
                          ? Math.min(360, Math.max(activeUsageRequestFilterMenu.width + 120, 280))
                          : Math.min(320, Math.max(activeUsageRequestFilterMenu.width + 80, 240))
                  }px`,
                }}
                onClick={(event) => event.stopPropagation()}
              >
                {activeUsageRequestFilterMenu.key === 'time' ? (
                  <>
                    <div className="aoUsageReqCalendarHead">
                      <button
                        type="button"
                        className="aoUsageReqCalendarNav"
                        onPointerDown={(event) => {
                          if (event.button !== 0) return
                          event.preventDefault()
                          setTimePickerMonthStartMs((prev) => addMonths(prev, -1))
                        }}
                      >
                        ‹
                      </button>
                      <div className="aoUsageReqCalendarTitle">
                        {MONTH_NAMES[new Date(timePickerMonthStartMs).getMonth()]} {new Date(timePickerMonthStartMs).getFullYear()}
                      </div>
                      <button
                        type="button"
                        className="aoUsageReqCalendarNav"
                        onPointerDown={(event) => {
                          if (event.button !== 0) return
                          event.preventDefault()
                          setTimePickerMonthStartMs((prev) => addMonths(prev, 1))
                        }}
                      >
                        ›
                      </button>
                    </div>
                    <div className="aoUsageReqCalendarWeekdays">
                      {WEEKDAY_NAMES.map((name) => (
                        <span key={`weekday-${name}`}>{name}</span>
                      ))}
                    </div>
                    <div className="aoUsageReqCalendarGrid">
                      {timeFilterCalendarCells.map((cell) => {
                        const selected = selectedTimeFilterDay != null && selectedTimeFilterDay === cell.dayStartMs
                        const hasRecord = usageRequestDaysWithRecords.has(cell.dayStartMs)
                        const originFlags = usageRequestDayOriginFlags.get(cell.dayStartMs) ?? { win: false, wsl: false }
                        return (
                          <button
                            key={`time-cell-${cell.dayStartMs}`}
                            type="button"
                            className={`aoUsageReqCalendarCell${cell.inMonth ? '' : ' is-out'}${selected ? ' is-selected' : ''}`}
                            onPointerDown={(event) => {
                              if (event.button !== 0) return
                              event.preventDefault()
                              setUsageRequestTimeFilter(dayStartToIso(cell.dayStartMs))
                            }}
                          >
                            {cell.label}
                            {hasRecord ? (
                              <span className="aoUsageReqCalendarDots" aria-hidden="true">
                                {originFlags.win ? <span className="aoUsageReqCalendarDot aoUsageReqCalendarDotWin" /> : null}
                                {originFlags.wsl ? <span className="aoUsageReqCalendarDot aoUsageReqCalendarDotWsl" /> : null}
                              </span>
                            ) : null}
                          </button>
                        )
                      })}
                    </div>
                    <div className="aoUsageReqCalendarFoot">
                      <div className="aoUsageReqCalendarFootGroup">
                        <button
                          type="button"
                          className="aoTinyBtn aoUsageActionBtn"
                          onPointerDown={(event) => {
                            if (event.button !== 0) return
                            event.preventDefault()
                            setUsageRequestTimeFilter('')
                          }}
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          className="aoTinyBtn aoUsageActionBtn"
                          onPointerDown={(event) => {
                            if (event.button !== 0) return
                            event.preventDefault()
                            setUsageRequestTimeFilter(dayStartToIso(startOfDayUnixMs(Date.now())))
                          }}
                        >
                          Today
                        </button>
                      </div>
                      <div className="aoUsageReqCalendarFootGroup">
                        <button
                          type="button"
                          className="aoTinyBtn aoUsageActionBtn"
                          onPointerDown={(event) => {
                            if (event.button !== 0) return
                            event.preventDefault()
                            setActiveUsageRequestFilterMenu(null)
                          }}
                        >
                          OK
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      className="aoUsageReqFilterInput"
                      placeholder={`Filter ${
                        USAGE_REQUEST_COLUMN_FILTERS.find((item) => item.key === activeUsageRequestFilterMenu.key)?.label ?? ''
                      }`}
                      value={
                        activeUsageRequestFilterMenu.key === 'provider'
                          ? usageRequestFilterSearch.provider
                          : activeUsageRequestFilterMenu.key === 'model'
                            ? usageRequestFilterSearch.model
                            : activeUsageRequestFilterMenu.key === 'origin'
                              ? usageRequestFilterSearch.origin
                              : usageRequestFilterSearch.session
                      }
                      onChange={(event) =>
                        setUsageRequestFilterSearch((prev) => ({
                          ...prev,
                          [activeUsageRequestFilterMenu.key]: event.target.value,
                        }))
                      }
                      autoFocus
                    />
                    <div className="aoUsageReqFilterOptions">
                      {(() => {
                        const key = activeUsageRequestFilterMenu.key as UsageRequestMultiFilterKey
                        const options =
                          activeUsageRequestFilterMenu.key === 'provider'
                            ? usageRequestFilterOptions.provider
                            : activeUsageRequestFilterMenu.key === 'model'
                              ? usageRequestFilterOptions.model
                              : activeUsageRequestFilterMenu.key === 'origin'
                                ? usageRequestFilterOptions.origin
                                : usageRequestFilterOptions.session
                        const searchNeedle = (
                          activeUsageRequestFilterMenu.key === 'provider'
                            ? usageRequestFilterSearch.provider
                            : activeUsageRequestFilterMenu.key === 'model'
                              ? usageRequestFilterSearch.model
                              : activeUsageRequestFilterMenu.key === 'origin'
                                ? usageRequestFilterSearch.origin
                                : usageRequestFilterSearch.session
                        ).toLowerCase()
                        const visibleOptions = options
                          .filter((item) => item.toLowerCase().includes(searchNeedle))
                          .slice(0, 40)
                        const selectedSet = new Set(usageRequestMultiFilters[key] ?? options)
                        const allVisibleSelected =
                          visibleOptions.length > 0 && visibleOptions.every((item) => selectedSet.has(item))
                        return (
                          <>
                            <label className="aoUsageReqFilterOptionBtn aoUsageReqFilterOptionSelectAll">
                              <input
                                type="checkbox"
                                checked={allVisibleSelected}
                                onChange={(event) =>
                                  setUsageRequestMultiFilters((prev) => {
                                    const current = new Set(prev[key] ?? options)
                                    if (event.target.checked) {
                                      for (const item of visibleOptions) current.add(item)
                                    } else {
                                      for (const item of visibleOptions) current.delete(item)
                                    }
                                    const next = [...current]
                                    return { ...prev, [key]: next.length >= options.length ? null : next }
                                  })
                                }
                              />
                              <span>(Select All)</span>
                            </label>
                            {visibleOptions.map((item) => (
                              <label
                                key={`filter-option-${activeUsageRequestFilterMenu.key}-${item}`}
                                className="aoUsageReqFilterOptionBtn"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedSet.has(item)}
                                  onChange={(event) =>
                                    setUsageRequestMultiFilters((prev) => {
                                      const baseList = prev[key] ?? options
                                      const nextList = event.target.checked
                                        ? [...new Set([...baseList, item])]
                                        : baseList.filter((entry) => entry !== item)
                                      return { ...prev, [key]: nextList.length >= options.length ? null : nextList }
                                    })
                                  }
                                />
                                <span>{item}</span>
                              </label>
                            ))}
                          </>
                        )
                      })()}
                    </div>
                  </>
                )}
                {activeUsageRequestFilterMenu.key !== 'time' ? (
                  <div className="aoUsageReqFilterMenuActions">
                    <button
                      type="button"
                      className="aoTinyBtn"
                      onClick={() =>
                        setUsageRequestMultiFilters((prev) => ({
                          ...prev,
                          [activeUsageRequestFilterMenu.key]: null,
                        }))
                      }
                    >
                      Clear
                    </button>
                    <button type="button" className="aoTinyBtn" onClick={() => setActiveUsageRequestFilterMenu(null)}>
                      Done
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="aoUsageHistoryTableBody">
              <div
                ref={usageRequestTableWrapRef}
                className="aoUsageHistoryTableWrap aoUsageRequestsTableWrap"
                onScroll={() => {
                  const wrap = usageRequestTableWrapRef.current
                  if (wrap) {
                    setUsageRequestTableScrollLeft(wrap.scrollLeft)
                    if (usageRequestHasMore && !usageRequestLoading) {
                      if (hasExplicitRequestFilters && !hasImpossibleRequestFilters) {
                        const nearBottom = isNearBottom(wrap, 24)
                        if (nearBottom && !usageRequestWasNearBottomRef.current) {
                          void loadMoreUsageRequests()
                        }
                        usageRequestWasNearBottomRef.current = nearBottom
                      } else {
                        usageRequestWasNearBottomRef.current = false
                      }
                    } else {
                      usageRequestWasNearBottomRef.current = false
                    }
                  }
                  scheduleUsageRequestScrollbarSync()
                  activateUsageRequestScrollbarUi()
                }}
                onWheel={() => {
                  scheduleUsageRequestScrollbarSync()
                  activateUsageRequestScrollbarUi()
                }}
                onTouchMove={activateUsageRequestScrollbarUi}
              >
                <table className="aoUsageHistoryTable aoUsageRequestsTable">
                  <colgroup>
                    <col className="aoUsageReqColTime" />
                    <col className="aoUsageReqColProvider" />
                    <col className="aoUsageReqColModel" />
                    <col className="aoUsageReqColOrigin" />
                    <col className="aoUsageReqColSession" />
                    <col className="aoUsageReqColInput" />
                    <col className="aoUsageReqColOutput" />
                    <col className="aoUsageReqColCacheCreate" />
                    <col className="aoUsageReqColCacheRead" />
                  </colgroup>
                  <tbody>
                    {!deferredFilteredUsageRequestRows.length && !usageRequestLoading ? (
                      <tr>
                        <td colSpan={9} className="aoHint">
                          No request rows match current filters.
                        </td>
                      </tr>
                    ) : (
                      deferredFilteredUsageRequestRows.map((row, idx) => (
                        <tr key={`${row.unix_ms}-${row.provider}-${row.session_id}-${idx}`}>
                          <td>{fmtWhen(row.unix_ms)}</td>
                          <td className="aoUsageRequestsMono">{row.provider}</td>
                          <td className="aoUsageRequestsMono">{row.model}</td>
                          <td>
                            {(() => {
                              const normalizedOrigin = normalizeUsageOrigin(row.origin)
                              if (normalizedOrigin === 'wsl2') {
                                return <span className="aoUsageReqOriginBadge aoUsageReqOriginBadgeWsl">WSL2</span>
                              }
                              if (normalizedOrigin === 'windows') {
                                return <span className="aoUsageReqOriginBadge aoUsageReqOriginBadgeWindows">WIN</span>
                              }
                              return <span className="aoUsageReqOriginBadge aoUsageReqOriginBadgeUnknown">UNK</span>
                            })()}
                          </td>
                          <td
                            className={`aoUsageRequestsMono ${
                              normalizeUsageOrigin(row.origin) === 'wsl2'
                                ? 'aoUsageReqSessionWsl'
                                : normalizeUsageOrigin(row.origin) === 'windows'
                                  ? 'aoUsageReqSessionWindows'
                                  : 'aoUsageReqSessionUnknown'
                            }`}
                          >
                            {row.session_id}
                          </td>
                          <td>{row.input_tokens.toLocaleString()}</td>
                          <td>{row.output_tokens.toLocaleString()}</td>
                          <td>{row.cache_creation_input_tokens.toLocaleString()}</td>
                          <td>{row.cache_read_input_tokens.toLocaleString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div
                ref={usageRequestScrollbarOverlayRef}
                className="aoUsageHistoryScrollbarOverlay"
                aria-hidden="true"
                onPointerDown={onUsageRequestScrollbarPointerDown}
                onPointerMove={onUsageRequestScrollbarPointerMove}
                onPointerUp={onUsageRequestScrollbarPointerUp}
                onPointerCancel={onUsageRequestScrollbarPointerUp}
                onLostPointerCapture={onUsageRequestScrollbarLostPointerCapture}
              >
                <div ref={usageRequestScrollbarThumbRef} className="aoUsageHistoryScrollbarThumb" />
              </div>
            </div>
            <div className="aoUsageRequestTableSummary" role="status" aria-live="polite">
              <table className="aoUsageHistoryTable aoUsageRequestsTable">
                <colgroup>
                  <col className="aoUsageReqColTime" />
                  <col className="aoUsageReqColProvider" />
                  <col className="aoUsageReqColModel" />
                  <col className="aoUsageReqColOrigin" />
                  <col className="aoUsageReqColSession" />
                  <col className="aoUsageReqColInput" />
                  <col className="aoUsageReqColOutput" />
                  <col className="aoUsageReqColCacheCreate" />
                  <col className="aoUsageReqColCacheRead" />
                </colgroup>
                <tbody>
                  <tr>
                    <td>{hasExplicitRequestFilters ? 'Filtered' : 'Today'} Summary</td>
                    <td>Total {requestTableSummary.total.toLocaleString()}</td>
                    <td>Requests {requestTableSummary.requests.toLocaleString()}</td>
                    <td />
                    <td />
                    <td>{requestTableSummary.input.toLocaleString()}</td>
                    <td>{requestTableSummary.output.toLocaleString()}</td>
                    <td>{requestTableSummary.cacheCreate.toLocaleString()}</td>
                    <td>{requestTableSummary.cacheRead.toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="aoUsageRequestChartCard">
            <div className="aoSwitchboardSectionHead">
              <div className="aoMiniLabel">Daily Token Totals</div>
              <div className="aoHint">Newest 45 days from loaded rows.</div>
            </div>
            {usageRequestDailyBars.length ? (
              <div
                ref={dailyHoverWrapRef}
                className="aoUsageRequestDailyBarsWrap"
                onMouseMove={handleDailyBarsMouseMove}
                onMouseLeave={() => {
                  setDailyHoverDay(null)
                  setDailyHoverPos(null)
                }}
              >
                <div
                  className="aoUsageRequestDailyBars"
                  role="img"
                  aria-label="Daily token totals by selected providers"
                >
                  {usageRequestDailyBars.map((row) => (
                    <div
                      key={`request-day-${row.day}`}
                      className="aoUsageRequestDailyBarGroup"
                      data-day={row.day}
                    >
                      <div className="aoUsageRequestDailyBarStack">
                        {[...activeRequestGraphProviders]
                          .map((provider, idx) => ({
                            provider,
                            idx,
                            value: row.providerTotals[provider] ?? 0,
                          }))
                          .filter((item) => item.value > 0)
                          .sort((a, b) => b.value - a.value)
                          .map((item) => {
                            const heightPct = (item.value / usageRequestDailyMax) * 100
                            const provider = item.provider
                            const idx = item.idx
                            return (
                              <div
                                key={`request-day-${row.day}-${provider}`}
                                className="aoUsageRequestDailyBarSegment"
                                style={{
                                  height: `${heightPct}%`,
                                  background: USAGE_REQUEST_GRAPH_COLORS[idx % USAGE_REQUEST_GRAPH_COLORS.length],
                                }}
                              />
                            )
                          })}
                      </div>
                      <div className={`aoUsageRequestDailyLabel${row.showLabel ? '' : ' is-hidden'}`}>
                        {row.showLabel ? <span>{formatMonthDay(row.day)}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
                {dailyHoverData ? (
                  <div
                    ref={dailyHoverOverlayRef}
                    className="aoUsageRequestDailyHoverOverlay"
                    style={dailyHoverPos ? { left: `${dailyHoverPos.left}px`, top: `${dailyHoverPos.top}px` } : undefined}
                  >
                    <span>{formatMonthDay(dailyHoverData.day)} · Total {dailyHoverData.total.toLocaleString()}</span>
                    {dailyHoverData.rows.map((row) => (
                      <span key={`daily-hover-${row.provider}`} className="aoUsageRequestHoverSummaryItem">
                        <i style={{ background: row.color }} />
                        {row.provider}: {row.value.toLocaleString()}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="aoHint">No daily data for selected providers.</div>
            )}
            {usageRequestProviderSeries.length ? (
              <div className="aoUsageRequestLegend">
                {usageRequestProviderSeries.map((series) => (
                  <span key={`request-daily-legend-${series.provider}`} className="aoUsageRequestLegendItem">
                    <i style={{ background: series.color }} />
                    {series.provider}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="aoUsageRequestsFooter">
            <span className="aoHint">
              {usageRequestLoading
                ? 'Loading more...'
                : usageRequestHasMore
                  ? hasExplicitRequestFilters
                    ? 'Scroll table to load more'
                    : 'Loading history in background...'
                  : 'All loaded'}
            </span>
            <span className="aoHint">
              {deferredFilteredUsageRequestRows.length.toLocaleString()} / {usageRequestRows.length.toLocaleString()} rows
            </span>
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
