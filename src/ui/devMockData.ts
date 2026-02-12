import type { Config, Status } from './types'

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

export const devStatus: Status = {
  listen: { host: '127.0.0.1', port: 4000 },
  preferred_provider: 'provider_1',
  manual_override: null,
  providers: {
    provider_1: {
      status: 'healthy',
      consecutive_failures: 0,
      cooldown_until_unix_ms: 0,
      last_error: '',
      last_ok_at_unix_ms: Date.now() - 120000,
      last_fail_at_unix_ms: 0,
    },
    provider_2: {
      status: 'unknown',
      consecutive_failures: 1,
      cooldown_until_unix_ms: Date.now() + 300000,
      last_error: 'endpoint not found',
      last_ok_at_unix_ms: Date.now() - 3600000,
      last_fail_at_unix_ms: Date.now() - 240000,
    },
  },
  metrics: {
    provider_1: { ok_requests: 210, error_requests: 3, total_tokens: 128400 },
    provider_2: { ok_requests: 12, error_requests: 2, total_tokens: 3400 },
  },
  recent_events: [],
  active_provider: null,
  active_reason: null,
  quota: {
    provider_1: {
      kind: 'token_stats',
      updated_at_unix_ms: Date.now() - 90000,
      remaining: 8320,
      today_used: 2680,
      today_added: 11000,
      daily_spent_usd: null,
      daily_budget_usd: null,
      weekly_spent_usd: null,
      weekly_budget_usd: null,
      monthly_spent_usd: null,
      monthly_budget_usd: null,
      last_error: '',
      effective_usage_base: null,
    },
    provider_2: {
      kind: 'budget_info',
      updated_at_unix_ms: Date.now() - 420000,
      remaining: null,
      today_used: null,
      today_added: null,
      daily_spent_usd: 1.4,
      daily_budget_usd: 5,
      weekly_spent_usd: null,
      weekly_budget_usd: null,
      monthly_spent_usd: 12.3,
      monthly_budget_usd: 40,
      last_error: '',
      effective_usage_base: null,
    },
  },
  ledgers: {},
  last_activity_unix_ms: Date.now() - 30000,
  codex_account: {
    ok: true,
    checked_at_unix_ms: Date.now() - 90000,
    signed_in: true,
    remaining: '13%',
    limit_5h_remaining: '87%',
    limit_weekly_remaining: '13%',
    limit_weekly_reset_at: String(Date.now() + 3 * 24 * 60 * 60 * 1000),
    code_review_remaining: '92%',
    code_review_reset_at: String(Date.now() + 24 * 60 * 60 * 1000),
    unlimited: false,
  },
}

export const devConfig: Config = {
  listen: { host: '127.0.0.1', port: 4000 },
  routing: {
    preferred_provider: 'provider_1',
    auto_return_to_preferred: true,
    preferred_stable_seconds: 120,
    failure_threshold: 2,
    cooldown_seconds: 120,
    request_timeout_seconds: 120,
  },
  providers: {
    provider_1: {
      display_name: 'provider_1',
      base_url: 'https://code.ppchat.vip/v1',
      usage_adapter: 'ppchat',
      usage_base_url: 'https://code.ppchat.vip',
      has_key: true,
      key_preview: 'sk-pp********c61',
      has_usage_token: false,
    },
    provider_2: {
      display_name: 'provider_2',
      base_url: 'https://codex-api.packycode.com/v1',
      usage_adapter: 'packycode',
      usage_base_url: 'https://codex-api.packycode.com',
      has_key: true,
      key_preview: 'sk-pk********mN5',
      has_usage_token: true,
    },
  },
  provider_order: ['provider_1', 'provider_2'],
}

const DEV_MOCK_DAY_MS = 24 * 60 * 60 * 1000

function toDayKey(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 10)
}

export function parseDevFlag(v: string | null): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export function buildDevMockHistoryRows(days = 90): SpendHistoryRow[] {
  const now = Date.now()
  const providers = [
    {
      provider: 'packycode',
      api_key_ref: 'sk-tPN******hxNs',
      req_base: 1200,
      token_base: 128_000_000,
      usd_per_req: 0.037,
      package_usd: null as number | null,
    },
    {
      provider: 'ppchat',
      api_key_ref: 'sk-DWB******HD6I',
      req_base: 14,
      token_base: 1_020_000,
      usd_per_req: 0.16,
      package_usd: 56.1,
    },
    {
      provider: 'pumpkinai',
      api_key_ref: 'sk-DWB******HD6I',
      req_base: 4,
      token_base: 560_000,
      usd_per_req: 0.62,
      package_usd: 56.1,
    },
  ]

  const out: SpendHistoryRow[] = []
  for (let d = 0; d < days; d += 1) {
    const dayMs = now - d * DEV_MOCK_DAY_MS
    const day_key = toDayKey(dayMs)
    for (let i = 0; i < providers.length; i += 1) {
      const p = providers[i]
      if (p.provider !== 'packycode' && d % 3 !== 0) continue
      if (p.provider === 'pumpkinai' && d % 5 !== 0) continue

      const factor = 0.6 + (((d * 17 + i * 11) % 41) / 100)
      const req_count = Math.max(1, Math.round(p.req_base * factor))
      const total_tokens = Math.max(1, Math.round(p.token_base * factor))
      const tracked_total_usd = Number((req_count * p.usd_per_req).toFixed(3))

      let scheduled_total_usd: number | null = null
      let scheduled_package_total_usd: number | null = null
      let manual_total_usd: number | null = null
      let manual_usd_per_req: number | null = null
      let source = 'tracked'

      if (p.package_usd != null && d % 6 === 0) {
        scheduled_total_usd = Number((p.package_usd * 0.028).toFixed(3))
        scheduled_package_total_usd = p.package_usd
        source = 'scheduled'
      }

      if (d % 11 === 0 && p.provider === 'packycode') {
        manual_total_usd = Number((tracked_total_usd * 0.08).toFixed(3))
        source = 'manual'
      }

      if (d % 14 === 0 && p.provider !== 'packycode') {
        manual_usd_per_req = Number((p.usd_per_req * 0.95).toFixed(4))
        source = scheduled_total_usd != null ? 'manual+scheduled' : 'manual'
      }

      const effective_total_usd = Number(
        (
          tracked_total_usd +
          (scheduled_total_usd ?? 0) +
          (manual_total_usd ?? 0) +
          (manual_usd_per_req != null ? manual_usd_per_req * req_count : 0)
        ).toFixed(3),
      )

      out.push({
        provider: p.provider,
        api_key_ref: p.api_key_ref,
        day_key,
        req_count,
        total_tokens,
        tracked_total_usd,
        scheduled_total_usd,
        scheduled_package_total_usd,
        manual_total_usd,
        manual_usd_per_req,
        effective_total_usd,
        effective_usd_per_req: req_count > 0 ? Number((effective_total_usd / req_count).toFixed(4)) : null,
        source,
        updated_at_unix_ms: dayMs + (i + 1) * 7_200_000,
      })
    }
  }
  return out
}
