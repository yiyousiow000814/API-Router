import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Config, Status, UsageStatistics } from '../types'
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
import { UsageRequestDailyTotalsCard } from './UsageRequestDailyTotalsCard'
import { UsageStatsFiltersBar } from './UsageStatsFiltersBar'
import { useUsageHistoryScrollbar } from '../hooks/useUsageHistoryScrollbar'
import { isNearBottom } from '../utils/scroll'
import { buildProviderGroupMaps, resolveProviderDisplayName } from '../utils/providerGroups'
import {
  buildUsageProviderFilterDisplayOptions,
  type UsageProviderFilterDisplayOption,
} from '../utils/usageStatisticsView'

type UsageSummary = UsageStatistics['summary']
type UsageProviderRow = UsageSummary['by_provider'][number]
type UsageDetailsTab = 'analytics' | 'requests'
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
type UsageRequestSummaryResponse = {
  ok: boolean
  requests: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}
type UsageRequestTableSummary = {
  requests: number
  input: number
  output: number
  total: number
  cacheCreate: number
  cacheRead: number
}
type UsageRequestDailyTotalsResponse = {
  ok: boolean
  days: Array<{
    day_start_unix_ms: number
    provider_totals: Record<string, number>
    total_tokens: number
    total_requests?: number
    windows_request_count?: number
    wsl_request_count?: number
  }>
  providers: Array<{
    provider: string
    total_tokens: number
  }>
}
type UsageRequestsPageCache = {
  queryKey: string
  rows: UsageRequestEntry[]
  hasMore: boolean
  usingTestFallback: boolean
}
type UsageRequestDailyTotalsCache = {
  days: UsageRequestDailyTotalsResponse['days']
  providers: UsageRequestDailyTotalsResponse['providers']
}
type UsageRequestGraphRowsCache = {
  queryKey: string
  baseRows: UsageRequestEntry[]
  rowsByProvider: Record<string, UsageRequestEntry[]>
}
type UsageRequestLineSeries = {
  kind: 'session'
  id: string
  provider: string
  providerName: string
  origin: 'windows' | 'wsl2'
  color: string
  values: number[]
  present: boolean[]
  pointIds: string[]
}
type UsageRequestRenderedLineSeries = UsageRequestLineSeries & {
  fallbackSlidingEligible?: boolean
  fallbackPreviewNextValue?: number | null
  liveSlidingEligible?: boolean
  livePreviewNextValue?: number | null
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
const USAGE_REQUEST_GRAPH_SOURCE_LIMIT = 60
const USAGE_REQUEST_GRAPH_MAX_SESSIONS = 6
const USAGE_REQUEST_TEST_MIN_ROWS = 401
const USAGE_REQUEST_TEST_MIN_WINDOW_HOURS = 24 * 60
export const USAGE_REQUEST_TEST_DATA_REVISION = 'fallback-v3'
const USAGE_REQUEST_LINE_HEADROOM_RATIO = 1.04
const USAGE_REQUEST_GRAPH_COLORS = [
  '#21a8b7',
  '#f2c14d',
  '#ff6a88',
  '#7f7dff',
  '#30c48d',
  '#ff8a3d',
] as const
const USAGE_REQUEST_FALLBACK_LINE_STEP_MS = 820
const USAGE_REQUEST_LIVE_LINE_TRANSITION_MS = 820
const isOfficialUsageProvider = (provider: string) => provider.trim().toLowerCase() === 'official'
const compareUsageProvidersForDisplay = (left: string, right: string) => {
  const leftOfficial = isOfficialUsageProvider(left)
  const rightOfficial = isOfficialUsageProvider(right)
  if (leftOfficial !== rightOfficial) return leftOfficial ? -1 : 1
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}
function pickUsageRequestDisplayProviders(input: {
  graphProviders: string[]
  dailyProviders: string[]
  analyticsProviders: string[]
  limit: number
}): string[] {
  const picked: string[] = []
  const seen = new Set<string>()
  const append = (provider: string) => {
    const key = provider.trim()
    if (!key || seen.has(key)) return
    seen.add(key)
    picked.push(key)
  }
  input.graphProviders.forEach(append)
  input.dailyProviders.forEach(append)
  input.analyticsProviders.forEach(append)
  return picked.slice(0, input.limit)
}
function listTopUsageProvidersFromRows(
  rows: UsageRequestEntry[],
  providerLabel?: (provider: string) => string,
): string[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const provider = providerLabel ? providerLabel(row.provider) : row.provider
    counts.set(provider, (counts.get(provider) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => {
      const providerOrder = compareUsageProvidersForDisplay(a[0], b[0])
      if (providerOrder !== 0) return providerOrder
      if (a[1] !== b[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })
    })
    .map(([provider]) => provider)
}

function shortSessionIdForLegend(sessionId: string): string {
  const value = sessionId.trim()
  if (value.length <= 24) return value
  return `${value.slice(0, 12)}...${value.slice(-8)}`
}

function listUsageRequestDailyProviderHints(
  providers: UsageRequestDailyTotalsResponse['providers'],
): string[] {
  const live = (providers ?? [])
    .map((row) => String(row?.provider ?? '').trim())
    .filter((provider) => provider.length > 0)
  if (live.length > 0) return live
  return (usageRequestDailyTotalsCache?.providers ?? [])
    .map((row) => String(row?.provider ?? '').trim())
    .filter((provider) => provider.length > 0)
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
const TEST_USAGE_PROVIDERS = [
  { provider: 'provider_1', model: 'gpt-5.2-codex', requests: 40, apiKeyRef: '-' },
  { provider: 'provider_2', model: 'gpt-5.2-codex', requests: 34, apiKeyRef: '-' },
  { provider: 'provider_3', model: 'gpt-5.2-codex', requests: 26, apiKeyRef: '-' },
] as const
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const EMPTY_USAGE_REQUEST_ROWS: UsageRequestEntry[] = []
const EMPTY_USAGE_REQUEST_ROWS_BY_PROVIDER: Record<string, UsageRequestEntry[]> = {}
const EMPTY_STRING_LIST: string[] = []
export const USAGE_REQUESTS_CANONICAL_FETCH_HOURS = 24 * 365 * 20
export function buildUsageRequestsQueryKey(input: {
  hours: number
  fromUnixMs: number | null
  toUnixMs: number | null
  providers: string[] | null
  models: string[] | null
  origins: string[] | null
  sessions: string[] | null
  syntheticRevision?: string | null
}): string {
  const base: {
    hours: number
    from_unix_ms: number | null
    to_unix_ms: number | null
    providers: string[]
    models: string[]
    origins: string[]
    sessions: string[]
    synthetic_revision?: string
  } = {
    hours: input.hours,
    from_unix_ms: input.fromUnixMs,
    to_unix_ms: input.toUnixMs,
    providers: input.providers ?? [],
    models: input.models ?? [],
    origins: input.origins ?? [],
    sessions: input.sessions ?? [],
  }
  if (input.syntheticRevision != null && input.syntheticRevision.trim().length > 0) {
    base.synthetic_revision = input.syntheticRevision
  }
  return JSON.stringify(base)
}
export const USAGE_REQUESTS_CANONICAL_QUERY_KEY = buildUsageRequestsQueryKey({
  hours: USAGE_REQUESTS_CANONICAL_FETCH_HOURS,
  fromUnixMs: null,
  toUnixMs: null,
  providers: null,
  models: null,
  origins: null,
  sessions: null,
})
const USAGE_REQUESTS_CACHE_PRIMED_EVENT = 'ao:usage-requests-cache-primed'
const USAGE_REQUESTS_PAGE_PREFETCH_COOLDOWN_MS = 4_000
const USAGE_REQUEST_GRAPH_FETCH_HOURS = 24 * 365 * 20
const USAGE_REQUEST_GRAPH_BASE_FETCH_LIMIT = 1000
export const USAGE_REQUEST_GRAPH_QUERY_KEY = 'usage_request_graph:v1:all-history'
const USAGE_REQUEST_GRAPH_BACKGROUND_REFRESH_MS = 15_000
let usageRequestsPageCache: UsageRequestsPageCache | null = null
let usageRequestsLastNonEmptyPageCache: UsageRequestsPageCache | null = null
let usageRequestDailyTotalsCache: UsageRequestDailyTotalsCache | null = null
let usageRequestGraphRowsCache: UsageRequestGraphRowsCache | null = null
let usageRequestSyntheticRevisionCacheTag: string | null = null

export function resolveRequestFetchHours(input: {
  effectiveDetailsTab: UsageDetailsTab
  showFilters: boolean
  usageWindowHours: number
}): number {
  if (input.effectiveDetailsTab !== 'requests') return input.usageWindowHours
  if (!input.showFilters) return USAGE_REQUESTS_CANONICAL_FETCH_HOURS
  return input.usageWindowHours
}

export function buildUsageRequestEntriesArgs(input: {
  hours: number
  fromUnixMs: number | null
  toUnixMs: number | null
  providers: string[] | null
  models: string[] | null
  origins: string[] | null
  sessions: string[] | null
  limit: number
  offset: number
}) {
  return {
    hours: input.hours,
    fromUnixMs: input.fromUnixMs,
    toUnixMs: input.toUnixMs,
    providers: input.providers,
    models: input.models,
    origins: input.origins,
    sessions: input.sessions,
    limit: input.limit,
    offset: input.offset,
  }
}

function buildUsageRequestSummaryArgs(input: {
  hours: number
  fromUnixMs: number | null
  toUnixMs: number | null
  providers: string[] | null
  models: string[] | null
  origins: string[] | null
  sessions: string[] | null
}) {
  return {
    hours: input.hours,
    fromUnixMs: input.fromUnixMs,
    toUnixMs: input.toUnixMs,
    providers: input.providers,
    models: input.models,
    origins: input.origins,
    sessions: input.sessions,
  }
}

function emitUsageRequestsCachePrimed(queryKey: string) {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(USAGE_REQUESTS_CACHE_PRIMED_EVENT, { detail: { queryKey } }))
  } catch {
    // ignore
  }
}

function groupUsageRequestRowsByProvider(
  rows: UsageRequestEntry[],
  perProviderLimit = USAGE_REQUEST_GRAPH_SOURCE_LIMIT,
  providerLabel?: (provider: string) => string,
): Record<string, UsageRequestEntry[]> {
  const grouped = new Map<string, UsageRequestEntry[]>()
  for (const row of rows) {
    const provider = providerLabel ? providerLabel(row.provider) : row.provider
    const list = grouped.get(provider) ?? []
    if (list.length >= perProviderLimit) continue
    list.push(row)
    grouped.set(provider, list)
  }
  return Object.fromEntries(grouped.entries())
}

function mergeUsageRequestRowsUniqueNewestFirst(
  primary: UsageRequestEntry[],
  secondary: UsageRequestEntry[],
  limit: number,
): UsageRequestEntry[] {
  if (primary.length === 0) return secondary.slice(0, limit)
  if (secondary.length === 0) return primary.slice(0, limit)
  const seen = new Set<string>()
  const merged: UsageRequestEntry[] = []
  for (const row of [...primary, ...secondary]) {
    const id = usageRequestRowIdentity(row)
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(row)
  }
  return merged.sort((a, b) => b.unix_ms - a.unix_ms).slice(0, limit)
}

function areUsageRequestRowsIdentical(left: UsageRequestEntry[], right: UsageRequestEntry[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let idx = 0; idx < left.length; idx += 1) {
    if (usageRequestRowIdentity(left[idx]) !== usageRequestRowIdentity(right[idx])) return false
  }
  return true
}

type UsageRequestLiveLineAnimMeta = {
  prevValues: number[]
  prevPresent: boolean[]
  shiftSteps: number
  prevLastValue: number
}

function countUsageRequestLinePoints(present: boolean[]): number {
  let count = 0
  for (const value of present) {
    if (!value) continue
    count += 1
  }
  return count
}

function detectUsageRequestLineShiftSteps(
  prevPointIds: string[],
  prevCount: number,
  nextPointIds: string[],
  nextCount: number,
): number {
  const overlapCount = Math.min(prevCount, nextCount)
  if (overlapCount <= 1) return 0
  const maxShift = Math.max(0, prevCount - 1)
  for (let shift = 0; shift <= maxShift; shift += 1) {
    const compareCount = Math.min(prevCount - shift, nextCount)
    if (compareCount <= 0) continue
    let matches = true
    for (let idx = 0; idx < compareCount; idx += 1) {
      if ((prevPointIds[idx + shift] ?? '') !== (nextPointIds[idx] ?? '')) {
        matches = false
        break
      }
    }
    if (matches) return shift
  }
  return 0
}

function cloneUsageRequestLineSeries(series: UsageRequestLineSeries[]): UsageRequestLineSeries[] {
  return series.map((entry) => ({
    ...entry,
    values: [...entry.values],
    present: [...entry.present],
    pointIds: [...entry.pointIds],
  }))
}

function areUsageRequestLineSeriesIdentical(
  left: UsageRequestLineSeries[],
  right: UsageRequestLineSeries[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let idx = 0; idx < left.length; idx += 1) {
    const a = left[idx]
    const b = right[idx]
    if (a.id !== b.id) return false
    if (a.present.length !== b.present.length || a.values.length !== b.values.length) return false
    for (let point = 0; point < a.present.length; point += 1) {
      if (a.present[point] !== b.present[point]) return false
      if (a.values[point] !== b.values[point]) return false
      if ((a.pointIds[point] ?? '') !== (b.pointIds[point] ?? '')) return false
    }
  }
  return true
}

function primeUsageRequestGraphCacheFromBaseRows(baseRows: UsageRequestEntry[]) {
  if (!baseRows.length) return
  const grouped = groupUsageRequestRowsByProvider(baseRows)
  const existing =
    usageRequestGraphRowsCache != null && usageRequestGraphRowsCache.queryKey === USAGE_REQUEST_GRAPH_QUERY_KEY
      ? usageRequestGraphRowsCache
      : null
  if (!existing) {
    usageRequestGraphRowsCache = {
      queryKey: USAGE_REQUEST_GRAPH_QUERY_KEY,
      baseRows,
      rowsByProvider: grouped,
    }
    return
  }
  const mergedRowsByProvider: Record<string, UsageRequestEntry[]> = { ...existing.rowsByProvider }
  for (const [provider, rows] of Object.entries(grouped)) {
    mergedRowsByProvider[provider] = mergeUsageRequestRowsUniqueNewestFirst(
      rows,
      mergedRowsByProvider[provider] ?? [],
      USAGE_REQUEST_GRAPH_SOURCE_LIMIT,
    )
  }
  usageRequestGraphRowsCache = {
    queryKey: USAGE_REQUEST_GRAPH_QUERY_KEY,
    baseRows,
    rowsByProvider: mergedRowsByProvider,
  }
}

export function resolveRequestTableSummary(input: {
  usageRequestSummary: UsageRequestSummaryResponse | null
  displayedRows: UsageRequestEntry[]
  hasMore: boolean
  preferBackendSummary: boolean
}): UsageRequestTableSummary | null {
  if (input.preferBackendSummary && input.usageRequestSummary?.ok) {
    return {
      requests: input.usageRequestSummary.requests ?? 0,
      input: input.usageRequestSummary.input_tokens ?? 0,
      output: input.usageRequestSummary.output_tokens ?? 0,
      total: input.usageRequestSummary.total_tokens ?? 0,
      cacheCreate: input.usageRequestSummary.cache_creation_input_tokens ?? 0,
      cacheRead: input.usageRequestSummary.cache_read_input_tokens ?? 0,
    }
  }
  // Avoid showing partial totals from the first page when backend summary is unavailable.
  if (input.hasMore) return null
  const requests = input.displayedRows.length
  const totals = input.displayedRows.reduce(
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
}

export function primeUsageRequestsPrefetchCache(payload: {
  queryKey: string
  rows: UsageRequestEntry[]
  hasMore: boolean
  dailyTotals?: UsageRequestDailyTotalsCache | null
  usingTestFallback?: boolean
}) {
  const incomingRows = payload.rows ?? []
  const currentCache = usageRequestsPageCache
  const canReuseCurrentRows =
    incomingRows.length === 0 &&
    currentCache != null &&
    currentCache.queryKey === payload.queryKey &&
    currentCache.rows.length > 0
  const nextRows = canReuseCurrentRows ? currentCache.rows : incomingRows
  const nextHasMore = canReuseCurrentRows ? currentCache.hasMore : Boolean(payload.hasMore)
  const nextUsingTestFallback = canReuseCurrentRows
    ? currentCache.usingTestFallback
    : Boolean(payload.usingTestFallback)
  usageRequestsPageCache = {
    queryKey: payload.queryKey,
    rows: nextRows,
    hasMore: nextHasMore,
    usingTestFallback: nextUsingTestFallback,
  }
  if (nextRows.length > 0) {
    usageRequestsLastNonEmptyPageCache = {
      queryKey: payload.queryKey,
      rows: nextRows,
      hasMore: nextHasMore,
      usingTestFallback: nextUsingTestFallback,
    }
  }
  if (payload.dailyTotals) {
    usageRequestDailyTotalsCache = payload.dailyTotals
  }
  primeUsageRequestGraphCacheFromBaseRows(nextRows)
  emitUsageRequestsCachePrimed(payload.queryKey)
}

export function primeUsageRequestGraphPrefetchCache(payload: {
  queryKey?: string
  baseRows: UsageRequestEntry[]
  rowsByProvider: Record<string, UsageRequestEntry[]>
}) {
  usageRequestGraphRowsCache = {
    queryKey: payload.queryKey ?? USAGE_REQUEST_GRAPH_QUERY_KEY,
    baseRows: payload.baseRows ?? [],
    rowsByProvider: payload.rowsByProvider ?? {},
  }
}

export function resolveRequestPageCached(input: {
  isRequestsTab: boolean
  hasStrictRequestQuery: boolean
  cached: UsageRequestsPageCache | null
  canonicalCached: UsageRequestsPageCache | null
  lastNonEmpty: UsageRequestsPageCache | null
}): UsageRequestsPageCache | null {
  if (input.hasStrictRequestQuery) return input.cached
  if (input.isRequestsTab) return input.cached
  return input.cached ?? input.canonicalCached ?? input.lastNonEmpty
}

export function pickUsageRequestGraphBaseRows(input: {
  canonicalPageRows: UsageRequestEntry[]
  cachedGraphRows: UsageRequestEntry[]
  fallbackRows: UsageRequestEntry[]
}): UsageRequestEntry[] {
  const preferred = [
    input.canonicalPageRows,
    input.cachedGraphRows,
    input.fallbackRows,
  ]
  for (const rows of preferred) {
    if (rows.length > 0) return rows
  }
  return EMPTY_USAGE_REQUEST_ROWS
}

export function normalizeUsageRequestProviderFilter(
  providers: string[] | null,
): string[] | null {
  if (!providers || providers.length === 0) return null
  return [...new Set(providers.map((provider) => provider.trim()).filter(Boolean))]
}

export function filterUsageRequestRowsByProviderIds(
  rows: UsageRequestEntry[],
  selectedProviders: string[] | null,
): UsageRequestEntry[] {
  if (!selectedProviders || selectedProviders.length === 0) return rows
  const providerSet = new Set(selectedProviders)
  return rows.filter((row) => providerSet.has(String(row.provider ?? '').trim()))
}

export function resolveSummaryFetchWindow(input: {
  requestFetchFromUnixMs: number | null
  hasExplicitRequestFilters: boolean
  rowsForRequestRender: UsageRequestEntry[]
  requestDefaultDay: number
}): { fromUnixMs: number | null; toUnixMs: number | null } {
  const hasTodayRowsInRender = input.rowsForRequestRender.some(
    (row) => startOfDayUnixMs(row.unix_ms) === input.requestDefaultDay,
  )
  const fromUnixMs =
    input.requestFetchFromUnixMs ??
    (!input.hasExplicitRequestFilters && hasTodayRowsInRender ? input.requestDefaultDay : null)
  return {
    fromUnixMs,
    toUnixMs: fromUnixMs == null ? null : fromUnixMs + 24 * 60 * 60 * 1000,
  }
}

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

export function buildUsageRequestCalendarIndex(input: {
  isRequestsTab: boolean
  rowsForRequestRender: UsageRequestEntry[]
  usageRequestDailyTotalsDays: UsageRequestDailyTotalsResponse['days']
}): {
  daysWithRecords: Set<number>
  dayOriginFlags: Map<number, { win: boolean; wsl: boolean }>
} {
  const daysWithRecords = new Set<number>()
  const dayOriginFlags = new Map<number, { win: boolean; wsl: boolean }>()
  if (!input.isRequestsTab) return { daysWithRecords, dayOriginFlags }

  for (const day of input.usageRequestDailyTotalsDays) {
    if (!day || typeof day.day_start_unix_ms !== 'number') continue
    const dayStart = day.day_start_unix_ms
    daysWithRecords.add(dayStart)
    const winCount = Number(day.windows_request_count ?? 0)
    const wslCount = Number(day.wsl_request_count ?? 0)
    const win = Number.isFinite(winCount) && winCount > 0
    const wsl = Number.isFinite(wslCount) && wslCount > 0
    // Preserve a visible marker even when old payloads do not carry origin split counts.
    dayOriginFlags.set(dayStart, win || wsl ? { win, wsl } : { win: true, wsl: false })
  }

  for (const row of input.rowsForRequestRender) {
    const dayStart = startOfDayUnixMs(row.unix_ms)
    daysWithRecords.add(dayStart)
    const prev = dayOriginFlags.get(dayStart) ?? { win: false, wsl: false }
    const origin = normalizeUsageOrigin(row.origin)
    dayOriginFlags.set(dayStart, {
      win: prev.win || origin === 'windows' || origin === 'unknown',
      wsl: prev.wsl || origin === 'wsl2',
    })
  }

  return { daysWithRecords, dayOriginFlags }
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

function formatUsageRequestAxisCompact(value: number): string {
  const n = Math.max(0, Number.isFinite(value) ? value : 0)
  const formatCompact = (scaled: number, suffix: 'k' | 'M') => {
    const rounded = Math.round(scaled * 10) / 10
    return Number.isInteger(rounded) ? `${rounded}${suffix}` : `${rounded.toFixed(1)}${suffix}`
  }
  if (n >= 1_000_000) {
    return formatCompact(n / 1_000_000, 'M')
  }
  if (n >= 1_000) {
    return formatCompact(n / 1_000, 'k')
  }
  return String(Math.round(n))
}

export function readTestFlagFromLocation(): boolean {
  if (typeof window === 'undefined') return false
  const raw = new URLSearchParams(window.location.search).get('test')
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function isUnknownUsageProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase()
  return normalized.length === 0 || normalized === 'unknown' || normalized === '-'
}

function stableSeedFromText(text: string): number {
  let hash = 2166136261
  for (let idx = 0; idx < text.length; idx += 1) {
    hash ^= text.charCodeAt(idx)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function buildUsageRequestTestRows(
  stats: UsageStatistics | null,
  usageWindowHours: number,
  forceSyntheticProviders = false,
  clientSessions: Status['client_sessions'] = [],
): UsageRequestEntry[] {
  const summary = stats?.summary
  const summaryTotalRequests = summary?.total_requests ?? 0
  const baseTotalRequests = Math.max(0, Math.min(800, summaryTotalRequests))
  const totalRequests = Math.max(baseTotalRequests, USAGE_REQUEST_TEST_MIN_ROWS)
  if (totalRequests <= 0) return []
  const summaryProviders =
    summary?.by_provider
      ?.filter((row) => row.requests > 0)
      .map((row) => ({
        provider: row.provider?.trim() || '',
        model: 'unknown',
        requests: row.requests,
        apiKeyRef: row.api_key_ref ?? '-',
      })) ?? []
  const hasUsableSummaryProviders = summaryProviders.some((row) => !isUnknownUsageProvider(row.provider))
  const providers = !forceSyntheticProviders && hasUsableSummaryProviders
    ? summaryProviders.filter((row) => {
        return !isUnknownUsageProvider(row.provider)
      })
    : TEST_USAGE_PROVIDERS.map((row) => ({
        provider: row.provider,
        model: row.model,
        requests: Math.max(1, Math.round((totalRequests * row.requests) / 100)),
        apiKeyRef: row.apiKeyRef,
      }))
  const defaultProviderName = providers[0]?.provider?.trim() || TEST_USAGE_PROVIDERS[0].provider
  const providerMetaByName = new Map<string, { model: string; apiKeyRef: string }>()
  providers.forEach((item) => {
    const providerName = String(item.provider ?? '').trim()
    if (!providerName || providerMetaByName.has(providerName)) return
    providerMetaByName.set(providerName, {
      model: String(item.model ?? '').trim() || 'gpt-5.2-codex',
      apiKeyRef: String(item.apiKeyRef ?? '-').trim() || '-',
    })
  })
  const sessionSeedRows = (() => {
    const bySessionId = new Map<string, { sessionId: string; provider: string; origin: 'windows' | 'wsl2'; requests: number; verified: boolean }>()
    for (const session of clientSessions ?? []) {
      if (!session) continue
      if (session.is_agent || session.is_review) continue
      const sessionId = String(session.codex_session_id ?? '').trim() || String(session.id ?? '').trim()
      if (!sessionId) continue
      const providerCandidates = [
        String(session.current_provider ?? '').trim(),
        String(session.preferred_provider ?? '').trim(),
        String(session.reported_model_provider ?? '').trim(),
      ]
      const provider =
        providerCandidates.find((value) => value && value !== '-' && value.toLowerCase() !== 'api_router') ??
        defaultProviderName
      const wtSession = String(session.wt_session ?? '').trim().toLowerCase()
      const origin: 'windows' | 'wsl2' = wtSession.includes('wsl') ? 'wsl2' : 'windows'
      const requests = session.active ? 8 : 3
      const verified = Boolean(session.verified)
      const existing = bySessionId.get(sessionId)
      if (existing) {
        bySessionId.set(sessionId, {
          ...existing,
          provider,
          origin,
          requests: Math.max(existing.requests, requests),
          verified: existing.verified || verified,
        })
        continue
      }
      bySessionId.set(sessionId, { sessionId, provider, origin, requests, verified })
    }
    const all = [...bySessionId.values()]
    const verifiedOnly = all.filter((item) => item.verified)
    return (verifiedOnly.length > 0 ? verifiedOnly : all).map((item) => ({
      sessionId: item.sessionId,
      provider: item.provider,
      origin: item.origin,
      requests: Math.max(1, item.requests),
    }))
  })()
  const models = [{ model: 'gpt-5.2-codex', requests: totalRequests }]
  const generatedAt = Date.now()
  const windowMs = Math.max(usageWindowHours, USAGE_REQUEST_TEST_MIN_WINDOW_HOURS) * 60 * 60 * 1000
  const fingerprint = [
    String(totalRequests),
    ...providers.map((item) => `${item.provider}:${item.requests}`),
    ...sessionSeedRows.map((item) => `${item.sessionId}:${item.provider}:${item.requests}:${item.origin}`),
  ].join('|')
  let seed = stableSeedFromText(fingerprint || String(totalRequests))
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return seed / 4294967296
  }
  const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
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

  const baseSessions =
    sessionSeedRows.length > 0
      ? sessionSeedRows.slice(0, 8)
      : TEST_CODEX_SESSION_IDS.slice(0, 5).map((sessionId, index) => ({
          sessionId,
          provider: providers[index % providers.length]?.provider ?? defaultProviderName,
          origin: (index % 2 === 0 ? 'windows' : 'wsl2') as 'windows' | 'wsl2',
          requests: Math.max(1, 6 - index),
        }))
  type TestSessionPlan = {
    sessionId: string
    provider: string
    origin: 'windows' | 'wsl2'
    requestCount: number
  }
  let sessionPlans: TestSessionPlan[] = baseSessions.map((session, index) => {
    const normalizedRank = baseSessions.length <= 1 ? 1 : (baseSessions.length - 1 - index) / (baseSessions.length - 1)
    const preferredCount =
      index === 0
        ? USAGE_REQUEST_GRAPH_SOURCE_LIMIT
        : index === 1
          ? Math.round(56 + normalizedRank * 26)
          : index === 2
            ? Math.round(24 + normalizedRank * 18)
            : Math.round(2 + normalizedRank * 12)
    const activityBoost = session.requests >= 8 ? 12 : 0
    const jitter = Math.floor((rand() - 0.5) * (index <= 1 ? 8 : 5))
    return {
      sessionId: session.sessionId,
      provider: session.provider,
      origin: session.origin,
      requestCount: clampNumber(preferredCount + activityBoost + jitter, 1, USAGE_REQUEST_GRAPH_SOURCE_LIMIT),
    }
  })
  if (sessionPlans.length > 0 && totalRequests >= USAGE_REQUEST_GRAPH_SOURCE_LIMIT) {
    const first = sessionPlans[0]
    sessionPlans = [{ ...first, requestCount: USAGE_REQUEST_GRAPH_SOURCE_LIMIT }, ...sessionPlans.slice(1)]
  }
  const plannedPrimaryTotal = sessionPlans.reduce((sum, plan) => sum + plan.requestCount, 0)
  if (sessionPlans.length > 4 && plannedPrimaryTotal > totalRequests) {
    const scale = totalRequests / plannedPrimaryTotal
    sessionPlans = sessionPlans.map((plan, index) => ({
      ...plan,
      requestCount: clampNumber(
        Math.round(plan.requestCount * scale),
        index === 0 ? 6 : 1,
        USAGE_REQUEST_GRAPH_SOURCE_LIMIT,
      ),
    }))
  }

  const appendSessionRows = (
    sessionId: string,
    providerName: string,
    origin: 'windows' | 'wsl2',
    rawCount: number,
    trendIndex: number,
  ) => {
    const count = clampNumber(Math.round(rawCount), 1, USAGE_REQUEST_GRAPH_SOURCE_LIMIT)
    if (count <= 0) return 0
    const providerMeta = providerMetaByName.get(providerName) ?? { model: 'gpt-5.2-codex', apiKeyRef: '-' }
    const model = pick(models)
    const seriesSpanMs = clampNumber(
      Math.floor(windowMs * (0.34 + rand() * 0.42)),
      45 * 60 * 1000,
      windowMs,
    )
    const earliestAllowed = generatedAt - windowMs
    const latestStart = generatedAt - seriesSpanMs
    const startMs = clampNumber(
      latestStart - Math.floor(rand() * Math.max(1, windowMs * 0.2)),
      earliestAllowed,
      latestStart,
    )
    const stepMs = Math.max(45_000, Math.floor(seriesSpanMs / Math.max(1, count - 1)))
    const baseline = 92_000 + Math.floor(rand() * 38_000) + trendIndex * 900
    const driftPerPoint = 8 + Math.floor(rand() * 28)
    const waveAmplitude = 700 + Math.floor(rand() * 2_100)
    const wavePeriod = 22 + Math.floor(rand() * 26)
    const wavePhase = rand() * Math.PI * 2
    let carryNoise = (rand() - 0.5) * 900

    for (let idx = 0; idx < count; idx += 1) {
      carryNoise = carryNoise * 0.62 + (rand() - 0.5) * 920
      const wave = Math.sin((idx / wavePeriod) * Math.PI * 2 + wavePhase) * waveAmplitude
      const total = clampNumber(
        Math.round(baseline + idx * driftPerPoint + wave + carryNoise),
        55_000,
        230_000,
      )
      const output = Math.max(1_000, Math.round(total * (0.055 + rand() * 0.07)))
      const input = Math.max(1, total - output)
      const cacheCreate = idx % 11 === 0 ? Math.max(0, Math.round(total * (0.28 + rand() * 0.22))) : 0
      const cacheRead = idx % 5 === 0 ? Math.max(0, Math.round(total * (0.24 + rand() * 0.2))) : 0
      const unixMs = clampNumber(
        startMs + idx * stepMs + Math.floor((rand() - 0.5) * stepMs * 0.3),
        earliestAllowed,
        generatedAt,
      )
      rows.push({
        provider: providerName,
        api_key_ref: providerMeta.apiKeyRef,
        model: providerMeta.model || model.model,
        origin,
        session_id: sessionId,
        unix_ms: unixMs,
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      })
    }
    return count
  }

  let allocated = 0
  sessionPlans.forEach((plan, index) => {
    allocated += appendSessionRows(plan.sessionId, plan.provider, plan.origin, plan.requestCount, index)
  })

  let remaining = Math.max(0, totalRequests - allocated)
  let auxIndex = 0
  while (remaining > 0) {
    const providerName = pick(providers).provider
    const origin: 'windows' | 'wsl2' = auxIndex % 2 === 0 ? 'windows' : 'wsl2'
    const chunk = Math.min(remaining, 20 + Math.floor(rand() * 44))
    const sessionId = `test-aux-session-${String(auxIndex + 1).padStart(2, '0')}`
    allocated += appendSessionRows(sessionId, providerName, origin, chunk, sessionPlans.length + auxIndex)
    remaining = Math.max(0, totalRequests - allocated)
    auxIndex += 1
  }
  return rows.sort((a, b) => b.unix_ms - a.unix_ms)
}

function buildDailyTotalsCacheFromRows(
  rows: UsageRequestEntry[],
  dayLimit: number,
  providerLabel?: (provider: string) => string,
): UsageRequestDailyTotalsCache {
  const byDay = new Map<number, Map<string, number>>()
  const providerTotals = new Map<string, number>()
  for (const row of rows) {
    const provider = providerLabel ? providerLabel(row.provider) : row.provider
    const day = startOfDayUnixMs(row.unix_ms)
    const dayMap = byDay.get(day) ?? new Map<string, number>()
    dayMap.set(provider, (dayMap.get(provider) ?? 0) + row.total_tokens)
    byDay.set(day, dayMap)
    providerTotals.set(provider, (providerTotals.get(provider) ?? 0) + row.total_tokens)
  }
  const latestDays = [...byDay.keys()].sort((a, b) => b - a).slice(0, Math.max(1, dayLimit))
  const days = latestDays
    .sort((a, b) => a - b)
    .map((day) => {
      const map = byDay.get(day) ?? new Map<string, number>()
      const provider_totals = Object.fromEntries(map.entries())
      const total_tokens = [...map.values()].reduce((sum, v) => sum + v, 0)
      return {
        day_start_unix_ms: day,
        provider_totals,
        total_tokens,
      }
    })
  const providers = [...providerTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([provider, total_tokens]) => ({ provider, total_tokens }))
  return { days, providers }
}

type Props = {
  config: Config | null
  usageWindowHours: number
  setUsageWindowHours: (hours: number) => void
  usageStatisticsLoading: boolean
  usageFilterProviders: string[]
  setUsageFilterProviders: (providers: string[]) => void
  usageProviderFilterOptions: string[]
  usageProviderFilterDisplayOptions: UsageProviderFilterDisplayOption[]
  toggleUsageProviderFilterDisplayOption: (providers: string[]) => void
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
  clientSessions?: Status['client_sessions']
  forceDetailsTab?: UsageDetailsTab
  showFilters?: boolean
}

export function UsageStatisticsPanel({
  config,
  usageWindowHours,
  setUsageWindowHours,
  usageStatisticsLoading,
  usageFilterProviders,
  setUsageFilterProviders,
  usageProviderFilterOptions,
  usageProviderFilterDisplayOptions,
  toggleUsageProviderFilterDisplayOption,
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
  clientSessions = [],
  forceDetailsTab,
  showFilters = true,
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
  const [usageRequestRows, setUsageRequestRows] = useState<UsageRequestEntry[]>([])
  const [usageRequestGraphBaseRows, setUsageRequestGraphBaseRows] = useState<UsageRequestEntry[]>([])
  const [usageRequestGraphRowsByProvider, setUsageRequestGraphRowsByProvider] = useState<
    Record<string, UsageRequestEntry[]>
  >({})
  const [usageRequestTableScrollLeft, setUsageRequestTableScrollLeft] = useState(0)
  const [usageRequestHasMore, setUsageRequestHasMore] = useState(false)
  const [usageRequestLoading, setUsageRequestLoading] = useState(false)
  const [usageRequestError, setUsageRequestError] = useState('')
  const [usageRequestSummary, setUsageRequestSummary] = useState<UsageRequestSummaryResponse | null>(null)
  const [usageRequestUsingTestFallback, setUsageRequestUsingTestFallback] = useState(false)
  const [usageRequestMergeTick, setUsageRequestMergeTick] = useState(0)
  const [usageRequestDailyTotalsDays, setUsageRequestDailyTotalsDays] = useState<
    UsageRequestDailyTotalsResponse['days']
  >([])
  const [usageRequestDailyTotalsProviders, setUsageRequestDailyTotalsProviders] = useState<
    UsageRequestDailyTotalsResponse['providers']
  >([])
  const [usageRequestDailyTotalsLoading, setUsageRequestDailyTotalsLoading] = useState(false)
  const [usageRequestsCachePrimedTick, setUsageRequestsCachePrimedTick] = useState(0)
  const providerGroupMaps = useMemo(() => buildProviderGroupMaps(config), [config])
  const resolveRequestProviderName = useCallback(
    (provider: string) => resolveProviderDisplayName(providerGroupMaps.displayNameByProvider, provider),
    [providerGroupMaps.displayNameByProvider],
  )
  const usageRequestDailyProviderHints = useMemo(
    () => normalizeUsageRequestProviderFilter(listUsageRequestDailyProviderHints(usageRequestDailyTotalsProviders)) ?? [],
    [usageRequestDailyTotalsProviders, usageRequestsCachePrimedTick],
  )
  const usageRequestAnalyticsProviderHints = useMemo(() => {
    const out: string[] = []
    for (const row of usageByProvider) {
      const provider = String(row?.provider ?? '').trim()
      if (provider.length > 0) out.push(provider)
    }
    const configuredProviders =
      config && typeof config === 'object' && config.providers && typeof config.providers === 'object'
        ? Object.keys(config.providers)
        : []
    for (const provider of configuredProviders) {
      const key = String(provider ?? '').trim()
      if (key.length > 0) out.push(key)
    }
    return normalizeUsageRequestProviderFilter(out) ?? []
  }, [config, usageByProvider])
  const verifiedSessionIdSet = useMemo(() => {
    const ids = new Set<string>()
    for (const session of clientSessions ?? []) {
      if (!session?.verified) continue
      if (session.is_agent || session.is_review) continue
      const codexSessionId = String(session.codex_session_id ?? '').trim()
      if (codexSessionId) ids.add(codexSessionId)
      const fallbackSessionId = String(session.id ?? '').trim()
      if (fallbackSessionId) ids.add(fallbackSessionId)
    }
    return ids
  }, [clientSessions])
  const usageRequestRefreshInFlightRef = useRef(false)
  const usageRequestRefreshPendingRef = useRef(false)
  const usageRequestRefreshPendingLimitRef = useRef(USAGE_REQUEST_PAGE_SIZE)
  const usageRequestGraphRefreshInFlightRef = useRef(false)
  const usageRequestGraphRefreshPendingRef = useRef(false)
  const usageRequestGraphLastRefreshAtRef = useRef(0)
  const usageRequestFetchSeqRef = useRef(0)
  const usageRequestSummaryFetchSeqRef = useRef(0)
  const usageRequestGraphBaseFetchSeqRef = useRef(0)
  const usageRequestDailyTotalsFetchSeqRef = useRef(0)
  const usageRequestLoadedQueryKeyRef = useRef<string | null>(null)
  const usageRequestResolvedQueryKeyRef = useRef<string | null>(null)
  const usageRequestPrevQueryKeyRef = useRef<string | null>(null)
  const usageRequestLastRenderedRowsRef = useRef<UsageRequestEntry[]>([])
  const usageRequestLastActivityRef = useRef<number | null>(null)
  const usageRequestWasNearBottomRef = useRef(false)
  const usageRequestWarmupAtRef = useRef(0)
  const usageRequestDefaultTodayAutoPageRef = useRef(false)
  const usageRequestsPagePrefetchInFlightRef = useRef(false)
  const usageRequestsPagePrefetchAtRef = useRef(0)
  const usageRequestForceSyntheticProviders = useMemo(() => readTestFlagFromLocation(), [])
  const usageRequestTestFallbackEnabled = useMemo(
    () => usageRequestForceSyntheticProviders || import.meta.env.DEV,
    [usageRequestForceSyntheticProviders],
  )
  useEffect(() => {
    const nextTag = usageRequestTestFallbackEnabled ? USAGE_REQUEST_TEST_DATA_REVISION : null
    if (usageRequestSyntheticRevisionCacheTag === nextTag) return
    usageRequestSyntheticRevisionCacheTag = nextTag
    usageRequestsPageCache = null
    usageRequestsLastNonEmptyPageCache = null
    usageRequestDailyTotalsCache = null
    usageRequestGraphRowsCache = null
    usageRequestGraphLastRefreshAtRef.current = 0
    setUsageRequestRows([])
    setUsageRequestHasMore(false)
    setUsageRequestUsingTestFallback(false)
    setUsageRequestGraphBaseRows([])
    setUsageRequestGraphRowsByProvider({})
    setUsageRequestDailyTotalsDays([])
    setUsageRequestDailyTotalsProviders([])
  }, [usageRequestTestFallbackEnabled])
  const usageRequestTestRows = useMemo(
    () => buildUsageRequestTestRows(usageStatistics, usageWindowHours, usageRequestForceSyntheticProviders, clientSessions),
    [clientSessions, usageRequestForceSyntheticProviders, usageStatistics, usageWindowHours],
  )
  const useGlobalRequestFilters = showFilters
  // Keep table column filters client-side so unselected options remain visible in the filter menu.
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
  const requestFetchSessions: string[] | null = null
  const hasExplicitTimeFilter = usageRequestTimeFilter.trim().length > 0
  const selectedRequestTimeFilterDay = useMemo(
    () => parseDateInputToDayStart(usageRequestTimeFilter),
    [usageRequestTimeFilter],
  )
  const requestFetchFromUnixMs = selectedRequestTimeFilterDay
  const requestFetchToUnixMs =
    selectedRequestTimeFilterDay == null ? null : selectedRequestTimeFilterDay + 24 * 60 * 60 * 1000
  const requestFetchHours = resolveRequestFetchHours({
    effectiveDetailsTab: forceDetailsTab ?? 'requests',
    showFilters,
    usageWindowHours,
  })
  const requestQueryKey = useMemo(
    () =>
      buildUsageRequestsQueryKey({
        hours: requestFetchHours,
        fromUnixMs: requestFetchFromUnixMs,
        toUnixMs: requestFetchToUnixMs,
        providers: requestFetchProviders,
        models: requestFetchModels,
        origins: requestFetchOrigins,
        sessions: requestFetchSessions,
        syntheticRevision: usageRequestTestFallbackEnabled ? USAGE_REQUEST_TEST_DATA_REVISION : null,
      }),
    [
      requestFetchFromUnixMs,
      requestFetchHours,
      requestFetchModels,
      requestFetchOrigins,
      requestFetchProviders,
      requestFetchSessions,
      requestFetchToUnixMs,
      usageRequestTestFallbackEnabled,
    ],
  )
  const requestGraphQueryKey = useMemo(
    () =>
      usageRequestTestFallbackEnabled
        ? `${USAGE_REQUEST_GRAPH_QUERY_KEY}:${USAGE_REQUEST_TEST_DATA_REVISION}`
        : USAGE_REQUEST_GRAPH_QUERY_KEY,
    [usageRequestTestFallbackEnabled],
  )
  const hasExplicitRequestFilters =
    hasExplicitTimeFilter ||
    usageRequestMultiFilters.provider !== null ||
    usageRequestMultiFilters.model !== null ||
    usageRequestMultiFilters.origin !== null ||
    usageRequestMultiFilters.session !== null
  const hasStrictRequestQuery = hasExplicitRequestFilters
  const hasImpossibleRequestFilters =
    (requestFetchProviders !== null && requestFetchProviders.length === 0) ||
    (requestFetchModels !== null && requestFetchModels.length === 0) ||
    (requestFetchOrigins !== null && requestFetchOrigins.length === 0) ||
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
  const effectiveDetailsTab = forceDetailsTab ?? 'requests'
  const isRequestsTab = effectiveDetailsTab === 'requests'
  const isAnalyticsTab = effectiveDetailsTab === 'analytics'
  const requestsTabSeenRef = useRef(false)
  const justEnteredRequestsTab = isRequestsTab && !requestsTabSeenRef.current
  const [requestTabImmediateRender, setRequestTabImmediateRender] = useState(false)
  const shouldUseImmediateRequestRows = isRequestsTab && (justEnteredRequestsTab || requestTabImmediateRender)
  const shouldPrepareRequestsData = isRequestsTab
  const isRequestsOnlyPage = effectiveDetailsTab === 'requests' && !showFilters
  const cachedRequestsPage =
    usageRequestsPageCache != null && usageRequestsPageCache.queryKey === requestQueryKey
      ? usageRequestsPageCache
      : null
  const canonicalRequestsPageCache =
    usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_CANONICAL_QUERY_KEY
      ? usageRequestsPageCache
      : null
  const lastNonEmptyRequestsPageCache = usageRequestsLastNonEmptyPageCache
  const cachedGraphRows =
    usageRequestGraphRowsCache != null && usageRequestGraphRowsCache.queryKey === requestGraphQueryKey
      ? usageRequestGraphRowsCache
      : null
  const deferredUsageRequestRows = useDeferredValue(usageRequestRows)
  const requestRowsForRender = shouldUseImmediateRequestRows ? usageRequestRows : deferredUsageRequestRows
  const rowsForRequestRender = isRequestsTab
    ? requestRowsForRender.length > 0
      ? requestRowsForRender
      : usageRequestRows.length > 0
        ? usageRequestRows
        : cachedRequestsPage?.rows ??
          canonicalRequestsPageCache?.rows ??
          lastNonEmptyRequestsPageCache?.rows ??
          EMPTY_USAGE_REQUEST_ROWS
    : EMPTY_USAGE_REQUEST_ROWS
  const deferredUsageRequestGraphBaseRows = useDeferredValue(usageRequestGraphBaseRows)
  const graphBaseRowsForRequestRender = shouldPrepareRequestsData
    ? deferredUsageRequestGraphBaseRows.length > 0 &&
      usageRequestGraphBaseRows.length > 0 &&
      usageRequestRowIdentity(deferredUsageRequestGraphBaseRows[0]) !== usageRequestRowIdentity(usageRequestGraphBaseRows[0])
      ? usageRequestGraphBaseRows
      : deferredUsageRequestGraphBaseRows.length > 0
        ? deferredUsageRequestGraphBaseRows
        : usageRequestGraphBaseRows.length > 0
          ? usageRequestGraphBaseRows
          : cachedGraphRows?.baseRows ?? EMPTY_USAGE_REQUEST_ROWS
    : EMPTY_USAGE_REQUEST_ROWS
  const usageRequestGraphProviderCount = useMemo(
    () => Object.keys(usageRequestGraphRowsByProvider).length,
    [usageRequestGraphRowsByProvider],
  )

  useEffect(() => {
    requestsTabSeenRef.current = isRequestsTab
  }, [isRequestsTab])
  useEffect(() => {
    if (usageRequestPrevQueryKeyRef.current === requestQueryKey) return
    usageRequestPrevQueryKeyRef.current = requestQueryKey
    usageRequestResolvedQueryKeyRef.current = null
  }, [requestQueryKey])
  useEffect(() => {
    if (isRequestsTab) return
    usageRequestLastRenderedRowsRef.current = []
  }, [isRequestsTab])

  useEffect(() => {
    if (!isRequestsTab) {
      setRequestTabImmediateRender(false)
      return
    }
    setRequestTabImmediateRender(true)
    const timer = window.setTimeout(() => {
      setRequestTabImmediateRender(false)
    }, 1500)
    return () => {
      window.clearTimeout(timer)
    }
  }, [isRequestsTab, requestQueryKey])

  useEffect(() => {
    if (!isRequestsTab) return
    usageRequestDefaultTodayAutoPageRef.current = false
  }, [isRequestsTab, requestQueryKey, requestDefaultDay])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPrimed = () => {
      setUsageRequestsCachePrimedTick((tick) => tick + 1)
    }
    window.addEventListener(USAGE_REQUESTS_CACHE_PRIMED_EVENT, onPrimed)
    return () => window.removeEventListener(USAGE_REQUESTS_CACHE_PRIMED_EVENT, onPrimed)
  }, [])

  useEffect(() => {
    if (!isRequestsOnlyPage) return
    // Keep existing request filters when switching pages/tabs; only close any floating menu.
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
  ])

  useEffect(() => () => clearUsageRequestScrollbarTimers(), [clearUsageRequestScrollbarTimers])

  const refreshUsageRequests = useCallback(
    async (limit: number) => {
      if (usageRequestRefreshInFlightRef.current) {
        usageRequestRefreshPendingRef.current = true
        usageRequestRefreshPendingLimitRef.current = limit
        return
      }
      usageRequestRefreshInFlightRef.current = true
      const requestSeq = usageRequestFetchSeqRef.current + 1
      usageRequestFetchSeqRef.current = requestSeq
      setUsageRequestLoading(true)
      setUsageRequestError('')
      setUsageRequestUsingTestFallback(false)
      try {
        const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
          ...buildUsageRequestEntriesArgs({
            hours: requestFetchHours,
            fromUnixMs: requestFetchFromUnixMs,
            toUnixMs: requestFetchToUnixMs,
            providers: requestFetchProviders,
            models: requestFetchModels,
            origins: requestFetchOrigins,
            sessions: requestFetchSessions,
            limit,
            offset: 0,
          }),
        })
        if (usageRequestFetchSeqRef.current !== requestSeq) return
        const nextRows = res.rows ?? []
        setUsageRequestRows(nextRows)
        setUsageRequestHasMore(Boolean(res.has_more))
        usageRequestResolvedQueryKeyRef.current = requestQueryKey
        if (nextRows.length > 0) {
          usageRequestsLastNonEmptyPageCache = {
            queryKey: requestQueryKey,
            rows: nextRows,
            hasMore: Boolean(res.has_more),
            usingTestFallback: false,
          }
        }
      } catch (e) {
        if (usageRequestFetchSeqRef.current !== requestSeq) return
        if (usageRequestTestFallbackEnabled) {
          const next = usageRequestTestRows.slice(0, Math.min(limit, usageRequestTestRows.length))
          setUsageRequestRows(next)
          setUsageRequestHasMore(usageRequestTestRows.length > next.length)
          setUsageRequestUsingTestFallback(true)
          setUsageRequestError('')
          usageRequestResolvedQueryKeyRef.current = requestQueryKey
          if (next.length > 0) {
            usageRequestsLastNonEmptyPageCache = {
              queryKey: requestQueryKey,
              rows: next,
              hasMore: usageRequestTestRows.length > next.length,
              usingTestFallback: true,
            }
          }
        } else {
          setUsageRequestRows([])
          setUsageRequestHasMore(false)
          setUsageRequestError(String(e))
          usageRequestResolvedQueryKeyRef.current = requestQueryKey
        }
      } finally {
        usageRequestRefreshInFlightRef.current = false
        if (usageRequestFetchSeqRef.current === requestSeq) {
          setUsageRequestLoading(false)
        }
        if (usageRequestRefreshPendingRef.current) {
          const nextLimit = usageRequestRefreshPendingLimitRef.current
          usageRequestRefreshPendingRef.current = false
          void refreshUsageRequests(nextLimit)
        }
      }
    },
    [
      requestFetchHours,
      requestFetchFromUnixMs,
      requestFetchProviders,
      requestFetchModels,
      requestFetchOrigins,
      requestFetchSessions,
      requestFetchToUnixMs,
      requestQueryKey,
      usageRequestTestFallbackEnabled,
      usageRequestTestRows,
    ],
  )
  const refreshUsageRequestSummary = useCallback(async () => {
    const requestSeq = usageRequestSummaryFetchSeqRef.current + 1
    usageRequestSummaryFetchSeqRef.current = requestSeq
    if (!isRequestsTab) return
    if (hasImpossibleRequestFilters) {
      if (usageRequestSummaryFetchSeqRef.current !== requestSeq) return
      setUsageRequestSummary({
        ok: true,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
      return
    }
    const { fromUnixMs: summaryFetchFromUnixMs, toUnixMs: summaryFetchToUnixMs } =
      resolveSummaryFetchWindow({
        requestFetchFromUnixMs,
        hasExplicitRequestFilters,
        rowsForRequestRender,
        requestDefaultDay,
      })
    try {
      const res = await invoke<UsageRequestSummaryResponse>(
        'get_usage_request_summary',
        buildUsageRequestSummaryArgs({
          hours: requestFetchHours,
          fromUnixMs: summaryFetchFromUnixMs,
          toUnixMs: summaryFetchToUnixMs,
          providers: requestFetchProviders,
          models: requestFetchModels,
          origins: requestFetchOrigins,
          sessions: requestFetchSessions,
        }),
      )
      if (usageRequestSummaryFetchSeqRef.current !== requestSeq) return
      setUsageRequestSummary(res)
    } catch {
      if (usageRequestSummaryFetchSeqRef.current !== requestSeq) return
      setUsageRequestSummary(null)
    }
  }, [
    hasImpossibleRequestFilters,
    isRequestsTab,
    requestFetchHours,
    requestFetchFromUnixMs,
    requestFetchModels,
    requestFetchOrigins,
    requestFetchProviders,
    requestFetchSessions,
    hasExplicitRequestFilters,
    requestDefaultDay,
    rowsForRequestRender,
  ])
  const mergeLatestUsageRequests = useCallback(
    async (limit: number) => {
      if (usageRequestRefreshInFlightRef.current) return
      usageRequestRefreshInFlightRef.current = true
      const requestSeq = usageRequestFetchSeqRef.current + 1
      usageRequestFetchSeqRef.current = requestSeq
      try {
        const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
          ...buildUsageRequestEntriesArgs({
            hours: requestFetchHours,
            fromUnixMs: requestFetchFromUnixMs,
            toUnixMs: requestFetchToUnixMs,
            providers: requestFetchProviders,
            models: requestFetchModels,
            origins: requestFetchOrigins,
            sessions: requestFetchSessions,
            limit,
            offset: 0,
          }),
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
        usageRequestsLastNonEmptyPageCache = {
          queryKey: requestQueryKey,
          rows: incoming,
          hasMore: Boolean(res.has_more),
          usingTestFallback: false,
        }
      } catch {
        // Keep current rows when background merge fails.
      } finally {
        usageRequestRefreshInFlightRef.current = false
        setUsageRequestMergeTick((tick) => tick + 1)
        if (usageRequestRefreshPendingRef.current) {
          const nextLimit = usageRequestRefreshPendingLimitRef.current
          usageRequestRefreshPendingRef.current = false
          void refreshUsageRequests(nextLimit)
        }
      }
    },
    [
      requestFetchFromUnixMs,
      requestFetchHours,
      requestFetchModels,
      requestFetchOrigins,
      requestFetchProviders,
      requestFetchSessions,
      requestFetchToUnixMs,
      requestQueryKey,
      refreshUsageRequests,
    ],
  )
  const prefetchUsageRequestsPageCache = useCallback(async (limit: number) => {
    if (usageRequestsPagePrefetchInFlightRef.current) return
    const now = Date.now()
    if (now - usageRequestsPagePrefetchAtRef.current < USAGE_REQUESTS_PAGE_PREFETCH_COOLDOWN_MS) return
    const cached =
      usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_CANONICAL_QUERY_KEY
        ? usageRequestsPageCache
        : null
    if (cached && cached.rows.length > 0) return
    usageRequestsPagePrefetchAtRef.current = now
    usageRequestsPagePrefetchInFlightRef.current = true
    try {
      const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
        ...buildUsageRequestEntriesArgs({
          hours: USAGE_REQUESTS_CANONICAL_FETCH_HOURS,
          fromUnixMs: null,
          toUnixMs: null,
          providers: null,
          models: null,
          origins: null,
          sessions: null,
          limit,
          offset: 0,
        }),
      })
      const nextRows = res.rows ?? []
      usageRequestsPageCache = {
        queryKey: USAGE_REQUESTS_CANONICAL_QUERY_KEY,
        rows: nextRows,
        hasMore: Boolean(res.has_more),
        usingTestFallback: false,
      }
      if (nextRows.length > 0) {
        usageRequestsLastNonEmptyPageCache = {
          queryKey: USAGE_REQUESTS_CANONICAL_QUERY_KEY,
          rows: nextRows,
          hasMore: Boolean(res.has_more),
          usingTestFallback: false,
        }
        primeUsageRequestGraphCacheFromBaseRows(nextRows)
      }
      emitUsageRequestsCachePrimed(USAGE_REQUESTS_CANONICAL_QUERY_KEY)
    } catch {
      if (usageRequestTestFallbackEnabled) {
        const nextRows = usageRequestTestRows.slice(0, Math.max(1, limit))
        usageRequestsPageCache = {
          queryKey: USAGE_REQUESTS_CANONICAL_QUERY_KEY,
          rows: nextRows,
          hasMore: usageRequestTestRows.length > nextRows.length,
          usingTestFallback: true,
        }
        if (nextRows.length > 0) {
          usageRequestsLastNonEmptyPageCache = usageRequestsPageCache
          primeUsageRequestGraphCacheFromBaseRows(nextRows)
        }
        emitUsageRequestsCachePrimed(USAGE_REQUESTS_CANONICAL_QUERY_KEY)
      }
    } finally {
      usageRequestsPagePrefetchInFlightRef.current = false
    }
  }, [usageRequestTestFallbackEnabled, usageRequestTestRows])
  const refreshUsageRequestGraphRows = useCallback(async () => {
    if (usageRequestGraphRefreshInFlightRef.current) {
      usageRequestGraphRefreshPendingRef.current = true
      return
    }
    usageRequestGraphRefreshInFlightRef.current = true
    const requestSeq = usageRequestGraphBaseFetchSeqRef.current + 1
    usageRequestGraphBaseFetchSeqRef.current = requestSeq
    try {
      const cachedGraph =
        usageRequestGraphRowsCache != null && usageRequestGraphRowsCache.queryKey === requestGraphQueryKey
          ? usageRequestGraphRowsCache
          : null
      const canonicalPageRowsFromCache =
        usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_CANONICAL_QUERY_KEY
          ? usageRequestsPageCache.rows
          : EMPTY_USAGE_REQUEST_ROWS
      let canonicalPageRows = canonicalPageRowsFromCache
      try {
        const canonicalRes = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
          ...buildUsageRequestEntriesArgs({
            hours: USAGE_REQUESTS_CANONICAL_FETCH_HOURS,
            fromUnixMs: null,
            toUnixMs: null,
            providers: null,
            models: null,
            origins: null,
            sessions: null,
            limit: USAGE_REQUEST_GRAPH_BASE_FETCH_LIMIT,
            offset: 0,
          }),
        })
        if (usageRequestGraphBaseFetchSeqRef.current !== requestSeq) return
        canonicalPageRows = (canonicalRes.rows ?? []).sort((a, b) => b.unix_ms - a.unix_ms)
      } catch {
        canonicalPageRows = canonicalPageRowsFromCache
      }
      const fallbackRows = usageRequestTestFallbackEnabled ? usageRequestTestRows : EMPTY_USAGE_REQUEST_ROWS
      const baseRows = pickUsageRequestGraphBaseRows({
        canonicalPageRows,
        cachedGraphRows: cachedGraph?.baseRows ?? EMPTY_USAGE_REQUEST_ROWS,
        fallbackRows,
      })
      if (usageRequestGraphBaseFetchSeqRef.current !== requestSeq) return

      if (usageRequestTestFallbackEnabled && baseRows === usageRequestTestRows && usageRequestTestRows.length > 0) {
        const fallbackRowsByProvider = groupUsageRequestRowsByProvider(usageRequestTestRows)
        setUsageRequestGraphBaseRows(usageRequestTestRows)
        setUsageRequestGraphRowsByProvider(fallbackRowsByProvider)
        usageRequestGraphRowsCache = {
          queryKey: requestGraphQueryKey,
          baseRows: usageRequestTestRows,
          rowsByProvider: fallbackRowsByProvider,
        }
        usageRequestGraphLastRefreshAtRef.current = Date.now()
        return
      }

      setUsageRequestGraphBaseRows((prev) =>
        areUsageRequestRowsIdentical(prev, baseRows) ? prev : baseRows,
      )
      const providerTargets = pickUsageRequestDisplayProviders({
        graphProviders: [
          ...(baseRows.length ? listTopUsageProvidersFromRows(baseRows) : EMPTY_STRING_LIST),
          ...Object.keys(usageRequestGraphRowsCache?.rowsByProvider ?? {}),
        ],
        dailyProviders: usageRequestDailyProviderHints,
        analyticsProviders: usageRequestAnalyticsProviderHints,
        limit: Math.min(3, USAGE_REQUEST_GRAPH_COLORS.length),
      })
      if (providerTargets.length === 0) {
        usageRequestGraphLastRefreshAtRef.current = Date.now()
        return
      }
      const targetSet = new Set(providerTargets)
      const bootstrapRowsByProvider = baseRows.length ? groupUsageRequestRowsByProvider(baseRows) : EMPTY_USAGE_REQUEST_ROWS_BY_PROVIDER
      const seedRowsByProvider: Record<string, UsageRequestEntry[]> = {}
      for (const provider of providerTargets) {
        const fromCache = usageRequestGraphRowsCache?.rowsByProvider?.[provider] ?? EMPTY_USAGE_REQUEST_ROWS
        const fromBootstrap = bootstrapRowsByProvider[provider] ?? EMPTY_USAGE_REQUEST_ROWS
        seedRowsByProvider[provider] = mergeUsageRequestRowsUniqueNewestFirst(
          fromBootstrap,
          fromCache,
          USAGE_REQUEST_GRAPH_SOURCE_LIMIT,
        )
      }
      setUsageRequestGraphRowsByProvider((prev) => {
        const next: Record<string, UsageRequestEntry[]> = { ...prev }
        let changed = false
        for (const provider of providerTargets) {
          const existingRows = prev[provider]
          const seedRows = seedRowsByProvider[provider]
          if (existingRows && existingRows.length) {
            next[provider] = existingRows
          } else if (seedRows && seedRows.length) {
            next[provider] = seedRows
            changed = true
          } else if (Object.prototype.hasOwnProperty.call(next, provider)) {
            delete next[provider]
            changed = true
          }
        }
        if (!changed && Object.keys(prev).every((provider) => targetSet.has(provider))) return prev
        return next
      })
      const existingCacheRows =
        usageRequestGraphRowsCache?.queryKey === requestGraphQueryKey ? usageRequestGraphRowsCache.rowsByProvider : {}
      usageRequestGraphRowsCache = {
        queryKey: requestGraphQueryKey,
        baseRows,
        rowsByProvider: {
          ...existingCacheRows,
          ...seedRowsByProvider,
        },
      }
      await Promise.all(
        providerTargets.map(async (provider) => {
          let providerRows: UsageRequestEntry[] | null = null
          try {
            const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
              ...buildUsageRequestEntriesArgs({
                hours: USAGE_REQUEST_GRAPH_FETCH_HOURS,
                fromUnixMs: null,
                toUnixMs: null,
                providers: [provider],
                models: null,
                origins: null,
                sessions: null,
                limit: USAGE_REQUEST_GRAPH_SOURCE_LIMIT,
                offset: 0,
              }),
            })
            providerRows = (res.rows ?? []).sort((a, b) => b.unix_ms - a.unix_ms)
          } catch {
            providerRows = null
          }
          if (!providerRows || usageRequestGraphBaseFetchSeqRef.current !== requestSeq) return
          setUsageRequestGraphRowsByProvider((prev) => {
            const currentRows = prev[provider] ?? EMPTY_USAGE_REQUEST_ROWS
            const same =
              currentRows.length === providerRows.length &&
              currentRows.every((row, idx) => usageRequestRowIdentity(row) === usageRequestRowIdentity(providerRows[idx]))
            if (same) return prev
            const next = { ...prev, [provider]: providerRows }
            if (usageRequestGraphRowsCache?.queryKey === requestGraphQueryKey) {
              usageRequestGraphRowsCache = {
                ...usageRequestGraphRowsCache,
                rowsByProvider: next,
              }
            }
            return next
          })
        }),
      )
      if (usageRequestGraphBaseFetchSeqRef.current !== requestSeq) return
      usageRequestGraphLastRefreshAtRef.current = Date.now()
    } catch {
      if (usageRequestGraphBaseFetchSeqRef.current !== requestSeq) return
      if (usageRequestTestFallbackEnabled) {
        const fallbackRowsByProvider = groupUsageRequestRowsByProvider(usageRequestTestRows)
        setUsageRequestGraphBaseRows(usageRequestTestRows)
        setUsageRequestGraphRowsByProvider(fallbackRowsByProvider)
        usageRequestGraphRowsCache = {
          queryKey: requestGraphQueryKey,
          baseRows: usageRequestTestRows,
          rowsByProvider: fallbackRowsByProvider,
        }
      } else {
        setUsageRequestGraphBaseRows([])
        setUsageRequestGraphRowsByProvider({})
      }
      usageRequestGraphLastRefreshAtRef.current = Date.now()
    } finally {
      usageRequestGraphRefreshInFlightRef.current = false
      if (usageRequestGraphRefreshPendingRef.current) {
        usageRequestGraphRefreshPendingRef.current = false
        void refreshUsageRequestGraphRows()
      }
    }
  }, [
    requestGraphQueryKey,
    usageRequestAnalyticsProviderHints,
    usageRequestDailyProviderHints,
    usageRequestGraphBaseRows.length,
    usageRequestTestFallbackEnabled,
    usageRequestTestRows,
  ])
  useEffect(() => {
    if (!justEnteredRequestsTab) return
    void refreshUsageRequestGraphRows()
  }, [justEnteredRequestsTab, refreshUsageRequestGraphRows])
  const refreshUsageRequestDailyTotals = useCallback(async () => {
    const requestSeq = usageRequestDailyTotalsFetchSeqRef.current + 1
    usageRequestDailyTotalsFetchSeqRef.current = requestSeq
    setUsageRequestDailyTotalsLoading(true)
    try {
      const res = await invoke<UsageRequestDailyTotalsResponse>('get_usage_request_daily_totals', {
        days: 45,
      })
      if (usageRequestDailyTotalsFetchSeqRef.current !== requestSeq) return
      const nextDays = Array.isArray(res.days) ? res.days : []
      const nextProviders = Array.isArray(res.providers) ? res.providers : []
      setUsageRequestDailyTotalsDays(nextDays)
      setUsageRequestDailyTotalsProviders(nextProviders)
      usageRequestDailyTotalsCache = { days: nextDays, providers: nextProviders }
    } catch {
      if (usageRequestDailyTotalsFetchSeqRef.current !== requestSeq) return
      if (usageRequestTestFallbackEnabled) {
        const fallbackSource =
          usageRequestTestRows.length > 0 ? usageRequestTestRows : usageRequestRows
        if (fallbackSource.length > 0) {
          const fallback = buildDailyTotalsCacheFromRows(fallbackSource, 45)
          setUsageRequestDailyTotalsDays(fallback.days)
          setUsageRequestDailyTotalsProviders(fallback.providers)
          usageRequestDailyTotalsCache = fallback
          return
        }
      }
      if (usageRequestDailyTotalsCache) {
        setUsageRequestDailyTotalsDays(usageRequestDailyTotalsCache.days)
        setUsageRequestDailyTotalsProviders(usageRequestDailyTotalsCache.providers)
      }
    } finally {
      if (usageRequestDailyTotalsFetchSeqRef.current === requestSeq) {
        setUsageRequestDailyTotalsLoading(false)
      }
    }
  }, [usageRequestRows, usageRequestTestFallbackEnabled, usageRequestTestRows])
  const initialRefreshLimit = 1000

  useEffect(() => {
    if (!isRequestsTab && !isAnalyticsTab) return
    if (usageRequestDailyTotalsDays.length === 0 && usageRequestDailyTotalsCache) {
      setUsageRequestDailyTotalsDays(usageRequestDailyTotalsCache.days)
      setUsageRequestDailyTotalsProviders(usageRequestDailyTotalsCache.providers)
    }
    void refreshUsageRequestDailyTotals()
  }, [isAnalyticsTab, isRequestsTab, refreshUsageRequestDailyTotals, usageRequestDailyTotalsDays.length])

  useEffect(() => {
    if (!isRequestsTab) return
    void refreshUsageRequestSummary()
  }, [isRequestsTab, refreshUsageRequestSummary, requestQueryKey, requestDefaultDay])

  useEffect(() => {
    if (!isAnalyticsTab) return
    void prefetchUsageRequestsPageCache(initialRefreshLimit)
  }, [initialRefreshLimit, isAnalyticsTab, prefetchUsageRequestsPageCache])

  useEffect(() => {
    if (!isAnalyticsTab && !isRequestsTab) return
    if (usageRequestRows.length > 0) return
    const cached =
      usageRequestsPageCache != null && usageRequestsPageCache.queryKey === requestQueryKey
        ? usageRequestsPageCache
        : null
    const canonicalCached =
      usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_CANONICAL_QUERY_KEY
        ? usageRequestsPageCache
        : null
    const source = resolveRequestPageCached({
      isRequestsTab,
      hasStrictRequestQuery,
      cached,
      canonicalCached,
      lastNonEmpty: usageRequestsLastNonEmptyPageCache,
    })
    if (!source || source.rows.length === 0) return
    usageRequestLoadedQueryKeyRef.current = source.queryKey
    usageRequestResolvedQueryKeyRef.current = source.queryKey
    setUsageRequestRows(source.rows)
    setUsageRequestHasMore(source.hasMore)
    setUsageRequestUsingTestFallback(source.usingTestFallback)
  }, [
    hasStrictRequestQuery,
    isAnalyticsTab,
    isRequestsTab,
    requestQueryKey,
    usageRequestRows.length,
    usageRequestsCachePrimedTick,
  ])

  useEffect(() => {
    if (!isRequestsTab && !isAnalyticsTab) return
    usageRequestWasNearBottomRef.current = false
    usageRequestLastActivityRef.current = usageActivityUnixMs ?? null
    const cached =
      usageRequestsPageCache != null && usageRequestsPageCache.queryKey === requestQueryKey
        ? usageRequestsPageCache
        : null
    const canonicalCached =
      usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_CANONICAL_QUERY_KEY
        ? usageRequestsPageCache
        : null
    const requestPageCached = resolveRequestPageCached({
      isRequestsTab,
      hasStrictRequestQuery,
      cached,
      canonicalCached,
      lastNonEmpty: usageRequestsLastNonEmptyPageCache,
    })
    const cachedGraph =
      usageRequestGraphRowsCache != null && usageRequestGraphRowsCache.queryKey === requestGraphQueryKey
        ? usageRequestGraphRowsCache
        : null
    if (usageRequestGraphBaseRows.length === 0 && cachedGraph != null) {
      setUsageRequestGraphBaseRows(cachedGraph.baseRows)
      setUsageRequestGraphRowsByProvider(cachedGraph.rowsByProvider)
    } else if (usageRequestGraphBaseRows.length === 0 && canonicalCached?.rows?.length) {
      // Keep chart independent from table filters/date window by bootstrapping from canonical rows.
      const bootstrapRowsByProvider = groupUsageRequestRowsByProvider(canonicalCached.rows)
      setUsageRequestGraphBaseRows(canonicalCached.rows)
      setUsageRequestGraphRowsByProvider(bootstrapRowsByProvider)
    }
    const isOnlyUnknownFallbackCache =
      requestPageCached?.usingTestFallback === true &&
      requestPageCached.rows.length > 0 &&
      requestPageCached.rows.every((row) => isUnknownUsageProvider(row.provider))
    const hasUsableRequestPageCache =
      requestPageCached != null && requestPageCached.rows.length > 0 && !isOnlyUnknownFallbackCache
    if (isRequestsTab && hasUsableRequestPageCache) {
      // Prefer showing cached rows immediately when entering Requests, even if previous state belonged to a different query.
      if (usageRequestLoadedQueryKeyRef.current !== requestQueryKey || usageRequestRows.length === 0) {
        usageRequestLoadedQueryKeyRef.current = requestQueryKey
        usageRequestResolvedQueryKeyRef.current = requestQueryKey
        setUsageRequestRows(requestPageCached.rows)
        setUsageRequestHasMore(requestPageCached.hasMore)
        setUsageRequestUsingTestFallback(requestPageCached.usingTestFallback)
      }
    } else if (isRequestsTab && isOnlyUnknownFallbackCache) {
      usageRequestsPageCache = null
    }
    const cachedGraphProviderCount = cachedGraph != null ? Object.keys(cachedGraph.rowsByProvider).length : 0
    const graphBaseCandidate =
      cachedGraph?.baseRows?.length
        ? cachedGraph.baseRows
        : canonicalCached?.rows?.length
          ? canonicalCached.rows
          : EMPTY_USAGE_REQUEST_ROWS
    const expectedGraphProviders = pickUsageRequestDisplayProviders({
      graphProviders: [
        ...listTopUsageProvidersFromRows(graphBaseCandidate),
        ...Object.keys(cachedGraph?.rowsByProvider ?? {}),
      ],
      dailyProviders: usageRequestDailyProviderHints,
      analyticsProviders: usageRequestAnalyticsProviderHints,
      limit: Math.min(3, USAGE_REQUEST_GRAPH_COLORS.length),
    })
    const visibleGraphProviderCount = Math.max(usageRequestGraphProviderCount, cachedGraphProviderCount)
    const graphProvidersIncomplete =
      expectedGraphProviders.length > 0 && visibleGraphProviderCount < expectedGraphProviders.length
    const graphSnapshotReady =
      (usageRequestGraphBaseRows.length > 0 && usageRequestGraphProviderCount > 0) || cachedGraphProviderCount > 0
    if (isRequestsTab) {
      if (hasUsableRequestPageCache) {
        const forceGraphRefreshOnEntry = justEnteredRequestsTab
        if (
          forceGraphRefreshOnEntry ||
          graphProvidersIncomplete ||
          !graphSnapshotReady ||
          Date.now() - usageRequestGraphLastRefreshAtRef.current > USAGE_REQUEST_GRAPH_BACKGROUND_REFRESH_MS
        ) {
          void refreshUsageRequestGraphRows()
        }
        void mergeLatestUsageRequests(USAGE_REQUEST_PAGE_SIZE)
        return
      }

      const shouldRefresh =
        usageRequestLoadedQueryKeyRef.current !== requestQueryKey ||
        (usageRequestRows.length === 0 && usageRequestResolvedQueryKeyRef.current !== requestQueryKey)
      if (shouldRefresh) {
        usageRequestLoadedQueryKeyRef.current = requestQueryKey
        void refreshUsageRequests(initialRefreshLimit)
        void refreshUsageRequestGraphRows()
        return
      }
      if (
        graphProvidersIncomplete ||
        !graphSnapshotReady ||
        Date.now() - usageRequestGraphLastRefreshAtRef.current > USAGE_REQUEST_GRAPH_BACKGROUND_REFRESH_MS
      ) {
        void refreshUsageRequestGraphRows()
      }
      void mergeLatestUsageRequests(USAGE_REQUEST_PAGE_SIZE)
      return
    }
  }, [
    initialRefreshLimit,
    hasStrictRequestQuery,
    isAnalyticsTab,
    isRequestsTab,
    justEnteredRequestsTab,
    mergeLatestUsageRequests,
    requestQueryKey,
    requestGraphQueryKey,
    usageRequestRows,
    usageRequestGraphBaseRows.length,
    usageRequestGraphProviderCount,
    usageRequestDailyProviderHints,
    usageRequestAnalyticsProviderHints,
    refreshUsageRequestGraphRows,
    refreshUsageRequests,
    usageRequestRows.length,
    usageRequestsCachePrimedTick,
  ])
  useEffect(() => {
    if (!isRequestsTab) return
    if (!usageRequestRows.length) return
    usageRequestsPageCache = {
      queryKey: requestQueryKey,
      rows: usageRequestRows,
      hasMore: usageRequestHasMore,
      usingTestFallback: usageRequestUsingTestFallback,
    }
    usageRequestsLastNonEmptyPageCache = {
      queryKey: requestQueryKey,
      rows: usageRequestRows,
      hasMore: usageRequestHasMore,
      usingTestFallback: usageRequestUsingTestFallback,
    }
  }, [
    isRequestsTab,
    requestQueryKey,
    usageRequestHasMore,
    usageRequestRows,
    usageRequestUsingTestFallback,
  ])
  useEffect(() => {
    if (!isRequestsTab) return
    if (!usageRequestGraphBaseRows.length && Object.keys(usageRequestGraphRowsByProvider).length === 0) return
    usageRequestGraphRowsCache = {
      queryKey: requestGraphQueryKey,
      baseRows: usageRequestGraphBaseRows,
      rowsByProvider: usageRequestGraphRowsByProvider,
    }
  }, [
    isRequestsTab,
    requestGraphQueryKey,
    usageRequestGraphBaseRows,
    usageRequestGraphRowsByProvider,
  ])

  useEffect(() => {
    if (!isRequestsTab && !isAnalyticsTab) return
    if (usageActivityUnixMs == null) return
    const last = usageRequestLastActivityRef.current
    if (last == null) {
      usageRequestLastActivityRef.current = usageActivityUnixMs
      return
    }
    if (usageActivityUnixMs <= last) return
    usageRequestLastActivityRef.current = usageActivityUnixMs
    void refreshUsageRequestDailyTotals()
    if (isRequestsTab) {
      void refreshUsageRequestSummary()
    }
    if (!isRequestsTab) {
      void prefetchUsageRequestsPageCache(USAGE_REQUEST_PAGE_SIZE)
      return
    }
    void refreshUsageRequestGraphRows()
    void mergeLatestUsageRequests(USAGE_REQUEST_PAGE_SIZE)
  }, [
    isAnalyticsTab,
    isRequestsTab,
    usageActivityUnixMs,
    mergeLatestUsageRequests,
    prefetchUsageRequestsPageCache,
    refreshUsageRequestDailyTotals,
    refreshUsageRequestSummary,
    refreshUsageRequestGraphRows,
  ])

  const loadMoreUsageRequests = useCallback(async () => {
    if (usageRequestLoading || !usageRequestHasMore || usageRequestRefreshInFlightRef.current) return
    if (usageRequestUsingTestFallback) {
      const merged = usageRequestTestRows.slice(0, usageRequestRows.length + USAGE_REQUEST_PAGE_SIZE)
      setUsageRequestRows(merged)
      setUsageRequestHasMore(merged.length < usageRequestTestRows.length)
      if (merged.length > 0) {
        usageRequestsLastNonEmptyPageCache = {
          queryKey: requestQueryKey,
          rows: merged,
          hasMore: merged.length < usageRequestTestRows.length,
          usingTestFallback: true,
        }
      }
      return
    }
    usageRequestRefreshInFlightRef.current = true
    const requestSeq = usageRequestFetchSeqRef.current + 1
    usageRequestFetchSeqRef.current = requestSeq
    setUsageRequestLoading(true)
    setUsageRequestError('')
    try {
      const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
        ...buildUsageRequestEntriesArgs({
          hours: requestFetchHours,
          fromUnixMs: requestFetchFromUnixMs,
          toUnixMs: requestFetchToUnixMs,
          providers: requestFetchProviders,
          models: requestFetchModels,
          origins: requestFetchOrigins,
          sessions: requestFetchSessions,
          limit: USAGE_REQUEST_PAGE_SIZE,
          offset: usageRequestRows.length,
        }),
      })
      if (usageRequestFetchSeqRef.current !== requestSeq) return
      const incoming = res.rows ?? []
      setUsageRequestRows((prev) => [...prev, ...incoming])
      setUsageRequestHasMore(Boolean(res.has_more))
      if (incoming.length > 0) {
        usageRequestsLastNonEmptyPageCache = {
          queryKey: requestQueryKey,
          rows: [...usageRequestRows, ...incoming],
          hasMore: Boolean(res.has_more),
          usingTestFallback: false,
        }
      }
    } catch (e) {
      if (usageRequestFetchSeqRef.current !== requestSeq) return
      setUsageRequestError(String(e))
    } finally {
      usageRequestRefreshInFlightRef.current = false
      setUsageRequestLoading(false)
      if (usageRequestRefreshPendingRef.current) {
        const nextLimit = usageRequestRefreshPendingLimitRef.current
        usageRequestRefreshPendingRef.current = false
        void refreshUsageRequests(nextLimit)
      }
    }
  }, [
    requestFetchHours,
    requestFetchFromUnixMs,
    requestFetchModels,
    requestFetchOrigins,
    requestFetchProviders,
    requestFetchSessions,
    requestFetchToUnixMs,
    requestQueryKey,
    refreshUsageRequests,
    usageRequestHasMore,
    usageRequestLoading,
    usageRequestRows.length,
    usageRequestTestRows,
    usageRequestUsingTestFallback,
  ])

  useEffect(() => {
    if (!isRequestsTab) return
    if (hasExplicitTimeFilter) return
    if (!hasExplicitRequestFilters) return
    if (usageRequestLoading || !usageRequestHasMore || !usageRequestRows.length) return
    const loadedDays = new Set<number>()
    for (const row of usageRequestRows) loadedDays.add(startOfDayUnixMs(row.unix_ms))
    if (loadedDays.size >= 45) return
    void loadMoreUsageRequests()
  }, [
    isRequestsTab,
    hasExplicitTimeFilter,
    loadMoreUsageRequests,
    usageRequestMergeTick,
    usageRequestHasMore,
    usageRequestLoading,
    usageRequestRows,
  ])

  const graphBaseRowsForVerifiedSessions = useMemo(() => {
    if (!shouldPrepareRequestsData) return EMPTY_USAGE_REQUEST_ROWS
    if (verifiedSessionIdSet.size === 0) return EMPTY_USAGE_REQUEST_ROWS
    return graphBaseRowsForRequestRender.filter((row) => verifiedSessionIdSet.has(String(row.session_id ?? '').trim()))
  }, [graphBaseRowsForRequestRender, shouldPrepareRequestsData, verifiedSessionIdSet])

  const graphRowsForVerifiedSessions = useMemo(() => {
    if (!shouldPrepareRequestsData) return EMPTY_USAGE_REQUEST_ROWS
    if (!graphBaseRowsForVerifiedSessions.length) return EMPTY_USAGE_REQUEST_ROWS
    return graphBaseRowsForVerifiedSessions
  }, [graphBaseRowsForVerifiedSessions, shouldPrepareRequestsData])

  const graphRowsBySessionForRequestRender = useMemo(() => {
    if (!shouldPrepareRequestsData) return EMPTY_USAGE_REQUEST_ROWS_BY_PROVIDER
    if (!graphRowsForVerifiedSessions.length) return EMPTY_USAGE_REQUEST_ROWS_BY_PROVIDER
    const grouped = new Map<string, UsageRequestEntry[]>()
    graphRowsForVerifiedSessions.forEach((row) => {
      const sessionId = String(row.session_id ?? '').trim()
      if (!sessionId) return
      const list = grouped.get(sessionId) ?? []
      list.push(row)
      grouped.set(sessionId, list)
    })
    const out: Record<string, UsageRequestEntry[]> = {}
    grouped.forEach((rows, sessionId) => {
      out[sessionId] = [...rows].sort((a, b) => b.unix_ms - a.unix_ms).slice(0, USAGE_REQUEST_GRAPH_SOURCE_LIMIT)
    })
    return out
  }, [graphRowsForVerifiedSessions, shouldPrepareRequestsData])

  const usageRequestSessionOptions = useMemo(() => {
    if (!shouldPrepareRequestsData) return EMPTY_STRING_LIST
    return Object.entries(graphRowsBySessionForRequestRender)
      .map(([sessionId, rows]) => ({ sessionId, count: rows.length }))
      .sort((a, b) => b.count - a.count || a.sessionId.localeCompare(b.sessionId, undefined, { numeric: true, sensitivity: 'base' }))
      .map((item) => item.sessionId)
  }, [graphRowsBySessionForRequestRender, shouldPrepareRequestsData])

  const usageRequestDisplaySessions = useMemo(() => {
    if (!usageRequestSessionOptions.length) return EMPTY_STRING_LIST
    return usageRequestSessionOptions.slice(0, USAGE_REQUEST_GRAPH_MAX_SESSIONS)
  }, [usageRequestSessionOptions])
  const activeRequestGraphSessions = usageRequestDisplaySessions

  const requestGraphColorByProvider = useMemo(() => {
    const providers = Array.from(
      new Set(graphRowsForVerifiedSessions.map((row) => resolveRequestProviderName(row.provider))),
    ).sort(compareUsageProvidersForDisplay)
    const map = new Map<string, string>()
    providers.forEach((provider, index) => {
      map.set(provider, USAGE_REQUEST_GRAPH_COLORS[index % USAGE_REQUEST_GRAPH_COLORS.length])
    })
    return map
  }, [graphRowsForVerifiedSessions, resolveRequestProviderName])

  const requestGraphProviderBySession = useMemo(() => {
    const out = new Map<string, string>()
    activeRequestGraphSessions.forEach((sessionId) => {
      const rows = graphRowsBySessionForRequestRender[sessionId] ?? EMPTY_USAGE_REQUEST_ROWS
      const counts = new Map<string, number>()
      rows.forEach((row) => {
        const provider = resolveRequestProviderName(row.provider)
        counts.set(provider, (counts.get(provider) ?? 0) + 1)
      })
      const dominantProvider =
        [...counts.entries()].sort((a, b) => b[1] - a[1] || compareUsageProvidersForDisplay(a[0], b[0]))[0]?.[0] ?? '-'
      out.set(sessionId, dominantProvider)
    })
    return out
  }, [activeRequestGraphSessions, graphRowsBySessionForRequestRender, resolveRequestProviderName])

  const requestGraphOriginBySession = useMemo(() => {
    const out = new Map<string, 'windows' | 'wsl2'>()
    activeRequestGraphSessions.forEach((sessionId) => {
      const rows = graphRowsBySessionForRequestRender[sessionId] ?? EMPTY_USAGE_REQUEST_ROWS
      let windowsCount = 0
      let wslCount = 0
      rows.forEach((row) => {
        const origin = normalizeUsageOrigin(row.origin)
        if (origin === 'wsl2') {
          wslCount += 1
          return
        }
        windowsCount += 1
      })
      out.set(sessionId, wslCount > windowsCount ? 'wsl2' : 'windows')
    })
    return out
  }, [activeRequestGraphSessions, graphRowsBySessionForRequestRender])

  const usageRequestGraphPointCount = USAGE_REQUEST_GRAPH_SOURCE_LIMIT

  const usageRequestRowsBySession = useMemo(() => {
    if (!shouldPrepareRequestsData) return new Map<string, UsageRequestEntry[]>()
    const out = new Map<string, UsageRequestEntry[]>()
    for (const sessionId of activeRequestGraphSessions) {
      const rows = graphRowsBySessionForRequestRender[sessionId] ?? []
      out.set(sessionId, rows.slice(0, USAGE_REQUEST_GRAPH_SOURCE_LIMIT))
    }
    return out
  }, [activeRequestGraphSessions, graphRowsBySessionForRequestRender, shouldPrepareRequestsData])

  const usageRequestLineSeries = useMemo<UsageRequestLineSeries[]>(() => {
    if (!shouldPrepareRequestsData) return []
    const sessions = [...activeRequestGraphSessions]
    if (!sessions.length) return []
    const pointCount = usageRequestGraphPointCount
    const providerSeries = sessions.map((sessionId, sessionIndex) => {
        const values = new Array<number>(pointCount).fill(0)
        const present = new Array<boolean>(pointCount).fill(false)
        const pointIds = new Array<string>(pointCount).fill('')
        const rows = usageRequestRowsBySession.get(sessionId) ?? []
      const count = Math.min(pointCount, rows.length)
      // Plot request points as left-old/right-new:
      // point 1 is the oldest entry within the latest-N window,
      // and the rightmost plotted point is the newest entry.
      for (let idx = 0; idx < count; idx += 1) {
        const row = rows[count - 1 - idx]
        values[idx] = row.total_tokens
        present[idx] = true
        pointIds[idx] = usageRequestRowIdentity(row)
      }
      const dominantProvider = requestGraphProviderBySession.get(sessionId) ?? '-'
      const dominantOrigin = requestGraphOriginBySession.get(sessionId) ?? 'windows'
      return {
        kind: 'session' as const,
        id: sessionId,
        provider: shortSessionIdForLegend(sessionId),
        providerName: dominantProvider,
        origin: dominantOrigin,
        color:
          requestGraphColorByProvider.get(dominantProvider) ??
          USAGE_REQUEST_GRAPH_COLORS[sessionIndex % USAGE_REQUEST_GRAPH_COLORS.length],
        values,
        present,
        pointIds,
      }
    })
    return providerSeries
  }, [
    activeRequestGraphSessions,
    shouldPrepareRequestsData,
    usageRequestGraphPointCount,
    usageRequestRowsBySession,
    requestGraphColorByProvider,
    requestGraphOriginBySession,
    requestGraphProviderBySession,
  ])
  const previousUsageRequestLineSeriesRef = useRef<UsageRequestLineSeries[]>([])
  const requestLineLiveAnimMetaRef = useRef<Map<string, UsageRequestLiveLineAnimMeta>>(new Map())
  const [requestLineLiveAnimElapsedMs, setRequestLineLiveAnimElapsedMs] = useState(0)
  const [requestLineLiveAnimNonce, setRequestLineLiveAnimNonce] = useState(0)
  const [requestLineAnimElapsedMs, setRequestLineAnimElapsedMs] = useState(0)
  useEffect(() => {
    if (!isRequestsTab || !usageRequestUsingTestFallback || usageRequestLineSeries.length === 0) {
      setRequestLineAnimElapsedMs(0)
      return
    }
    const startedAt = performance.now()
    let rafId = 0
    const run = (now: number) => {
      setRequestLineAnimElapsedMs(now - startedAt)
      rafId = window.requestAnimationFrame(run)
    }
    rafId = window.requestAnimationFrame(run)
    return () => window.cancelAnimationFrame(rafId)
  }, [isRequestsTab, usageRequestLineSeries.length, usageRequestUsingTestFallback])
  useLayoutEffect(() => {
    const nextSeries = cloneUsageRequestLineSeries(usageRequestLineSeries)
    const previousSeries = previousUsageRequestLineSeriesRef.current
    previousUsageRequestLineSeriesRef.current = nextSeries
    if (!isRequestsTab || usageRequestUsingTestFallback) {
      requestLineLiveAnimMetaRef.current = new Map()
      setRequestLineLiveAnimElapsedMs(0)
      return
    }
    if (nextSeries.length === 0 || previousSeries.length === 0) return
    if (areUsageRequestLineSeriesIdentical(previousSeries, nextSeries)) return
    const previousById = new Map(previousSeries.map((series) => [series.id, series]))
    const liveMeta = new Map<string, UsageRequestLiveLineAnimMeta>()
    nextSeries.forEach((series) => {
      const previous = previousById.get(series.id)
      if (!previous) return
      const prevCount = countUsageRequestLinePoints(previous.present)
      const nextCount = countUsageRequestLinePoints(series.present)
      if (prevCount <= 0 || nextCount <= 0) return
      const shiftSteps = detectUsageRequestLineShiftSteps(
        previous.pointIds,
        prevCount,
        series.pointIds,
        nextCount,
      )
      const prevLastIndex = Math.max(0, prevCount - 1)
      const prevLastValue =
        previous.values[prevLastIndex] ?? series.values[Math.max(0, nextCount - 1)] ?? 0
      liveMeta.set(series.id, {
        prevValues: [...previous.values],
        prevPresent: [...previous.present],
        shiftSteps,
        prevLastValue,
      })
    })
    if (liveMeta.size === 0) return
    requestLineLiveAnimMetaRef.current = liveMeta
    setRequestLineLiveAnimElapsedMs(0)
    setRequestLineLiveAnimNonce((value) => value + 1)
  }, [isRequestsTab, usageRequestLineSeries, usageRequestUsingTestFallback])
  useEffect(() => {
    if (!isRequestsTab || usageRequestUsingTestFallback) return
    if (requestLineLiveAnimMetaRef.current.size === 0) return
    const startedAt = performance.now()
    let rafId = 0
    const run = (now: number) => {
      const elapsed = now - startedAt
      setRequestLineLiveAnimElapsedMs(elapsed)
      if (elapsed >= USAGE_REQUEST_LIVE_LINE_TRANSITION_MS) return
      rafId = window.requestAnimationFrame(run)
    }
    rafId = window.requestAnimationFrame(run)
    return () => window.cancelAnimationFrame(rafId)
  }, [isRequestsTab, requestLineLiveAnimNonce, usageRequestUsingTestFallback])
  const renderedUsageRequestLineSeries = useMemo<UsageRequestRenderedLineSeries[]>(() => {
    if (!isRequestsTab) return usageRequestLineSeries
    if (!usageRequestUsingTestFallback) {
      const liveMeta = requestLineLiveAnimMetaRef.current
      const livePhase = Math.max(
        0,
        Math.min(1, requestLineLiveAnimElapsedMs / USAGE_REQUEST_LIVE_LINE_TRANSITION_MS),
      )
      if (liveMeta.size === 0 || livePhase >= 1) return usageRequestLineSeries
      return usageRequestLineSeries.map((series) => {
        const meta = liveMeta.get(series.id)
        if (!meta) return series
        const prevCount = countUsageRequestLinePoints(meta.prevPresent)
        const currentCount = countUsageRequestLinePoints(series.present)
        const slidingEligible =
          meta.shiftSteps === 1 &&
          prevCount >= usageRequestGraphPointCount &&
          currentCount >= usageRequestGraphPointCount
        if (slidingEligible) {
          const values = new Array<number>(usageRequestGraphPointCount).fill(0)
          const present = new Array<boolean>(usageRequestGraphPointCount).fill(false)
          let pointIndex = 0
          for (let idx = 0; idx < meta.prevPresent.length && pointIndex < usageRequestGraphPointCount; idx += 1) {
            if (!meta.prevPresent[idx]) continue
            values[pointIndex] = meta.prevValues[idx] ?? 0
            present[pointIndex] = true
            pointIndex += 1
          }
          const previewNextValue = series.values[Math.max(0, currentCount - 1)] ?? null
          return {
            ...series,
            values,
            present,
            liveSlidingEligible: true,
            livePreviewNextValue: previewNextValue,
          }
        }

        const growingEligible =
          currentCount === prevCount + 1 &&
          prevCount > 1 &&
          prevCount < usageRequestGraphPointCount
        if (growingEligible) {
          const values = new Array<number>(usageRequestGraphPointCount).fill(0)
          const present = new Array<boolean>(usageRequestGraphPointCount).fill(false)
          let pointIndex = 0
          for (let idx = 0; idx < meta.prevPresent.length && pointIndex < usageRequestGraphPointCount; idx += 1) {
            if (!meta.prevPresent[idx]) continue
            values[pointIndex] = meta.prevValues[idx] ?? 0
            present[pointIndex] = true
            pointIndex += 1
          }
          const previewNextValue =
            series.values[Math.min(series.values.length - 1, Math.max(0, prevCount))] ??
            series.values[Math.max(0, currentCount - 1)] ??
            null
          return {
            ...series,
            values,
            present,
            liveSlidingEligible: false,
            livePreviewNextValue: previewNextValue,
          }
        }

        const values = [...series.values]
        const present = [...series.present]
        for (let idx = 0; idx < usageRequestGraphPointCount; idx += 1) {
          const wasPresent = Boolean(meta.prevPresent[idx])
          const isPresent = Boolean(series.present[idx])
          if (!wasPresent && !isPresent) {
            values[idx] = 0
            present[idx] = false
            continue
          }
          const prevValue = wasPresent ? (meta.prevValues[idx] ?? 0) : meta.prevLastValue
          const nextValue = isPresent ? (series.values[idx] ?? prevValue) : prevValue
          values[idx] = Math.round(prevValue + (nextValue - prevValue) * livePhase)
          present[idx] = isPresent || (wasPresent && livePhase < 1)
        }
        return {
          ...series,
          values,
          present,
          liveSlidingEligible: false,
          livePreviewNextValue: null,
        }
      })
    }
    return usageRequestLineSeries.map((series) => {
      const baseValues: number[] = []
      for (let idx = 0; idx < series.present.length; idx += 1) {
        if (!series.present[idx]) continue
        baseValues.push(series.values[idx] ?? 0)
      }
      const baseCount = baseValues.length
      const stepIndex = Math.floor(requestLineAnimElapsedMs / USAGE_REQUEST_FALLBACK_LINE_STEP_MS)
      if (baseCount <= 0) {
        return {
          ...series,
          fallbackSlidingEligible: false,
          fallbackPreviewNextValue: null as number | null,
        }
      }
      const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
      const baseSeed = stableSeedFromText(String((series as { id?: string }).id ?? series.provider))
      const buildNextValue = (prev: number, prevPrev: number, stepOrdinal: number) => {
        const wave = Math.sin((stepOrdinal + (baseSeed % 41)) / 9) * 620
        const ripple = Math.cos((stepOrdinal + (baseSeed % 67)) / 7) * 390
        const momentum = (prev - prevPrev) * 0.36
        return clamp(Math.round(prev + momentum + wave + ripple), 55_000, 230_000)
      }
      const sequence = [...baseValues]
      let previousValue = sequence[Math.max(0, sequence.length - 2)] ?? sequence[0] ?? 100_000
      let latestValue = sequence[Math.max(0, sequence.length - 1)] ?? previousValue
      const appendSynthetic = (stepOrdinal: number) => {
        const next = buildNextValue(latestValue, previousValue, stepOrdinal)
        sequence.push(next)
        previousValue = latestValue
        latestValue = next
      }

      let committedStepCount = 0
      if (baseCount < usageRequestGraphPointCount) {
        const growthSteps = Math.min(stepIndex, usageRequestGraphPointCount - baseCount)
        for (let idx = 0; idx < growthSteps; idx += 1) {
          appendSynthetic(idx)
        }
        committedStepCount += growthSteps
        const slidingSteps = Math.max(0, stepIndex - (usageRequestGraphPointCount - baseCount))
        for (let idx = 0; idx < slidingSteps; idx += 1) {
          appendSynthetic(growthSteps + idx)
        }
        committedStepCount += slidingSteps
      } else {
        for (let idx = 0; idx < stepIndex; idx += 1) {
          appendSynthetic(idx)
        }
        committedStepCount = stepIndex
      }

      const windowCount = Math.min(usageRequestGraphPointCount, sequence.length)
      const windowStart = Math.max(0, sequence.length - windowCount)
      const windowValues = sequence.slice(windowStart)
      const values = new Array<number>(usageRequestGraphPointCount).fill(0)
      const present = new Array<boolean>(usageRequestGraphPointCount).fill(false)
      for (let idx = 0; idx < windowValues.length; idx += 1) {
        values[idx] = windowValues[idx]
        present[idx] = true
      }
      const slidingEligible = windowCount >= usageRequestGraphPointCount
      const previewNextValue = buildNextValue(latestValue, previousValue, committedStepCount)
      return {
        ...series,
        values,
        present,
        fallbackSlidingEligible: slidingEligible,
        fallbackPreviewNextValue: previewNextValue,
      }
    })
  }, [
    isRequestsTab,
    requestLineAnimElapsedMs,
    requestLineLiveAnimElapsedMs,
    requestLineLiveAnimNonce,
    usageRequestGraphPointCount,
    usageRequestLineSeries,
    usageRequestUsingTestFallback,
  ])
  const requestLineAnimPhase = useMemo(() => {
    if (!isRequestsTab || usageRequestLineSeries.length === 0) return 0
    if (usageRequestUsingTestFallback) {
      return (requestLineAnimElapsedMs % USAGE_REQUEST_FALLBACK_LINE_STEP_MS) / USAGE_REQUEST_FALLBACK_LINE_STEP_MS
    }
    if (requestLineLiveAnimMetaRef.current.size === 0) return 0
    const livePhase = Math.max(
      0,
      Math.min(1, requestLineLiveAnimElapsedMs / USAGE_REQUEST_LIVE_LINE_TRANSITION_MS),
    )
    return livePhase >= 1 ? 0 : livePhase
  }, [
    isRequestsTab,
    requestLineAnimElapsedMs,
    requestLineLiveAnimElapsedMs,
    usageRequestLineSeries.length,
    usageRequestUsingTestFallback,
  ])
  const requestLineSliding = useMemo(() => {
    if (!isRequestsTab || renderedUsageRequestLineSeries.length === 0) return false
    return renderedUsageRequestLineSeries.some((series) =>
      Boolean(
        (series as { fallbackSlidingEligible?: boolean; liveSlidingEligible?: boolean }).fallbackSlidingEligible ||
          (series as { fallbackSlidingEligible?: boolean; liveSlidingEligible?: boolean }).liveSlidingEligible,
      ),
    )
  }, [isRequestsTab, renderedUsageRequestLineSeries])

  const usageRequestLineMaxValue = useMemo(() => {
    let maxValue = 0
    for (const series of renderedUsageRequestLineSeries) {
      for (const value of series.values) {
        if (value > maxValue) maxValue = value
      }
    }
    if (maxValue <= 0) return 1
    return Math.max(1, Math.ceil(maxValue * USAGE_REQUEST_LINE_HEADROOM_RATIO))
  }, [renderedUsageRequestLineSeries])
  const usageRequestLineSeriesByOrigin = useMemo(
    () => ({
      wsl2: renderedUsageRequestLineSeries.filter((series) => series.origin === 'wsl2'),
      windows: renderedUsageRequestLineSeries.filter((series) => series.origin === 'windows'),
    }),
    [renderedUsageRequestLineSeries],
  )
  const usageRequestLegendSeries = useMemo(
    () => {
      const colorByProvider = new Map<string, string>()
      renderedUsageRequestLineSeries.forEach((series) => {
        const providerName = String((series as { providerName?: string }).providerName ?? '').trim() || '-'
        if (!colorByProvider.has(providerName)) colorByProvider.set(providerName, series.color)
      })
      return [...colorByProvider.entries()]
        .sort((a, b) => compareUsageProvidersForDisplay(a[0], b[0]))
        .map(([provider, color]) => ({ provider, color }))
    },
    [renderedUsageRequestLineSeries],
  )
  const usageRequestDailyWindowRows = useMemo(() => {
    if (!isRequestsTab || !usageRequestDailyTotalsDays.length) return []
    const byDay = new Map<number, Record<string, number>>()
    for (const row of usageRequestDailyTotalsDays) {
      if (!row || typeof row.day_start_unix_ms !== 'number') continue
      const normalizedTotals: Record<string, number> = {}
      for (const [provider, rawValue] of Object.entries(row.provider_totals ?? {})) {
        const value = Number(rawValue)
        if (!Number.isFinite(value) || value <= 0) continue
        const displayProvider = resolveRequestProviderName(provider)
        normalizedTotals[displayProvider] = (normalizedTotals[displayProvider] ?? 0) + value
      }
      byDay.set(row.day_start_unix_ms, normalizedTotals)
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
    return days.map((day) => ({
      day,
      providerTotals: byDay.get(day) ?? {},
    }))
  }, [isRequestsTab, resolveRequestProviderName, usageRequestDailyTotalsDays])

  const dailyTotalsProviders = useMemo(() => {
    if (!usageRequestDailyWindowRows.length) return EMPTY_STRING_LIST
    const totals = new Map<string, number>()
    for (const row of usageRequestDailyWindowRows) {
      for (const [provider, value] of Object.entries(row.providerTotals)) {
        if (value <= 0) continue
        totals.set(provider, (totals.get(provider) ?? 0) + value)
      }
    }
    return [...totals.entries()]
      .sort((a, b) => {
        const providerOrder = compareUsageProvidersForDisplay(a[0], b[0])
        if (providerOrder !== 0) return providerOrder
        if (a[1] !== b[1]) return b[1] - a[1]
        return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })
      })
      .map(([provider]) => provider)
  }, [usageRequestDailyWindowRows])

  const usageRequestDailyBars = useMemo(() => {
    if (!usageRequestDailyWindowRows.length || !dailyTotalsProviders.length) return []
    const labelStride =
      usageRequestDailyWindowRows.length > 36 ? 3 : usageRequestDailyWindowRows.length > 24 ? 2 : 1
    return usageRequestDailyWindowRows.map((row, index) => {
      const total = dailyTotalsProviders.reduce((sum, provider) => sum + (row.providerTotals[provider] ?? 0), 0)
      return {
        day: row.day,
        providerTotals: row.providerTotals,
        total,
        showLabel: (total > 0 && index % labelStride === 0) || index === usageRequestDailyWindowRows.length - 1,
      }
    })
  }, [dailyTotalsProviders, usageRequestDailyWindowRows])
  const defaultTodayOnly = useMemo(() => {
    if (effectiveDetailsTab !== 'requests') return false
    if (hasExplicitTimeFilter) return false
    for (const row of rowsForRequestRender) {
      if (startOfDayUnixMs(row.unix_ms) === requestDefaultDay) return true
    }
    return false
  }, [effectiveDetailsTab, hasExplicitTimeFilter, requestDefaultDay, rowsForRequestRender])

  const timeScopedUsageRequestRows = useMemo(() => {
    if (!isRequestsTab) return EMPTY_USAGE_REQUEST_ROWS
    const timeDay = parseDateInputToDayStart(usageRequestTimeFilter)
    if (timeDay == null && !defaultTodayOnly) return rowsForRequestRender
    return rowsForRequestRender.filter((row) =>
      timeDay != null
        ? startOfDayUnixMs(row.unix_ms) === timeDay
        : startOfDayUnixMs(row.unix_ms) === requestDefaultDay,
    )
  }, [
    defaultTodayOnly,
    isRequestsTab,
    requestDefaultDay,
    rowsForRequestRender,
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
  const usageRequestProviderFilterDisplayOptions = useMemo(
    () =>
      buildUsageProviderFilterDisplayOptions(usageRequestFilterOptions.provider, {
        providerDisplayName: (provider) => resolveRequestProviderName(provider),
        providerGroupName: (provider) => {
          const group = String(config?.providers?.[provider]?.group ?? '').trim()
          return group || null
        },
      }),
    [config?.providers, resolveRequestProviderName, usageRequestFilterOptions.provider],
  )
  useEffect(() => {
    if (!isRequestsTab) return
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
  }, [isRequestsTab, usageRequestFilterOptions])
  const usageRequestCalendarIndex = useMemo(
    () =>
      buildUsageRequestCalendarIndex({
        isRequestsTab,
        rowsForRequestRender,
        usageRequestDailyTotalsDays,
      }),
    [isRequestsTab, rowsForRequestRender, usageRequestDailyTotalsDays],
  )
  const usageRequestDaysWithRecords = usageRequestCalendarIndex.daysWithRecords
  const usageRequestDayOriginFlags = usageRequestCalendarIndex.dayOriginFlags
  const filteredUsageRequestRows = useMemo(() => {
    if (!isRequestsTab) return EMPTY_USAGE_REQUEST_ROWS
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
    return rowsForRequestRender.filter((row) => {
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
    defaultTodayOnly,
    fmtWhen,
    hasExplicitTimeFilter,
    isRequestsTab,
    requestDefaultDay,
    usageRequestMultiFilters,
    rowsForRequestRender,
    usageRequestTimeFilter,
  ])
  const deferredFilteredUsageRequestRows = useDeferredValue(filteredUsageRequestRows)
  const displayedFilteredUsageRequestRows = shouldUseImmediateRequestRows
    ? filteredUsageRequestRows
    : deferredFilteredUsageRequestRows
  useEffect(() => {
    if (displayedFilteredUsageRequestRows.length === 0) return
    usageRequestLastRenderedRowsRef.current = displayedFilteredUsageRequestRows
  }, [displayedFilteredUsageRequestRows])
  const showPreviousRowsDuringQuerySwitch =
    displayedFilteredUsageRequestRows.length === 0 &&
    hasStrictRequestQuery &&
    !hasImpossibleRequestFilters &&
    usageRequestResolvedQueryKeyRef.current !== requestQueryKey &&
    usageRequestLastRenderedRowsRef.current.length > 0
  const tableRowsForDisplay = showPreviousRowsDuringQuerySwitch
    ? usageRequestLastRenderedRowsRef.current
    : displayedFilteredUsageRequestRows
  const totalRequestRowsForDisplay = rowsForRequestRender.length
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
  useEffect(() => {
    if (!isRequestsTab) return
    if (!defaultTodayOnly) return
    if (usageRequestLoading) return
    if (!usageRequestHasMore) return
    if (displayedFilteredUsageRequestRows.length > 0) return
    const now = Date.now()
    if (now - usageRequestWarmupAtRef.current < 1200) return
    usageRequestWarmupAtRef.current = now
    if (usageRequestRows.length === 0) {
      void refreshUsageRequests(initialRefreshLimit)
      return
    }
    if (usageRequestDefaultTodayAutoPageRef.current) return
    usageRequestDefaultTodayAutoPageRef.current = true
    // At most one automatic extra page in default-today mode; avoid repeated 200-row paging loops.
    void loadMoreUsageRequests()
  }, [
    defaultTodayOnly,
    displayedFilteredUsageRequestRows.length,
    initialRefreshLimit,
    isRequestsTab,
    loadMoreUsageRequests,
    refreshUsageRequests,
    usageRequestHasMore,
    usageRequestLoading,
    usageRequestRows.length,
  ])
  const requestChartMeasureRef = useRef<SVGSVGElement | null>(null)
  const [requestChartViewportWidth, setRequestChartViewportWidth] = useState(560)
  const requestChartMeasureOrigin = useMemo<'windows' | 'wsl2'>(() => {
    if (usageRequestLineSeriesByOrigin.windows.length > 0) return 'windows'
    if (usageRequestLineSeriesByOrigin.wsl2.length > 0) return 'wsl2'
    return 'windows'
  }, [usageRequestLineSeriesByOrigin])
  const requestChartWidth = Math.max(360, requestChartViewportWidth)
  const requestChartHeight = 176
  const requestChartMinX = 36
  const requestChartRightPadding = 8
  const requestChartMaxX = Math.max(requestChartMinX + 20, requestChartWidth - requestChartRightPadding)
  const requestChartTopY = 14
  const requestChartBottomY = 150
  const requestChartAxisLabelX = requestChartMinX - 3
  const requestChartXAxisLabelY = requestChartBottomY + 12
  const requestChartXAxisLeftLabelX = requestChartMinX + 1
  const requestChartXAxisRightLabelX = requestChartMaxX - 1
  useLayoutEffect(() => {
    if (!isRequestsTab) return
    const svg = requestChartMeasureRef.current
    if (!svg || typeof ResizeObserver === 'undefined') return
    const updateWidth = () => {
      const width = svg.getBoundingClientRect().width
      if (!Number.isFinite(width) || width <= 0) return
      setRequestChartViewportWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width))
    }
    updateWidth()
    const observer = new ResizeObserver(() => updateWidth())
    observer.observe(svg)
    return () => observer.disconnect()
  }, [isRequestsTab, requestChartMeasureOrigin])
  const requestLinePointSpacing =
    (requestChartMaxX - requestChartMinX) / Math.max(1, usageRequestGraphPointCount - 1)
  const requestLineAnimOffsetX = requestLineAnimPhase * requestLinePointSpacing
  const requestLineClipPathIdRef = useRef(`aoUsageRequestLineClip-${Math.random().toString(36).slice(2, 10)}`)
  const requestLineClipPathId = requestLineClipPathIdRef.current
  const [lineHoverOrigin, setLineHoverOrigin] = useState<'wsl2' | 'windows' | null>(null)
  const [lineHoverIndex, setLineHoverIndex] = useState<number | null>(null)
  const [lineHoverX, setLineHoverX] = useState<number | null>(null)
  const lineHoverData = useMemo(() => {
    if (!isRequestsTab) return null
    if (lineHoverOrigin == null) return null
    if (lineHoverIndex == null) return null
    if (lineHoverIndex < 0 || lineHoverIndex >= usageRequestGraphPointCount) return null
    const hoveredSeries = usageRequestLineSeriesByOrigin[lineHoverOrigin]
    if (!hoveredSeries.length) return null
    const byProvider = new Map<string, { id: string; provider: string; color: string; value: number }>()
    hoveredSeries.forEach((series) => {
      const providerName = String((series as { providerName?: string }).providerName ?? '').trim() || series.provider
      const value = series.values[lineHoverIndex] ?? 0
      const existing = byProvider.get(providerName)
      if (existing) {
        existing.value += value
        return
      }
      byProvider.set(providerName, {
        id: providerName,
        provider: providerName,
        color: series.color,
        value,
      })
    })
    const rows = [...byProvider.values()].sort((a, b) => compareUsageProvidersForDisplay(a.provider, b.provider))
    return {
      point: lineHoverIndex + 1,
      rows,
      total: rows.reduce((sum, row) => sum + row.value, 0),
    }
  }, [
    isRequestsTab,
    lineHoverOrigin,
    lineHoverIndex,
    usageRequestLineSeriesByOrigin,
    usageRequestGraphPointCount,
  ])
  const usageRequestSidRowsWithPositionByOrigin = useMemo(() => {
    const rowHeight = 18
    const edgeInset = 1
    const panelHeight = Math.max(24, requestChartBottomY - requestChartTopY)
    const listHeight = Math.max(24, panelHeight)
    const minTop = edgeInset
    const maxTop = Math.max(edgeInset, listHeight - rowHeight - edgeInset)
    const mapRowsWithPosition = (seriesList: UsageRequestRenderedLineSeries[]) =>
      seriesList
        .filter((series) => series.present.reduce((sum, present) => sum + (present ? 1 : 0), 0) > 1)
        .map((series) => {
          let latestIndex = -1
          for (let idx = series.present.length - 1; idx >= 0; idx -= 1) {
            if (series.present[idx]) {
              latestIndex = idx
              break
            }
          }
          if (latestIndex < 0) return null
          const value = series.values[latestIndex] ?? 0
          const y =
            requestChartBottomY -
            (value / Math.max(1, usageRequestLineMaxValue)) * (requestChartBottomY - requestChartTopY)
          const top = Math.min(
            maxTop,
            Math.max(minTop, y - requestChartTopY - rowHeight / 2),
          )
          return {
            id: String((series as { id?: string }).id ?? series.provider),
            sidLabel: series.provider,
            providerName: String((series as { providerName?: string }).providerName ?? '').trim() || '-',
            color: series.color,
            top,
            latestValue: value,
          }
        })
      .filter((item): item is { id: string; sidLabel: string; providerName: string; color: string; top: number; latestValue: number } => item != null)
      .sort((a, b) => a.top - b.top)
    return {
      wsl2: mapRowsWithPosition(usageRequestLineSeriesByOrigin.wsl2),
      windows: mapRowsWithPosition(usageRequestLineSeriesByOrigin.windows),
    }
  }, [
    requestChartBottomY,
    requestChartTopY,
    usageRequestLineMaxValue,
    usageRequestLineSeriesByOrigin,
  ])
  const selectedTimeFilterDay = selectedRequestTimeFilterDay
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
  const requestTableSummary = useMemo(
    () =>
      resolveRequestTableSummary({
        usageRequestSummary,
        displayedRows: displayedFilteredUsageRequestRows,
        hasMore: usageRequestHasMore,
        preferBackendSummary: !hasExplicitTimeFilter || selectedRequestTimeFilterDay != null,
      }),
    [
      displayedFilteredUsageRequestRows,
      hasExplicitTimeFilter,
      selectedRequestTimeFilterDay,
      usageRequestHasMore,
      usageRequestSummary,
    ],
  )
  const formatRequestSummaryValue = useCallback((value: number | null | undefined) => {
    if (value == null) return '-'
    return value.toLocaleString()
  }, [])
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
            usageProviderFilterDisplayOptions={usageProviderFilterDisplayOptions}
            toggleUsageProviderFilterDisplayOption={toggleUsageProviderFilterDisplayOption}
            usageFilterModels={usageFilterModels}
            setUsageFilterModels={setUsageFilterModels}
            usageModelFilterOptions={usageModelFilterOptions}
            toggleUsageModelFilter={toggleUsageModelFilter}
            usageFilterOrigins={usageFilterOrigins}
            setUsageFilterOrigins={setUsageFilterOrigins}
            usageOriginFilterOptions={usageOriginFilterOptions}
            toggleUsageOriginFilter={toggleUsageOriginFilter}
          />
        </>
      ) : null}
      {effectiveDetailsTab === 'requests' ? (
        <div className="aoUsageDetailsPane aoUsageDetailsPaneRequests">
        <div className={`aoUsageRequestsCard${isRequestsOnlyPage ? ' is-page' : ''}`}>
          <div className="aoSwitchboardSectionHead">
            <div className="aoMiniLabel">Request Details</div>
            <div className="aoHint">
              {hasExplicitRequestFilters
                ? 'Per-request rows (newest first), aligned with current filters/window.'
                : 'Default view shows today only. Use column filters to query across all days.'}
            </div>
          </div>
          {usageRequestUsingTestFallback ? (
            <div className="aoHint">Test mode fallback rows are shown because backend request details are unavailable.</div>
          ) : null}
          {usageRequestError ? <div className="aoHint">Failed to load request details: {usageRequestError}</div> : null}
          <div className="aoUsageRequestChartCard">
            <div className="aoSwitchboardSectionHead">
              <div className="aoMiniLabel">
                Latest {USAGE_REQUEST_GRAPH_SOURCE_LIMIT} Verified Session Requests (Total Tokens)
              </div>
            </div>
            {renderedUsageRequestLineSeries.length ? (
              <div className="aoUsageRequestOriginGrid">
                {([
                  { key: 'windows' as const, label: 'Windows' },
                  { key: 'wsl2' as const, label: 'WSL2' },
                ]).map((originChart) => {
                  const seriesList = usageRequestLineSeriesByOrigin[originChart.key]
                  const sidRows = usageRequestSidRowsWithPositionByOrigin[originChart.key]
                  const isHoveringOrigin = lineHoverOrigin === originChart.key
                  const hoverX = isHoveringOrigin ? lineHoverX : null
                  const hoverIndex = isHoveringOrigin ? lineHoverIndex : null
                  const clipPathId = `${requestLineClipPathId}-${originChart.key}`
                  return (
                    <div key={`request-origin-chart-${originChart.key}`} className="aoUsageRequestOriginCard">
                      <div className="aoSwitchboardSectionHead aoUsageRequestOriginHead">
                        <div className="aoMiniLabel aoUsageRequestOriginTitle">{originChart.label}</div>
                      </div>
                      {seriesList.length ? (
                        <div className="aoUsageRequestLineGraphShell">
                          <div className="aoUsageRequestLineGraphWrap">
                            <svg
                              ref={originChart.key === requestChartMeasureOrigin ? requestChartMeasureRef : undefined}
                              className="aoUsageRequestLineGraph"
                              viewBox={`0 0 ${requestChartWidth} ${requestChartHeight}`}
                              preserveAspectRatio="none"
                              style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' }}
                              role="img"
                              aria-label={`Request token trend (${originChart.label})`}
                              onMouseLeave={() => {
                                setLineHoverOrigin(null)
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
                                setLineHoverOrigin(originChart.key)
                                setLineHoverIndex(Math.max(0, Math.min(usageRequestGraphPointCount - 1, idx)))
                                setLineHoverX(snappedX)
                              }}
                            >
                              <defs>
                                <clipPath id={clipPathId}>
                                  <rect
                                    x={requestChartMinX}
                                    y={requestChartTopY}
                                    width={Math.max(0, requestChartMaxX - requestChartMinX)}
                                    height={Math.max(0, requestChartBottomY - requestChartTopY)}
                                  />
                                </clipPath>
                              </defs>
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
                              <text x={requestChartAxisLabelX} y={requestChartTopY + 4} textAnchor="end" fill="rgba(13, 18, 32, 0.56)" fontSize="10">
                                {formatUsageRequestAxisCompact(usageRequestLineMaxValue)}
                              </text>
                              <text x={requestChartAxisLabelX} y={(requestChartTopY + requestChartBottomY) / 2 + 4} textAnchor="end" fill="rgba(13, 18, 32, 0.5)" fontSize="10">
                                {formatUsageRequestAxisCompact(usageRequestLineMaxValue / 2)}
                              </text>
                              <text x={requestChartAxisLabelX} y={requestChartBottomY + 4} textAnchor="end" fill="rgba(13, 18, 32, 0.5)" fontSize="10">
                                0
                              </text>
                              <text x={requestChartXAxisLeftLabelX} y={requestChartXAxisLabelY} textAnchor="start" fill="rgba(13, 18, 32, 0.54)" fontSize="10">
                                Older
                              </text>
                              <text x={requestChartXAxisRightLabelX} y={requestChartXAxisLabelY} textAnchor="end" fill="rgba(13, 18, 32, 0.54)" fontSize="10">
                                Newer
                              </text>
                              <g clipPath={`url(#${clipPathId})`}>
                                {seriesList.map((series) => {
                                  const activeCount = series.present.reduce((sum, isPresent) => sum + (isPresent ? 1 : 0), 0)
                                  const slidingEligible = Boolean(
                                    (series as { fallbackSlidingEligible?: boolean; liveSlidingEligible?: boolean }).fallbackSlidingEligible ||
                                      (series as { fallbackSlidingEligible?: boolean; liveSlidingEligible?: boolean }).liveSlidingEligible,
                                  )
                                  const previewNextValue = Number(
                                    (series as { fallbackPreviewNextValue?: number | null; livePreviewNextValue?: number | null }).fallbackPreviewNextValue ??
                                      (series as { fallbackPreviewNextValue?: number | null; livePreviewNextValue?: number | null }).livePreviewNextValue ??
                                      NaN,
                                  )
                                  const hasPreviewNextValue = Number.isFinite(previewNextValue)
                                  const isSlidingAnimating =
                                    isRequestsTab &&
                                    requestLineSliding &&
                                    slidingEligible
                                  const isGrowingAnimating =
                                    isRequestsTab &&
                                    requestLineAnimPhase > 0 &&
                                    !slidingEligible &&
                                    hasPreviewNextValue &&
                                    activeCount > 1 &&
                                    activeCount < usageRequestGraphPointCount
                                  const providerPoints: Array<{ x: number; y: number }> = []
                                  if (isSlidingAnimating && activeCount > 1) {
                                    for (let idx = 0; idx < activeCount; idx += 1) {
                                      const value = series.values[idx] ?? 0
                                      const x = requestChartMinX + idx * requestLinePointSpacing - requestLineAnimOffsetX
                                      const y =
                                        requestChartBottomY -
                                        (value / usageRequestLineMaxValue) * (requestChartBottomY - requestChartTopY)
                                      providerPoints.push({ x, y })
                                    }
                                    if (hasPreviewNextValue) {
                                      const nextX = requestChartMinX + activeCount * requestLinePointSpacing - requestLineAnimOffsetX
                                      const nextY =
                                        requestChartBottomY -
                                        (previewNextValue / usageRequestLineMaxValue) * (requestChartBottomY - requestChartTopY)
                                      providerPoints.push({ x: nextX, y: nextY })
                                    }
                                  } else {
                                    series.values.forEach((value, idx) => {
                                      if (!series.present[idx]) return
                                      const x = requestChartMinX + idx * requestLinePointSpacing
                                      const y =
                                        requestChartBottomY -
                                        (value / usageRequestLineMaxValue) * (requestChartBottomY - requestChartTopY)
                                      providerPoints.push({ x, y })
                                    })
                                  }
                                  if (isGrowingAnimating && providerPoints.length > 1) {
                                    const lastPoint = providerPoints[providerPoints.length - 1]
                                    const previewY = hasPreviewNextValue
                                      ? requestChartBottomY -
                                        (previewNextValue / usageRequestLineMaxValue) * (requestChartBottomY - requestChartTopY)
                                      : lastPoint.y
                                    const nextX = Math.min(requestChartMaxX, lastPoint.x + requestLinePointSpacing * requestLineAnimPhase)
                                    const nextY = Math.max(
                                      requestChartTopY,
                                      Math.min(
                                        requestChartBottomY,
                                        lastPoint.y + (previewY - lastPoint.y) * requestLineAnimPhase,
                                      ),
                                    )
                                    providerPoints.push({ x: nextX, y: nextY })
                                  }
                                  if (providerPoints.length <= 1) return null
                                  const pathD = buildSmoothLinePath(providerPoints, { min: requestChartTopY, max: requestChartBottomY })
                                  if (!pathD.trim()) return null
                                  return (
                                    <path
                                      key={`request-line-series-${String((series as { id?: string }).id ?? series.provider)}`}
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
                                {hoverX != null ? (
                                  <line
                                    x1={hoverX}
                                    y1={requestChartTopY}
                                    x2={hoverX}
                                    y2={requestChartBottomY}
                                    stroke="rgba(13, 18, 32, 0.22)"
                                    strokeWidth="1"
                                    strokeDasharray="3 3"
                                  />
                                ) : null}
                                {hoverIndex != null
                                  ? seriesList.map((series) => {
                                      if (!series.present[hoverIndex]) return null
                                      const value = series.values[hoverIndex] ?? 0
                                      const baseX =
                                        requestChartMinX +
                                        (hoverIndex / Math.max(1, usageRequestGraphPointCount - 1)) *
                                          (requestChartMaxX - requestChartMinX)
                                      const slidingEligible = Boolean(
                                        (series as { fallbackSlidingEligible?: boolean; liveSlidingEligible?: boolean }).fallbackSlidingEligible ||
                                          (series as { fallbackSlidingEligible?: boolean; liveSlidingEligible?: boolean }).liveSlidingEligible,
                                      )
                                      const isSlidingAnimating =
                                        isRequestsTab &&
                                        requestLineSliding &&
                                        slidingEligible
                                      const x = isSlidingAnimating ? baseX - requestLineAnimOffsetX : baseX
                                      const y =
                                        requestChartBottomY -
                                        (value / usageRequestLineMaxValue) * (requestChartBottomY - requestChartTopY)
                                      return (
                                        <circle
                                          key={`line-hover-dot-${String((series as { id?: string }).id ?? series.provider)}`}
                                          cx={x}
                                          cy={y}
                                          r="2.2"
                                          fill={series.color}
                                        />
                                      )
                                    })
                                  : null}
                              </g>
                            </svg>
                            {isHoveringOrigin && lineHoverData ? (
                              <div className="aoUsageRequestHoverOverlay" aria-live="polite">
                                <span>
                                  Point {lineHoverData.point}/{usageRequestGraphPointCount} · Total {lineHoverData.total.toLocaleString()}
                                </span>
                                {lineHoverData.rows.map((row) => (
                                  <span key={`hover-overlay-${originChart.key}-${row.id}`} className="aoUsageRequestHoverSummaryItem">
                                    <i style={{ background: row.color }} />
                                    {row.provider}: {row.value.toLocaleString()}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          {sidRows.length ? (
                            <div
                              className="aoUsageRequestSidPanel"
                              aria-label={`Verified session ids in ${originChart.label} chart`}
                              style={{
                                marginTop: `${requestChartTopY}px`,
                                height: `${requestChartBottomY - requestChartTopY}px`,
                              }}
                            >
                              <div className="aoMiniLabel aoUsageRequestSidTitle">SID</div>
                              <div className="aoUsageRequestSidList">
                                {sidRows.map((item) => (
                                  <div
                                    key={`sid-row-${originChart.key}-${item.id}`}
                                    className="aoUsageRequestSidRow"
                                    style={{ top: `${item.top}px`, zIndex: Math.max(1, Math.round(item.latestValue)) }}
                                  >
                                    <span className="aoUsageRequestSidChip">
                                      <i style={{ background: item.color }} />
                                      <span className="aoUsageRequestSidLabel">{item.sidLabel}</span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="aoHint">No recent {originChart.label} verified-session rows for line graph.</div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="aoHint">
                {verifiedSessionIdSet.size === 0
                  ? 'No verified non-agent sessions yet.'
                  : 'No recent verified-session rows for line graph.'}
              </div>
            )}
            {usageRequestLegendSeries.length ? (
              <div className="aoUsageRequestLegend">
                {usageRequestLegendSeries.map((series) => (
                  <span
                    key={`request-line-legend-${String((series as { id?: string }).id ?? series.provider)}`}
                    className="aoUsageRequestLegendItem"
                  >
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
                        const providerOptions = usageRequestFilterOptions.provider
                        if (key === 'provider') {
                          const searchNeedle = usageRequestFilterSearch.provider.toLowerCase()
                          const visibleOptions = usageRequestProviderFilterDisplayOptions
                            .filter((option) => {
                              if (option.label.toLowerCase().includes(searchNeedle)) return true
                              return option.providers.some((provider) =>
                                provider.toLowerCase().includes(searchNeedle),
                              )
                            })
                            .slice(0, 40)
                          const selectedSet = new Set(usageRequestMultiFilters.provider ?? providerOptions)
                          const allVisibleSelected =
                            visibleOptions.length > 0 &&
                            visibleOptions.every((option) =>
                              option.providers.every((provider) => selectedSet.has(provider)),
                            )
                          return (
                            <>
                              <label className="aoUsageReqFilterOptionBtn aoUsageReqFilterOptionSelectAll">
                                <input
                                  type="checkbox"
                                  checked={allVisibleSelected}
                                  onChange={(event) =>
                                    setUsageRequestMultiFilters((prev) => {
                                      const current = new Set(prev.provider ?? providerOptions)
                                      visibleOptions.forEach((option) => {
                                        option.providers.forEach((provider) => {
                                          if (event.target.checked) current.add(provider)
                                          else current.delete(provider)
                                        })
                                      })
                                      const next = [...current]
                                      return {
                                        ...prev,
                                        provider: next.length >= providerOptions.length ? null : next,
                                      }
                                    })
                                  }
                                />
                                <span>(Select All)</span>
                              </label>
                              {visibleOptions.map((option) => {
                                const checked =
                                  option.providers.length > 0 &&
                                  option.providers.every((provider) => selectedSet.has(provider))
                                return (
                                  <label
                                    key={`filter-option-provider-${option.id}`}
                                    className="aoUsageReqFilterOptionBtn"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(event) =>
                                        setUsageRequestMultiFilters((prev) => {
                                          const current = new Set(prev.provider ?? providerOptions)
                                          option.providers.forEach((provider) => {
                                            if (event.target.checked) current.add(provider)
                                            else current.delete(provider)
                                          })
                                          const next = [...current]
                                          return {
                                            ...prev,
                                            provider: next.length >= providerOptions.length ? null : next,
                                          }
                                        })
                                      }
                                    />
                                    <span>{option.label}</span>
                                  </label>
                                )
                              })}
                            </>
                          )
                        }
                        const options =
                          activeUsageRequestFilterMenu.key === 'model'
                              ? usageRequestFilterOptions.model
                              : activeUsageRequestFilterMenu.key === 'origin'
                                ? usageRequestFilterOptions.origin
                                : usageRequestFilterOptions.session
                        const searchNeedle = (
                          activeUsageRequestFilterMenu.key === 'model'
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
                    {!tableRowsForDisplay.length ? (
                      <tr>
                        <td colSpan={9} className="aoHint">
                          {usageRequestLoading
                            ? 'Loading rows...'
                            : defaultTodayOnly && usageRequestHasMore && totalRequestRowsForDisplay === 0
                            ? "Loading today's rows..."
                            : 'No request rows match current filters.'}
                        </td>
                      </tr>
                    ) : (
                      tableRowsForDisplay.map((row) => (
                        <tr key={usageRequestRowIdentity(row)}>
                          <td>{fmtWhen(row.unix_ms)}</td>
                          <td className="aoUsageRequestsMono">{resolveRequestProviderName(row.provider)}</td>
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
                    <td>
                      {hasExplicitRequestFilters
                        ? 'Filtered'
                        : defaultTodayOnly
                          ? 'Today'
                          : 'Window'}{' '}
                      Summary
                    </td>
                    <td>Total {formatRequestSummaryValue(requestTableSummary?.total)}</td>
                    <td>Requests {formatRequestSummaryValue(requestTableSummary?.requests)}</td>
                    <td />
                    <td />
                    <td>{formatRequestSummaryValue(requestTableSummary?.input)}</td>
                    <td>{formatRequestSummaryValue(requestTableSummary?.output)}</td>
                    <td>{formatRequestSummaryValue(requestTableSummary?.cacheCreate)}</td>
                    <td>{formatRequestSummaryValue(requestTableSummary?.cacheRead)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <UsageRequestDailyTotalsCard
            rows={usageRequestDailyBars}
            providers={dailyTotalsProviders}
            colors={USAGE_REQUEST_GRAPH_COLORS}
            formatMonthDay={formatMonthDay}
            loading={usageRequestDailyTotalsLoading}
          />
          <div className="aoUsageRequestsFooter">
            <span className="aoHint">
              {usageRequestLoading
                ? 'Loading more...'
                : usageRequestHasMore
                  ? hasExplicitRequestFilters
                    ? 'Scroll table to load more'
                    : 'Older history available (today view)'
                  : 'All loaded'}
            </span>
            <span className="aoHint">
              {tableRowsForDisplay.length.toLocaleString()} / {totalRequestRowsForDisplay.toLocaleString()} rows
            </span>
          </div>
        </div>
        </div>
      ) : null}
      {effectiveDetailsTab === 'analytics' ? (
        <div className="aoUsageDetailsPane aoUsageDetailsPaneAnalytics">
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
        </div>
      ) : null}
    </div>
  )
}
