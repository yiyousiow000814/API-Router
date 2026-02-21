import { invoke } from '@tauri-apps/api/core'
import { useCallback, useRef } from 'react'
import { primeUsageRequestsPrefetchCache } from '../components/UsageStatisticsPanel'

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
    const requestQueryKey = JSON.stringify({
      hours: USAGE_REQUESTS_PREFETCH_HOURS,
      providers: [],
      models: [],
      origins: [],
    })
    void Promise.all([
      invoke<{
        ok: boolean
        rows: Array<{
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
        }>
        has_more: boolean
      }>('get_usage_request_entries', {
        hours: USAGE_REQUESTS_PREFETCH_HOURS,
        limit: USAGE_REQUESTS_PREFETCH_LIMIT,
        offset: 0,
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
      .then(([rowsRes, dailyRes]) => {
        primeUsageRequestsPrefetchCache({
          queryKey: requestQueryKey,
          rows: rowsRes.rows ?? [],
          hasMore: Boolean(rowsRes.has_more),
          dailyTotals: {
            days: dailyRes.days ?? [],
            providers: dailyRes.providers ?? [],
          },
        })
      })
      .finally(() => {
        usageRequestsIntentPrefetchInFlightRef.current = false
      })
  }, [activePage])

  return {
    handleUsageStatisticsIntentPrefetch,
    handleUsageRequestsIntentPrefetch,
  }
}
