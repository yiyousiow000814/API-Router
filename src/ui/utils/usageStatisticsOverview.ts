import type {
  UsageProviderStatisticsRow,
  UsageStatistics,
  UsageStatisticsOverview,
  UsageTimelinePoint,
} from '../types'

function cloneProviderRows(
  rows: UsageProviderStatisticsRow[] | undefined,
): UsageProviderStatisticsRow[] {
  return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : []
}

function cloneTimelineRows(rows: UsageTimelinePoint[] | undefined): UsageTimelinePoint[] {
  return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : []
}

export function buildUsageStatisticsOverviewFromFull(
  stats: UsageStatistics | null | undefined,
): UsageStatisticsOverview | null {
  if (!stats) return null
  return {
    ok: stats.ok,
    generated_at_unix_ms: stats.generated_at_unix_ms,
    window_hours: stats.window_hours,
    bucket_seconds: stats.bucket_seconds,
    summary: {
      total_requests: stats.summary.total_requests,
      total_tokens: stats.summary.total_tokens,
      input_tokens: stats.summary.input_tokens,
      output_tokens: stats.summary.output_tokens,
      active_window_hours: stats.summary.active_window_hours,
      cache_creation_tokens: stats.summary.cache_creation_tokens,
      cache_read_tokens: stats.summary.cache_read_tokens,
      unique_models: stats.summary.unique_models,
      top_model: stats.summary.top_model ? { ...stats.summary.top_model } : null,
      estimated_total_cost_usd: stats.summary.estimated_total_cost_usd,
      estimated_daily_cost_usd: stats.summary.estimated_daily_cost_usd,
      by_provider: cloneProviderRows(stats.summary.by_provider),
      timeline: cloneTimelineRows(stats.summary.timeline),
    },
  }
}
