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
import { UsageRequestDailyTotalsCard } from './UsageRequestDailyTotalsCard'
import { UsageStatsFiltersBar } from './UsageStatsFiltersBar'
import { useUsageHistoryScrollbar } from '../hooks/useUsageHistoryScrollbar'
import { isNearBottom } from '../utils/scroll'

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
function pickUsageRequestDisplayProviders(input: {
  selectedProviders: string[] | null
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
  if (input.selectedProviders && input.selectedProviders.length > 0) {
    [...input.selectedProviders].sort(compareUsageProvidersForDisplay).forEach(append)
  }
  input.graphProviders.forEach(append)
  input.dailyProviders.forEach(append)
  input.analyticsProviders.forEach(append)
  return picked.slice(0, input.limit)
}
function listTopUsageProvidersFromRows(rows: UsageRequestEntry[]): string[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
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
  { provider: 'official', model: 'gpt-5.2-codex', requests: 34, apiKeyRef: '-' },
  { provider: 'provider_1', model: 'gpt-5.2-codex', requests: 40, apiKeyRef: '-' },
  { provider: 'provider_2', model: 'gpt-5.2-codex', requests: 26, apiKeyRef: '-' },
] as const
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const EMPTY_USAGE_REQUEST_ROWS: UsageRequestEntry[] = []
const EMPTY_USAGE_REQUEST_ROWS_BY_PROVIDER: Record<string, UsageRequestEntry[]> = {}
const EMPTY_STRING_LIST: string[] = []
const USAGE_REQUESTS_PAGE_FETCH_HOURS = 24 * 365 * 20
const USAGE_REQUESTS_PAGE_QUERY_KEY = JSON.stringify({
  hours: USAGE_REQUESTS_PAGE_FETCH_HOURS,
  providers: [],
  models: [],
  origins: [],
})
const USAGE_REQUESTS_CACHE_PRIMED_EVENT = 'ao:usage-requests-cache-primed'
const USAGE_REQUESTS_PAGE_PREFETCH_COOLDOWN_MS = 4_000
const USAGE_REQUEST_GRAPH_FETCH_HOURS = 24 * 365 * 20
const USAGE_REQUEST_GRAPH_QUERY_KEY = 'usage_request_graph:v1:all-history'
const USAGE_REQUEST_GRAPH_BACKGROUND_REFRESH_MS = 15_000
let usageRequestsPageCache: UsageRequestsPageCache | null = null
let usageRequestsLastNonEmptyPageCache: UsageRequestsPageCache | null = null
let usageRequestDailyTotalsCache: UsageRequestDailyTotalsCache | null = null
let usageRequestGraphRowsCache: UsageRequestGraphRowsCache | null = null

export function resolveRequestFetchHours(input: {
  effectiveDetailsTab: UsageDetailsTab
  showFilters: boolean
  usageWindowHours: number
}): number {
  if (input.effectiveDetailsTab !== 'requests') return input.usageWindowHours
  if (!input.showFilters) return USAGE_REQUESTS_PAGE_FETCH_HOURS
  return input.usageWindowHours
}

function combineStringFilterLists(
  left: string[] | null,
  right: string[] | null,
): string[] | null {
  if (left == null && right == null) return null
  if (left == null) return right
  if (right == null) return left
  const rightSet = new Set(right.map((v) => v.toLowerCase()))
  return left.filter((v) => rightSet.has(v.toLowerCase()))
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
): Record<string, UsageRequestEntry[]> {
  const grouped = new Map<string, UsageRequestEntry[]>()
  for (const row of rows) {
    const list = grouped.get(row.provider) ?? []
    if (list.length >= perProviderLimit) continue
    list.push(row)
    grouped.set(row.provider, list)
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
}): UsageRequestTableSummary | null {
  if (input.usageRequestSummary?.ok) {
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
}) {
  usageRequestsPageCache = {
    queryKey: payload.queryKey,
    rows: payload.rows ?? [],
    hasMore: Boolean(payload.hasMore),
    usingTestFallback: false,
  }
  if ((payload.rows ?? []).length > 0) {
    usageRequestsLastNonEmptyPageCache = {
      queryKey: payload.queryKey,
      rows: payload.rows ?? [],
      hasMore: Boolean(payload.hasMore),
      usingTestFallback: false,
    }
  }
  if (payload.dailyTotals) {
    usageRequestDailyTotalsCache = payload.dailyTotals
  }
  primeUsageRequestGraphCacheFromBaseRows(payload.rows ?? [])
  emitUsageRequestsCachePrimed(payload.queryKey)
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
    const totalTokens = Number(day.total_tokens ?? 0)
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) continue
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

function readTestFlagFromLocation(): boolean {
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

function buildUsageRequestTestRows(
  stats: UsageStatistics | null,
  usageWindowHours: number,
  forceSyntheticProviders = false,
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

function buildDailyTotalsCacheFromRows(
  rows: UsageRequestEntry[],
  dayLimit: number,
): UsageRequestDailyTotalsCache {
  const byDay = new Map<number, Map<string, number>>()
  const providerTotals = new Map<string, number>()
  for (const row of rows) {
    const day = startOfDayUnixMs(row.unix_ms)
    const dayMap = byDay.get(day) ?? new Map<string, number>()
    dayMap.set(row.provider, (dayMap.get(row.provider) ?? 0) + row.total_tokens)
    byDay.set(day, dayMap)
    providerTotals.set(row.provider, (providerTotals.get(row.provider) ?? 0) + row.total_tokens)
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
  const usageRequestRefreshInFlightRef = useRef(false)
  const usageRequestGraphRefreshInFlightRef = useRef(false)
  const usageRequestGraphLastRefreshAtRef = useRef(0)
  const usageRequestFetchSeqRef = useRef(0)
  const usageRequestGraphBaseFetchSeqRef = useRef(0)
  const usageRequestGraphProviderFetchSeqRef = useRef(new Map<string, number>())
  const usageRequestDailyTotalsFetchSeqRef = useRef(0)
  const usageRequestLoadedQueryKeyRef = useRef<string | null>(null)
  const usageRequestLastActivityRef = useRef<number | null>(null)
  const usageRequestWasNearBottomRef = useRef(false)
  const usageRequestWarmupAtRef = useRef(0)
  const usageRequestDefaultTodayAutoPageRef = useRef(false)
  const usageRequestsPagePrefetchInFlightRef = useRef(false)
  const usageRequestsPagePrefetchAtRef = useRef(0)
  const usageRequestTestFallbackEnabled = useMemo(() => readTestFlagFromLocation() || import.meta.env.DEV, [])
  const usageRequestTestRows = useMemo(
    () => buildUsageRequestTestRows(usageStatistics, usageWindowHours, usageRequestTestFallbackEnabled),
    [usageRequestTestFallbackEnabled, usageStatistics, usageWindowHours],
  )
  const useGlobalRequestFilters = showFilters
  const requestFetchProviders = useMemo(
    () =>
      combineStringFilterLists(
        useGlobalRequestFilters && usageFilterProviders.length ? usageFilterProviders : null,
        usageRequestMultiFilters.provider,
      ),
    [useGlobalRequestFilters, usageFilterProviders, usageRequestMultiFilters.provider],
  )
  const requestFetchModels = useMemo(
    () =>
      combineStringFilterLists(
        useGlobalRequestFilters && usageFilterModels.length ? usageFilterModels : null,
        usageRequestMultiFilters.model,
      ),
    [useGlobalRequestFilters, usageFilterModels, usageRequestMultiFilters.model],
  )
  const requestFetchOrigins = useMemo(
    () =>
      combineStringFilterLists(
        useGlobalRequestFilters && usageFilterOrigins.length ? usageFilterOrigins : null,
        usageRequestMultiFilters.origin,
      ),
    [useGlobalRequestFilters, usageFilterOrigins, usageRequestMultiFilters.origin],
  )
  const requestFetchSessions = usageRequestMultiFilters.session
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
      JSON.stringify({
        hours: requestFetchHours,
        from_unix_ms: requestFetchFromUnixMs,
        to_unix_ms: requestFetchToUnixMs,
        providers: requestFetchProviders ?? [],
        models: requestFetchModels ?? [],
        origins: requestFetchOrigins ?? [],
        sessions: requestFetchSessions ?? [],
      }),
    [
      requestFetchFromUnixMs,
      requestFetchHours,
      requestFetchModels,
      requestFetchOrigins,
      requestFetchProviders,
      requestFetchSessions,
      requestFetchToUnixMs,
    ],
  )
  const requestGraphQueryKey = USAGE_REQUEST_GRAPH_QUERY_KEY
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
    (requestFetchSessions !== null && requestFetchSessions.length === 0)
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
  const prevIsRequestsTabRef = useRef(isRequestsTab)
  const justEnteredRequestsTab = isRequestsTab && !prevIsRequestsTabRef.current
  const shouldPrepareRequestsData = isRequestsTab
  const isRequestsOnlyPage = effectiveDetailsTab === 'requests' && !showFilters
  const cachedRequestsPage =
    usageRequestsPageCache != null && usageRequestsPageCache.queryKey === requestQueryKey
      ? usageRequestsPageCache
      : null
  const canonicalRequestsPageCache =
    usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_PAGE_QUERY_KEY
      ? usageRequestsPageCache
      : null
  const lastNonEmptyRequestsPageCache = usageRequestsLastNonEmptyPageCache
  const cachedGraphRows =
    usageRequestGraphRowsCache != null && usageRequestGraphRowsCache.queryKey === requestGraphQueryKey
      ? usageRequestGraphRowsCache
      : null
  const deferredUsageRequestRows = useDeferredValue(usageRequestRows)
  const rowsForRequestRender = isRequestsTab
    ? deferredUsageRequestRows.length > 0
      ? deferredUsageRequestRows
      : usageRequestRows.length > 0
        ? usageRequestRows
        : cachedRequestsPage?.rows ??
          canonicalRequestsPageCache?.rows ??
          lastNonEmptyRequestsPageCache?.rows ??
          EMPTY_USAGE_REQUEST_ROWS
    : EMPTY_USAGE_REQUEST_ROWS
  const deferredUsageRequestGraphBaseRows = useDeferredValue(usageRequestGraphBaseRows)
  const deferredUsageRequestGraphRowsByProvider = useDeferredValue(usageRequestGraphRowsByProvider)
  const graphBaseRowsForRequestRender = shouldPrepareRequestsData
    ? deferredUsageRequestGraphBaseRows.length > 0
      ? deferredUsageRequestGraphBaseRows
      : usageRequestGraphBaseRows.length > 0
        ? usageRequestGraphBaseRows
        : cachedGraphRows?.baseRows ?? EMPTY_USAGE_REQUEST_ROWS
    : EMPTY_USAGE_REQUEST_ROWS
  const graphRowsByProviderForRequestRender = shouldPrepareRequestsData
    ? Object.keys(deferredUsageRequestGraphRowsByProvider).length > 0
      ? deferredUsageRequestGraphRowsByProvider
      : Object.keys(usageRequestGraphRowsByProvider).length > 0
        ? usageRequestGraphRowsByProvider
        : cachedGraphRows?.rowsByProvider ?? EMPTY_USAGE_REQUEST_ROWS_BY_PROVIDER
    : EMPTY_USAGE_REQUEST_ROWS_BY_PROVIDER
  const usageRequestGraphProviderCount = useMemo(
    () => Object.keys(usageRequestGraphRowsByProvider).length,
    [usageRequestGraphRowsByProvider],
  )

  useEffect(() => {
    prevIsRequestsTabRef.current = isRequestsTab
  }, [isRequestsTab])

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
      if (usageRequestRefreshInFlightRef.current) return
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
      requestFetchFromUnixMs,
      requestFetchProviders,
      requestFetchModels,
      requestFetchOrigins,
      requestFetchSessions,
      requestFetchToUnixMs,
      usageRequestTestFallbackEnabled,
      usageRequestTestRows,
    ],
  )
  const refreshUsageRequestSummary = useCallback(async () => {
    if (!isRequestsTab) return
    if (hasImpossibleRequestFilters) {
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
      setUsageRequestSummary(res)
    } catch {
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
    ],
  )
  const prefetchUsageRequestsPageCache = useCallback(async (limit: number) => {
    if (usageRequestsPagePrefetchInFlightRef.current) return
    const now = Date.now()
    if (now - usageRequestsPagePrefetchAtRef.current < USAGE_REQUESTS_PAGE_PREFETCH_COOLDOWN_MS) return
    const cached =
      usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_PAGE_QUERY_KEY
        ? usageRequestsPageCache
        : null
    if (cached && cached.rows.length > 0) return
    usageRequestsPagePrefetchAtRef.current = now
    usageRequestsPagePrefetchInFlightRef.current = true
    try {
      const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
        ...buildUsageRequestEntriesArgs({
          hours: USAGE_REQUESTS_PAGE_FETCH_HOURS,
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
        queryKey: USAGE_REQUESTS_PAGE_QUERY_KEY,
        rows: nextRows,
        hasMore: Boolean(res.has_more),
        usingTestFallback: false,
      }
      if (nextRows.length > 0) {
        usageRequestsLastNonEmptyPageCache = {
          queryKey: USAGE_REQUESTS_PAGE_QUERY_KEY,
          rows: nextRows,
          hasMore: Boolean(res.has_more),
          usingTestFallback: false,
        }
        primeUsageRequestGraphCacheFromBaseRows(nextRows)
      }
      emitUsageRequestsCachePrimed(USAGE_REQUESTS_PAGE_QUERY_KEY)
    } catch {
      if (usageRequestTestFallbackEnabled) {
        const nextRows = usageRequestTestRows.slice(0, Math.max(1, limit))
        usageRequestsPageCache = {
          queryKey: USAGE_REQUESTS_PAGE_QUERY_KEY,
          rows: nextRows,
          hasMore: usageRequestTestRows.length > nextRows.length,
          usingTestFallback: true,
        }
        if (nextRows.length > 0) {
          usageRequestsLastNonEmptyPageCache = usageRequestsPageCache
          primeUsageRequestGraphCacheFromBaseRows(nextRows)
        }
        emitUsageRequestsCachePrimed(USAGE_REQUESTS_PAGE_QUERY_KEY)
      }
    } finally {
      usageRequestsPagePrefetchInFlightRef.current = false
    }
  }, [usageRequestTestFallbackEnabled, usageRequestTestRows])
  const refreshUsageRequestGraphRows = useCallback(async () => {
    if (usageRequestGraphRefreshInFlightRef.current) return
    usageRequestGraphRefreshInFlightRef.current = true
    const requestSeq = usageRequestGraphBaseFetchSeqRef.current + 1
    usageRequestGraphBaseFetchSeqRef.current = requestSeq
    try {
      const cachedGraph =
        usageRequestGraphRowsCache != null && usageRequestGraphRowsCache.queryKey === requestGraphQueryKey
          ? usageRequestGraphRowsCache
          : null
      const canonicalPageRows =
        usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_PAGE_QUERY_KEY
          ? usageRequestsPageCache.rows
          : EMPTY_USAGE_REQUEST_ROWS
      const baseRows =
        cachedGraph?.baseRows?.length
          ? cachedGraph.baseRows
          : canonicalPageRows.length
            ? canonicalPageRows
            : usageRequestRows.length
              ? usageRequestRows
              : usageRequestTestFallbackEnabled
                ? usageRequestTestRows
                : EMPTY_USAGE_REQUEST_ROWS
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

      if (!usageRequestGraphBaseRows.length && baseRows.length) {
        setUsageRequestGraphBaseRows(baseRows)
      }
      const providerTargets = pickUsageRequestDisplayProviders({
        selectedProviders: usageRequestMultiFilters.provider,
        graphProviders: baseRows.length ? listTopUsageProvidersFromRows(baseRows) : EMPTY_STRING_LIST,
        dailyProviders: usageRequestDailyTotalsProviders.map((row) => row.provider),
        analyticsProviders: usageByProvider.map((row) => row.provider),
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
        const next: Record<string, UsageRequestEntry[]> = {}
        let changed = false
        for (const provider of providerTargets) {
          const existingRows = prev[provider]
          const seedRows = seedRowsByProvider[provider]
          if (existingRows && existingRows.length) {
            next[provider] = existingRows
          } else if (seedRows && seedRows.length) {
            next[provider] = seedRows
            changed = true
          }
        }
        if (!changed && Object.keys(prev).every((provider) => targetSet.has(provider))) return prev
        return next
      })
      usageRequestGraphRowsCache = {
        queryKey: requestGraphQueryKey,
        baseRows,
        rowsByProvider: seedRowsByProvider,
      }
      for (const provider of providerTargets) {
        const nextProviderSeq = (usageRequestGraphProviderFetchSeqRef.current.get(provider) ?? 0) + 1
        usageRequestGraphProviderFetchSeqRef.current.set(provider, nextProviderSeq)
        void (async () => {
          try {
            const res = await invoke<UsageRequestEntriesResponse>('get_usage_request_entries', {
              hours: USAGE_REQUEST_GRAPH_FETCH_HOURS,
              providers: [provider],
              models: null,
              origins: null,
              limit: USAGE_REQUEST_GRAPH_SOURCE_LIMIT,
              offset: 0,
            })
            const providerSeq = usageRequestGraphProviderFetchSeqRef.current.get(provider)
            if (providerSeq !== nextProviderSeq) return
            const providerRows = (res.rows ?? []).sort((a, b) => b.unix_ms - a.unix_ms)
            setUsageRequestGraphRowsByProvider((prev) => {
              const currentRows = prev[provider] ?? []
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
          } catch {
            // Keep previous provider line on partial refresh failures.
          }
        })()
      }
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
    }
  }, [
    requestGraphQueryKey,
    usageByProvider,
    usageRequestDailyTotalsProviders,
    usageRequestMultiFilters.provider,
    usageRequestGraphBaseRows.length,
    usageRequestRows,
    usageRequestTestFallbackEnabled,
    usageRequestTestRows,
  ])
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
      usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_PAGE_QUERY_KEY
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
      usageRequestsPageCache != null && usageRequestsPageCache.queryKey === USAGE_REQUESTS_PAGE_QUERY_KEY
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
    } else if (usageRequestGraphBaseRows.length === 0 && usageRequestRows.length > 0) {
      const bootstrapRowsByProvider = groupUsageRequestRowsByProvider(usageRequestRows)
      setUsageRequestGraphBaseRows(usageRequestRows)
      setUsageRequestGraphRowsByProvider(bootstrapRowsByProvider)
    } else if (usageRequestGraphBaseRows.length === 0 && cached?.rows?.length) {
      // Fast first paint from table cache; graph will be refreshed immediately below.
      const bootstrapRowsByProvider = groupUsageRequestRowsByProvider(cached.rows)
      setUsageRequestGraphBaseRows(cached.rows)
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
        setUsageRequestRows(requestPageCached.rows)
        setUsageRequestHasMore(requestPageCached.hasMore)
        setUsageRequestUsingTestFallback(requestPageCached.usingTestFallback)
      }
    } else if (isRequestsTab && isOnlyUnknownFallbackCache) {
      usageRequestsPageCache = null
    }
    const cachedGraphProviderCount = cachedGraph != null ? Object.keys(cachedGraph.rowsByProvider).length : 0
    const graphSnapshotReady =
      (usageRequestGraphBaseRows.length > 0 && usageRequestGraphProviderCount > 0) || cachedGraphProviderCount > 0
    if (isRequestsTab) {
      if (hasUsableRequestPageCache) {
        if (
          !graphSnapshotReady ||
          Date.now() - usageRequestGraphLastRefreshAtRef.current > USAGE_REQUEST_GRAPH_BACKGROUND_REFRESH_MS
        ) {
          void refreshUsageRequestGraphRows()
        }
        void mergeLatestUsageRequests(USAGE_REQUEST_PAGE_SIZE)
        return
      }

      const shouldRefresh = usageRequestLoadedQueryKeyRef.current !== requestQueryKey || usageRequestRows.length === 0
      if (shouldRefresh) {
        usageRequestLoadedQueryKeyRef.current = requestQueryKey
        if (hasStrictRequestQuery && usageRequestRows.length > 0) {
          // Strict filters (date/provider/model/origin/session) must not render stale rows.
          setUsageRequestRows([])
          setUsageRequestHasMore(false)
        }
        void refreshUsageRequests(initialRefreshLimit)
        void refreshUsageRequestGraphRows()
        return
      }
      if (
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
    mergeLatestUsageRequests,
    requestQueryKey,
    requestGraphQueryKey,
    usageRequestRows,
    usageRequestGraphBaseRows.length,
    usageRequestGraphProviderCount,
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
  }, [isRequestsTab, requestGraphQueryKey, usageRequestGraphBaseRows, usageRequestGraphRowsByProvider])

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
    if (Date.now() - usageRequestGraphLastRefreshAtRef.current > 1_000) {
      void refreshUsageRequestGraphRows()
    }
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
    }
  }, [
    requestFetchHours,
    requestFetchFromUnixMs,
    requestFetchModels,
    requestFetchOrigins,
    requestFetchProviders,
    requestFetchSessions,
    requestFetchToUnixMs,
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

  const usageRequestProviderOptions = useMemo(() => {
    if (!shouldPrepareRequestsData) return EMPTY_STRING_LIST
    const counts = new Map<string, number>()
    for (const row of graphBaseRowsForRequestRender) {
      counts.set(row.provider, (counts.get(row.provider) ?? 0) + 1)
    }
    if (counts.size === 0) {
      for (const provider of Object.keys(graphRowsByProviderForRequestRender)) {
        counts.set(provider, graphRowsByProviderForRequestRender[provider]?.length ?? 0)
      }
    }
    return [...counts.entries()]
      .sort((a, b) => {
        const providerOrder = compareUsageProvidersForDisplay(a[0], b[0])
        if (providerOrder !== 0) return providerOrder
        if (a[1] !== b[1]) return b[1] - a[1]
        return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })
      })
      .map(([provider]) => provider)
  }, [graphBaseRowsForRequestRender, graphRowsByProviderForRequestRender, shouldPrepareRequestsData])

  const usageRequestDisplayProviders = useMemo(() => {
    return pickUsageRequestDisplayProviders({
      selectedProviders: usageRequestMultiFilters.provider,
      graphProviders: usageRequestProviderOptions,
      dailyProviders: usageRequestDailyTotalsProviders.map((row) => row.provider),
      analyticsProviders: usageByProvider.map((row) => row.provider),
      limit: Math.min(3, USAGE_REQUEST_GRAPH_COLORS.length),
    })
  }, [
    usageByProvider,
    usageRequestDailyTotalsProviders,
    usageRequestMultiFilters.provider,
    usageRequestProviderOptions,
  ])
  const activeRequestGraphProviders = usageRequestDisplayProviders

  const usageRequestGraphPointCount = USAGE_REQUEST_GRAPH_SOURCE_LIMIT

  const usageRequestRowsByProvider = useMemo(() => {
    if (!shouldPrepareRequestsData) return new Map<string, UsageRequestEntry[]>()
    const out = new Map<string, UsageRequestEntry[]>()
    for (const provider of activeRequestGraphProviders) {
      const rows = graphRowsByProviderForRequestRender[provider] ?? []
      out.set(provider, rows.slice(0, USAGE_REQUEST_GRAPH_SOURCE_LIMIT))
    }
    return out
  }, [activeRequestGraphProviders, graphRowsByProviderForRequestRender, shouldPrepareRequestsData])

  const usageRequestLineSeries = useMemo(() => {
    if (!shouldPrepareRequestsData) return []
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
  }, [activeRequestGraphProviders, shouldPrepareRequestsData, usageRequestGraphPointCount, usageRequestRowsByProvider])

  const usageRequestLineMaxValue = useMemo(() => {
    let maxValue = 0
    for (const series of usageRequestLineSeries) {
      for (const value of series.values) {
        if (value > maxValue) maxValue = value
      }
    }
    return Math.max(1, maxValue)
  }, [usageRequestLineSeries])
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

  const usageRequestDailyWindowRows = useMemo(() => {
    if (!isRequestsTab || !usageRequestDailyTotalsDays.length) return []
    const byDay = new Map<number, Record<string, number>>()
    for (const row of usageRequestDailyTotalsDays) {
      if (!row || typeof row.day_start_unix_ms !== 'number') continue
      byDay.set(row.day_start_unix_ms, row.provider_totals ?? {})
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
  }, [isRequestsTab, usageRequestDailyTotalsDays])

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
  const displayedFilteredUsageRequestRows = justEnteredRequestsTab ? filteredUsageRequestRows : deferredFilteredUsageRequestRows
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
  const requestChartWidth = 1000
  const requestChartHeight = 176
  const requestChartMinX = 54
  const requestChartMaxX = 982
  const requestChartTopY = 14
  const requestChartBottomY = 136
  const [lineHoverIndex, setLineHoverIndex] = useState<number | null>(null)
  const [lineHoverX, setLineHoverX] = useState<number | null>(null)
  const lineHoverData = useMemo(() => {
    if (!isRequestsTab) return null
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
  }, [isRequestsTab, lineHoverIndex, usageRequestGraphPointCount, usageRequestLineSeries])
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
      }),
    [displayedFilteredUsageRequestRows, usageRequestHasMore, usageRequestSummary],
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
                    {!displayedFilteredUsageRequestRows.length && !usageRequestLoading ? (
                      <tr>
                        <td colSpan={9} className="aoHint">
                          {defaultTodayOnly && usageRequestHasMore
                            ? "Loading today's rows..."
                            : 'No request rows match current filters.'}
                        </td>
                      </tr>
                    ) : (
                      displayedFilteredUsageRequestRows.map((row) => (
                        <tr key={usageRequestRowIdentity(row)}>
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
              {displayedFilteredUsageRequestRows.length.toLocaleString()} / {usageRequestRows.length.toLocaleString()} rows
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
