export type ProviderHealth = {
  status: 'unknown' | 'healthy' | 'unhealthy' | 'cooldown'
  consecutive_failures: number
  cooldown_until_unix_ms: number
  last_error: string
  last_ok_at_unix_ms: number
  last_fail_at_unix_ms: number
}

export type SpendHistoryRow = {
  provider: string
  api_key_ref?: string | null
  day_key: string
  req_count: number
  total_tokens: number
  tracked_total_usd?: number | null
  scheduled_total_usd?: number | null
  scheduled_package_total_usd?: number | null
  manual_total_usd?: number | null
  manual_usd_per_req?: number | null
  effective_total_usd?: number | null
  effective_usd_per_req?: number | null
  source?: string | null
  updated_at_unix_ms?: number
}

export type Status = {
  listen: { host: string; port: number }
  preferred_provider: string
  manual_override: string | null
  providers: Record<string, ProviderHealth>
  metrics: Record<string, { ok_requests: number; error_requests: number; total_tokens: number }>
  recent_events: Array<{
    provider: string
    level: string
    unix_ms: number
    code: string
    message: string
    fields: Record<string, unknown> | null
  }>
  client_sessions?: Array<{
    id: string
    wt_session?: string
    codex_session_id?: string | null
    reported_model_provider?: string | null
    reported_model?: string | null
    reported_base_url?: string | null
    last_seen_unix_ms: number
    active: boolean
    preferred_provider?: string | null
    verified?: boolean
    is_agent?: boolean
  }>
  active_provider?: string | null
  active_reason?: string | null
  active_provider_counts?: Record<string, number>
  quota: Record<
    string,
    {
      kind: 'none' | 'token_stats' | 'budget_info'
      updated_at_unix_ms: number
      remaining: number | null
      today_used: number | null
      today_added: number | null
      daily_spent_usd: number | null
      daily_budget_usd: number | null
      weekly_spent_usd?: number | null
      weekly_budget_usd?: number | null
      monthly_spent_usd: number | null
      monthly_budget_usd: number | null
      last_error: string
      effective_usage_base?: string | null
    }
  >
  ledgers: Record<
    string,
    {
      since_last_quota_refresh_total_tokens: number
      last_reset_unix_ms: number
    }
  >
  last_activity_unix_ms: number
  codex_account: {
    ok: boolean
    checked_at_unix_ms?: number
    signed_in?: boolean
    remaining?: string | null
    limit_5h_remaining?: string | null
    limit_weekly_remaining?: string | null
    limit_weekly_reset_at?: string | null
    code_review_remaining?: string | null
    code_review_reset_at?: string | null
    unlimited?: boolean | null
    error?: string
  }
}

export type CodexSwapStatus = {
  ok: boolean
  overall: 'original' | 'swapped' | 'mixed' | 'error'
  dirs: Array<{
    cli_home: string
    state: string
  }>
}

export type ProviderSwitchboardStatus = {
  ok: boolean
  mode: 'gateway' | 'official' | 'provider' | 'mixed'
  model_provider?: string | null
  dirs?: Array<{
    cli_home: string
    mode: string
    model_provider?: string | null
  }>
  provider_options?: string[]
}

export type Config = {
  listen: { host: string; port: number }
  routing: {
    preferred_provider: string
    session_preferred_providers?: Record<string, string>
    auto_return_to_preferred: boolean
    preferred_stable_seconds: number
    failure_threshold: number
    cooldown_seconds: number
    request_timeout_seconds: number
  }
  providers: Record<
    string,
    {
      display_name: string
      base_url: string
      usage_adapter?: string
      usage_base_url?: string | null
      manual_pricing_mode?: 'per_request' | 'package_total' | null
      manual_pricing_amount_usd?: number | null
      manual_pricing_expires_at_unix_ms?: number | null
      manual_gap_fill_mode?: 'per_request' | 'total' | 'per_day_average' | null
      manual_gap_fill_amount_usd?: number | null
      has_key: boolean
      key_preview?: string | null
      has_usage_token?: boolean
    }
  >
  provider_order?: string[]
}

export type UsageStatistics = {
  ok: boolean
  generated_at_unix_ms: number
  window_hours: number
  filter?: {
    providers?: string[] | null
    models?: string[] | null
  }
  catalog?: {
    providers: string[]
    models: string[]
  }
  bucket_seconds: number
  summary: {
    total_requests: number
    total_tokens: number
    active_window_hours?: number
    cache_creation_tokens?: number
    cache_read_tokens?: number
    unique_models: number
    estimated_total_cost_usd: number
    estimated_daily_cost_usd?: number
    by_model: Array<{
      model: string
      requests: number
      input_tokens: number
      output_tokens: number
      total_tokens: number
      share_pct: number
      estimated_total_cost_usd: number
      estimated_avg_request_cost_usd: number
      estimated_cost_request_count: number
    }>
    by_provider: Array<{
      provider: string
      api_key_ref?: string | null
      requests: number
      total_tokens: number
      tokens_per_request?: number | null
      estimated_total_cost_usd: number
      estimated_avg_request_cost_usd?: number | null
      usd_per_million_tokens?: number | null
      estimated_daily_cost_usd?: number | null
      total_used_cost_usd?: number | null
      pricing_source?: string | null
      estimated_cost_request_count: number
    }>
    timeline: Array<{
      bucket_unix_ms: number
      requests: number
      total_tokens: number
      cache_creation_tokens?: number
      cache_read_tokens?: number
    }>
  }
}
