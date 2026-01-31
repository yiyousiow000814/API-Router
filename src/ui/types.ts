export type ProviderHealth = {
  status: 'unknown' | 'healthy' | 'unhealthy' | 'cooldown'
  consecutive_failures: number
  cooldown_until_unix_ms: number
  last_error: string
  last_ok_at_unix_ms: number
  last_fail_at_unix_ms: number
}

export type Status = {
  listen: { host: string; port: number }
  preferred_provider: string
  manual_override: string | null
  providers: Record<string, ProviderHealth>
  metrics: Record<string, { ok_requests: number; error_requests: number; total_tokens: number }>
  recent_events: Array<{ provider: string; level: string; unix_ms: number; message: string }>
  active_provider?: string | null
  active_reason?: string | null
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
    code_review_remaining?: string | null
    unlimited?: boolean | null
    error?: string
  }
}

export type Config = {
  listen: { host: string; port: number }
  routing: {
    preferred_provider: string
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
      has_key: boolean
      key_preview?: string | null
      has_usage_token?: boolean
    }
  >
  provider_order?: string[]
}
