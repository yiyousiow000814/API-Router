import { invoke } from '@tauri-apps/api/core'
import { useCallback, useRef } from 'react'
import {
  buildUsageRequestEntriesArgs,
  buildUsageRequestsQueryKey,
  primeUsageRequestsPrefetchCache,
} from '../components/UsageStatisticsPanel'

const USAGE_STATS_INTENT_PREFETCH_COOLDOWN_MS = 60_000
const USAGE_REQUESTS_INTENT_PREFETCH_COOLDOWN_MS = 2_000
const USAGE_REQUESTS_PREFETCH_LIMIT = 2000
const USAGE_REQUESTS_PREFETCH_HOURS = 24 * 365 * 20

type TopPage =
  | 'dashboard'
  | 'usage_statistics'
  | 'usage_requests'
  | 'provider_switchboard'
  | 'event_log'

type Params = {
  activePage: TopPage
  refreshUsageStatistics: (opts?: { silent?: boolean }) => Promise<unknown> | void
}

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

function startOfDayUnixMs(unixMs: number): number {
  const date = new Date(unixMs)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function buildDailyTotalsFromRows(rows: UsageRequestEntry[], dayLimit: number) {
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
      return { day_start_unix_ms: day, provider_totals, total_tokens }
    })
  const providers = [...providerTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([provider, total_tokens]) => ({ provider, total_tokens }))
  return { days, providers }
}

function buildSyntheticUsageRequestRows(limit: number): UsageRequestEntry[] {
  const providers = ['official', 'provider_1', 'provider_2']
  const origins = ['windows', 'wsl2']
  const models = ['gpt-5.2-codex']
  const now = Date.now()
  let seed = (now + limit * 13) >>> 0
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return seed / 4294967296
  }

  const windowMs = 45 * 24 * 60 * 60 * 1000
  const rows: UsageRequestEntry[] = []
  const count = Math.max(0, limit)
  for (let i = 0; i < count; i += 1) {
    const provider = providers[Math.floor(rand() * providers.length)]
    const origin = origins[i % origins.length]
    const input = 100_000 + Math.floor(rand() * 900_000)
    const output = 1_000 + Math.floor(rand() * 9_000)
    const total = input + output
    const cacheCreate = i % 7 === 0 ? 100_000 + Math.floor(rand() * 900_000) : 0
    const cacheRead = i % 4 === 0 ? 100_000 + Math.floor(rand() * 900_000) : 0
    rows.push({
      provider,
      api_key_ref: '-',
      model: models[0],
      origin,
      session_id: `session_${String(i).padStart(4, '0')}`,
      unix_ms: now - Math.floor(rand() * windowMs),
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead,
    })
  }
  return rows.sort((a, b) => b.unix_ms - a.unix_ms)
}

export function useTopNavIntentPrefetch({
  activePage,
  refreshUsageStatistics,
}: Params) {
  const usageStatsIntentPrefetchAtRef = useRef<number>(0)
  const usageStatsIntentPrefetchInFlightRef = useRef<boolean>(false)
  const usageRequestsIntentPrefetchAtRef = useRef<number>(0)
  const usageRequestsIntentPrefetchInFlightRef = useRef<boolean>(false)

  const handleUsageStatisticsIntentPrefetch = useCallback(() => {
    if (activePage === 'usage_statistics') return
    if (usageStatsIntentPrefetchInFlightRef.current) return
    const now = Date.now()
    if (
      now - usageStatsIntentPrefetchAtRef.current <
      USAGE_STATS_INTENT_PREFETCH_COOLDOWN_MS
    ) {
      return
    }
    usageStatsIntentPrefetchAtRef.current = now
    usageStatsIntentPrefetchInFlightRef.current = true
    void Promise.resolve(refreshUsageStatistics({ silent: true })).finally(() => {
      usageStatsIntentPrefetchInFlightRef.current = false
    })
  }, [activePage, refreshUsageStatistics])

  const handleUsageRequestsIntentPrefetch = useCallback(() => {
    if (activePage === 'usage_requests') return
    if (usageRequestsIntentPrefetchInFlightRef.current) return
    const now = Date.now()
    if (
      now - usageRequestsIntentPrefetchAtRef.current <
      USAGE_REQUESTS_INTENT_PREFETCH_COOLDOWN_MS
    ) {
      return
    }
    usageRequestsIntentPrefetchAtRef.current = now
    usageRequestsIntentPrefetchInFlightRef.current = true
    const requestQueryKey = buildUsageRequestsQueryKey({
      hours: USAGE_REQUESTS_PREFETCH_HOURS,
      fromUnixMs: null,
      toUnixMs: null,
      providers: null,
      models: null,
      origins: null,
      sessions: null,
    })

    void (async () => {
      try {
        const [rowsRes, dailyRes] = await Promise.all([
          invoke<{ ok: boolean; rows: UsageRequestEntry[]; has_more: boolean }>('get_usage_request_entries', {
            ...buildUsageRequestEntriesArgs({
              hours: USAGE_REQUESTS_PREFETCH_HOURS,
              fromUnixMs: null,
              toUnixMs: null,
              providers: null,
              models: null,
              origins: null,
              sessions: null,
              limit: USAGE_REQUESTS_PREFETCH_LIMIT,
              offset: 0,
            }),
          }),
          invoke<{
            ok: boolean
            days: Array<{
              day_start_unix_ms: number
              provider_totals: Record<string, number>
              total_tokens: number
            }>
            providers: Array<{
              provider: string
              total_tokens: number
            }>
          }>('get_usage_request_daily_totals', { days: 45 }),
        ])
        primeUsageRequestsPrefetchCache({
          queryKey: requestQueryKey,
          rows: rowsRes.rows ?? [],
          hasMore: Boolean(rowsRes.has_more),
          dailyTotals: {
            days: dailyRes.days ?? [],
            providers: dailyRes.providers ?? [],
          },
        })
      } catch {
        // Non-Tauri dev server (or transient backend issues): prime a lightweight synthetic cache to avoid 0->loaded flashes.
        const fallbackRows = buildSyntheticUsageRequestRows(Math.min(800, USAGE_REQUESTS_PREFETCH_LIMIT))
        const dailyTotals = buildDailyTotalsFromRows(fallbackRows, 45)
        primeUsageRequestsPrefetchCache({
          queryKey: requestQueryKey,
          rows: fallbackRows,
          hasMore: true,
          dailyTotals,
        })
      } finally {
        usageRequestsIntentPrefetchInFlightRef.current = false
      }
    })()
  }, [activePage])

  return {
    handleUsageStatisticsIntentPrefetch,
    handleUsageRequestsIntentPrefetch,
  }
}
