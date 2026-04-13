import { invoke } from '@tauri-apps/api/core'
import { useCallback, useRef } from 'react'
import type { Status } from '../types'
import {
  buildUsageRequestEntriesArgs,
  buildUsageRequestsQueryKey,
  readTestFlagFromLocation,
  USAGE_REQUEST_GRAPH_QUERY_KEY,
  USAGE_REQUESTS_CANONICAL_FETCH_HOURS,
  USAGE_REQUESTS_CANONICAL_QUERY_KEY,
  USAGE_REQUEST_TEST_DATA_REVISION,
  primeUsageRequestGraphPrefetchCache,
  primeUsageRequestsPrefetchCache,
} from '../components/UsageStatisticsPanel'

const USAGE_STATS_INTENT_PREFETCH_COOLDOWN_MS = 60_000
const USAGE_REQUESTS_INTENT_PREFETCH_COOLDOWN_MS = 2_000
const USAGE_REQUESTS_PREFETCH_LIMIT = 2000

type TopPage =
  | 'dashboard'
  | 'usage_statistics'
  | 'usage_requests'
  | 'provider_switchboard'
  | 'event_log'
  | 'web_codex'
  | 'monitor'

type Params = {
  activePage: TopPage
  refreshUsageStatistics: (opts?: {
    silent?: boolean
    interactive?: boolean
    source?: string
  }) => Promise<unknown> | void
  clientSessions?: Status['client_sessions']
}

type UsageRequestEntry = {
  id?: string
  provider: string
  api_key_ref: string
  model: string
  origin: string
  session_id: string
  unix_ms: number
  node_id?: string
  node_name?: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

type SyntheticSessionSeed = {
  sessionId: string
  provider: string
  origin: 'windows' | 'wsl2'
  requests: number
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

function groupRowsByProvider(rows: UsageRequestEntry[], providerLimit: number) {
  const out = new Map<string, UsageRequestEntry[]>()
  for (const row of rows) {
    const provider = String(row?.provider ?? '').trim()
    if (!provider) continue
    const list = out.get(provider) ?? []
    if (list.length >= providerLimit) continue
    list.push(row)
    out.set(provider, list)
  }
  return Object.fromEntries(out.entries())
}

function stableSeedFromText(text: string): number {
  let hash = 2166136261
  for (let idx = 0; idx < text.length; idx += 1) {
    hash ^= text.charCodeAt(idx)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function buildSyntheticSessionSeeds(clientSessions: Status['client_sessions'] | undefined): SyntheticSessionSeed[] {
  const sessionById = new Map<string, SyntheticSessionSeed & { verified: boolean }>()
  for (const session of clientSessions ?? []) {
    if (!session) continue
    const sessionId = String(session.codex_session_id ?? '').trim() || String(session.id ?? '').trim()
    if (!sessionId) continue
    const providerCandidates = [
      String(session.current_provider ?? '').trim(),
      String(session.preferred_provider ?? '').trim(),
      String(session.reported_model_provider ?? '').trim(),
    ]
    const provider = providerCandidates.find((value) => value && value !== '-' && value.toLowerCase() !== 'api_router') ?? 'provider_1'
    const wtSession = String(session.wt_session ?? '').trim().toLowerCase()
    const origin: 'windows' | 'wsl2' = wtSession.includes('wsl') ? 'wsl2' : 'windows'
    const requests = session.active ? 8 : 3
    const verified = Boolean(session.verified)
    const existing = sessionById.get(sessionId)
    if (existing) {
      sessionById.set(sessionId, {
        ...existing,
        provider,
        origin,
        requests: Math.max(existing.requests, requests),
        verified: existing.verified || verified,
      })
      continue
    }
    sessionById.set(sessionId, { sessionId, provider, origin, requests, verified })
  }
  const rows = [...sessionById.values()]
  const verifiedRows = rows.filter((item) => item.verified)
  const selected = verifiedRows.length > 0 ? verifiedRows : rows
  return selected.map((item) => ({
    sessionId: item.sessionId,
    provider: item.provider,
    origin: item.origin,
    requests: item.requests,
  }))
}

function buildSyntheticUsageRequestRows(limit: number, clientSessions?: Status['client_sessions']): UsageRequestEntry[] {
  const fallbackSessions = [
    { sessionId: '019c4578-0f3c-7f82-a4f9-b41a1e65e242', provider: 'provider_1', origin: 'windows', requests: 8 },
    { sessionId: '019c03fd-6ea4-7121-961f-9f9b64d2c1b5', provider: 'provider_1', origin: 'wsl2', requests: 7 },
    { sessionId: '019c7f46-c5ec-7e2e-9205-4e00718a524e', provider: 'provider_2', origin: 'wsl2', requests: 5 },
    { sessionId: '019c9f18-3d72-7ce3-a9a1-2fd7f4d9d100', provider: 'provider_3', origin: 'windows', requests: 4 },
  ] as const satisfies SyntheticSessionSeed[]
  const sessionSeeds = buildSyntheticSessionSeeds(clientSessions)
  const sessions = sessionSeeds.length > 0 ? sessionSeeds : fallbackSessions
  const providers = [...new Set(sessions.map((session) => session.provider))]
  const origins = ['windows', 'wsl2']
  const models = ['gpt-5.2-codex']
  const now = Date.now()
  const fingerprint = [
    String(limit),
    ...sessions.map((session) => `${session.sessionId}:${session.provider}:${session.requests}:${session.origin}`),
  ].join('|')
  let seed = stableSeedFromText(fingerprint)
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return seed / 4294967296
  }
  const pick = <T extends { requests: number }>(rows: T[]): T => {
    const sum = rows.reduce((acc, row) => acc + Math.max(0, row.requests), 0)
    if (sum <= 0) return rows[0]
    let marker = rand() * sum
    for (const row of rows) {
      marker -= Math.max(0, row.requests)
      if (marker <= 0) return row
    }
    return rows[rows.length - 1]
  }

  const windowMs = 45 * 24 * 60 * 60 * 1000
  const rows: UsageRequestEntry[] = []
  const count = Math.max(0, limit)
  for (let i = 0; i < count; i += 1) {
    const chosenSession = pick(sessions)
    const provider = chosenSession.provider || providers[0]
    const origin = chosenSession.origin || origins[i % origins.length]
    const input = 100_000 + Math.floor(rand() * 900_000)
    const output = 1_000 + Math.floor(rand() * 9_000)
    const total = input + output
    const cacheCreate = i % 7 === 0 ? 100_000 + Math.floor(rand() * 900_000) : 0
    const cacheRead = i % 4 === 0 ? 100_000 + Math.floor(rand() * 900_000) : 0
    rows.push({
      id: `prefetch-${i}`,
      provider,
      api_key_ref: '-',
      model: models[0],
      origin,
      session_id: chosenSession.sessionId,
      unix_ms: now - Math.floor(rand() * windowMs),
      node_id: 'node-local',
      node_name: 'Local',
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
  clientSessions = [],
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
    void Promise.resolve(
      refreshUsageStatistics({
        silent: true,
        interactive: false,
        source: 'top_nav_usage_intent_prefetch',
      }),
    ).finally(() => {
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
    const useSyntheticRevision = import.meta.env.DEV || readTestFlagFromLocation()
    const requestQueryKey = useSyntheticRevision
        ? buildUsageRequestsQueryKey({
          hours: USAGE_REQUESTS_CANONICAL_FETCH_HOURS,
          fromUnixMs: null,
          toUnixMs: null,
          nodes: null,
          providers: null,
          models: null,
          origins: null,
          sessions: null,
          syntheticRevision: USAGE_REQUEST_TEST_DATA_REVISION,
        })
      : USAGE_REQUESTS_CANONICAL_QUERY_KEY
    const requestGraphQueryKey = useSyntheticRevision
      ? `${USAGE_REQUEST_GRAPH_QUERY_KEY}:${USAGE_REQUEST_TEST_DATA_REVISION}`
      : USAGE_REQUEST_GRAPH_QUERY_KEY

    void (async () => {
      try {
        const [rowsRes, dailyRes] = await Promise.all([
          invoke<{ ok: boolean; rows: UsageRequestEntry[]; has_more: boolean }>('get_usage_request_entries', {
            ...buildUsageRequestEntriesArgs({
              hours: USAGE_REQUESTS_CANONICAL_FETCH_HOURS,
              fromUnixMs: null,
              toUnixMs: null,
              nodes: null,
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
        const graphProviders = (dailyRes.providers ?? [])
          .map((row) => String(row?.provider ?? '').trim())
          .filter((provider) => provider.length > 0)
          .slice(0, 3)
        if (graphProviders.length > 0) {
          try {
            const seeded = groupRowsByProvider(rowsRes.rows ?? [], 120)
            const byProvider: Record<string, UsageRequestEntry[]> = Object.fromEntries(
              graphProviders.map((provider) => [provider, seeded[provider] ?? [] as UsageRequestEntry[]]),
            )
            const providerResults = await Promise.all(
              graphProviders.map(async (provider) => {
                try {
                  const res = await invoke<{ ok: boolean; rows: UsageRequestEntry[] }>(
                    'get_usage_request_entries',
                    buildUsageRequestEntriesArgs({
                      hours: USAGE_REQUESTS_CANONICAL_FETCH_HOURS,
                      fromUnixMs: null,
                      toUnixMs: null,
                      nodes: null,
                      providers: [provider],
                      models: null,
                      origins: null,
                      sessions: null,
                      limit: 120,
                      offset: 0,
                    }),
                  )
                  return { provider, rows: (res.rows ?? []).sort((a, b) => b.unix_ms - a.unix_ms).slice(0, 120) }
                } catch {
                  return { provider, rows: null as UsageRequestEntry[] | null }
                }
              }),
            )
            for (const item of providerResults) {
              if (!item.rows || item.rows.length === 0) continue
              byProvider[item.provider] = item.rows
            }
            primeUsageRequestGraphPrefetchCache({
              queryKey: requestGraphQueryKey,
              baseRows: rowsRes.rows ?? [],
              rowsByProvider: byProvider,
            })
          } catch {
            // Keep table prefetch even when graph prefetch fails.
          }
        }
      } catch {
        // Non-Tauri dev server (or transient backend issues): prime a lightweight synthetic cache to avoid 0->loaded flashes.
        const fallbackRows = buildSyntheticUsageRequestRows(Math.min(800, USAGE_REQUESTS_PREFETCH_LIMIT), clientSessions)
        const dailyTotals = buildDailyTotalsFromRows(fallbackRows, 45)
        primeUsageRequestsPrefetchCache({
          queryKey: requestQueryKey,
          rows: fallbackRows,
          hasMore: true,
          dailyTotals,
          usingTestFallback: true,
        })
      } finally {
        usageRequestsIntentPrefetchInFlightRef.current = false
      }
    })()
  }, [activePage, clientSessions])

  return {
    handleUsageStatisticsIntentPrefetch,
    handleUsageRequestsIntentPrefetch,
  }
}
