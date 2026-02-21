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

const DEV_NOW = Date.now()

function buildDevRecentEvents(count = 200): NonNullable<Status['recent_events']> {
  const providers = ['provider_1', 'provider_2', 'provider_3']
  const mockSessions = [
    { codex: '019c4578-0f3c-7f82-a4f9-b41a1e65e242', wt: 'wt-8f42f1' },
    { codex: '019c03fd-6ea4-7121-961f-9f9b64d2c1b5', wt: '7c757b99-7a1f-455a-b301-3e0271e7f615' },
    { codex: '019c7f46-c5ec-7e2e-9205-4e00718a524e', wt: 'wsl:4504a762-cce0-40c8-ba5e-310424165b01' },
    { codex: '019c9f18-3d72-7ce3-a9a1-2fd7f4d9d100', wt: '3f9d88a2-5f14-4f8e-a3be-214eb4f6c2b1' },
    { codex: '019c9f18-89aa-7b11-bc42-6fbe3dc89002', wt: 'wsl:1c9a4f93-3214-4ef5-b6d4-0f6e6e1af991' },
  ]
  const out: NonNullable<Status['recent_events']> = []
  let dayOffset = 0
  while (out.length < count) {
    // Realistic daily variance (some quiet days, some busy days), not fixed per day.
    const daySeed = (dayOffset * 37 + 11) % 100
    const dayCount = 2 + ((daySeed * 7 + dayOffset * 3) % 13) // 2..14 events/day
    const dayProfile = (dayOffset * 19 + 7) % 100

    for (let slot = 0; slot < dayCount && out.length < count; slot += 1) {
      const idx = out.length
      const levelRoll = (dayOffset * 41 + slot * 23 + 17) % 100
      const infoThreshold = dayProfile < 12 ? 74 : dayProfile < 65 ? 84 : 91
      const warningThreshold = dayProfile < 12 ? 95 : dayProfile < 65 ? 96 : 98
      const level: 'info' | 'warning' | 'error' =
        levelRoll < infoThreshold ? 'info' : levelRoll < warningThreshold ? 'warning' : 'error'
      const provider = providers[(dayOffset + slot + (level === 'error' ? 1 : 0)) % providers.length]
      const session = mockSessions[(dayOffset + slot * 2) % mockSessions.length]
      const intraDaySeconds = 120 + ((slot * 97 + dayOffset * 29) % (22 * 60 * 60))
      const secAgo = dayOffset * 24 * 60 * 60 + intraDaySeconds
      const unix_ms = DEV_NOW - secAgo * 1000

      if (level === 'info') {
        out.push({
          provider,
          level,
          unix_ms,
          code: 'routing.selected',
          message:
            idx % 2 === 0
              ? `Selected ${provider} (healthy, preferred). Health probe passed and latency stayed within target.`
              : `Selected ${provider} (fallback). Preferred provider cooldown is active, traffic routed to backup.`,
          fields: {
            reason: idx % 2 === 0 ? 'preferred_provider' : 'failover',
            latency_ms: 95 + (idx % 35),
            codex_session_id: session.codex,
            wt_session: session.wt,
            pid: 3400 + (idx % 7),
          },
        })
        continue
      }

      if (level === 'warning') {
        out.push({
          provider,
          level,
          unix_ms,
          code: 'quota.low',
          message: `${provider} quota is getting low. Remaining daily budget may not cover current request rate.`,
          fields: {
            remaining_percent: Math.max(1, 35 - (idx % 30)),
            codex_session_id: session.codex,
            wt_session: session.wt,
          },
        })
        continue
      }

      out.push({
        provider,
        level,
        unix_ms,
        code: 'upstream.timeout',
        message: `stream read error (request timed out); completed=false; forwarded_bytes=0; upstream_status=200 OK; url=https://api.example.com/v1/responses; content_type=text/event-stream; content_encoding=(none); transfer_encoding=chunked; automatic failover executed from ${provider} to backup provider and this request may have increased end-to-end latency.`,
        fields: {
          timeout_seconds: 120,
          retryable: true,
          session_id: session.codex,
          wt_session: session.wt,
        },
      })
    }
    dayOffset += 1
  }

  return out
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
      last_ok_at_unix_ms: DEV_NOW - 120000,
      last_fail_at_unix_ms: 0,
    },
    provider_2: {
      status: 'closed',
      consecutive_failures: 0,
      cooldown_until_unix_ms: 0,
      last_error: '',
      last_ok_at_unix_ms: DEV_NOW - 3600000,
      last_fail_at_unix_ms: 0,
    },
    provider_3: {
      status: 'healthy',
      consecutive_failures: 0,
      cooldown_until_unix_ms: 0,
      last_error: '',
      last_ok_at_unix_ms: DEV_NOW - 240000,
      last_fail_at_unix_ms: 0,
    },
  },
  metrics: {
    provider_1: { ok_requests: 210, error_requests: 3, total_tokens: 128400 },
    provider_2: { ok_requests: 12, error_requests: 2, total_tokens: 3400 },
    provider_3: { ok_requests: 98, error_requests: 1, total_tokens: 56400 },
  },
  recent_events: buildDevRecentEvents(520),
  client_sessions: [
    {
      id: '019c4578-0f3c-7f82-a4f9-b41a1e65e242',
      wt_session: 'wt-8f42f1',
      codex_session_id: '019c4578-0f3c-7f82-a4f9-b41a1e65e242',
      reported_model_provider: 'provider_1',
      reported_model: 'gpt-5.2',
      reported_base_url: 'https://code.ppchat.vip/v1',
      last_seen_unix_ms: DEV_NOW - 6000,
      active: true,
      preferred_provider: 'provider_1',
      current_provider: 'provider_1',
      current_reason: 'preferred_healthy',
      verified: true,
      is_agent: false,
    },
    {
      id: '019c03fd-6ea4-7121-961f-9f9b64d2c1b5',
      wt_session: '7c757b99-7a1f-455a-b301-3e0271e7f615',
      codex_session_id: '019c03fd-6ea4-7121-961f-9f9b64d2c1b5',
      reported_model_provider: 'api_router',
      reported_model: 'gpt-5.3-codex',
      reported_base_url: 'http://172.26.144.1:4000/v1',
      last_seen_unix_ms: DEV_NOW - 12000,
      active: true,
      preferred_provider: null,
      current_provider: 'provider_1',
      current_reason: 'preferred_healthy',
      verified: true,
      is_agent: false,
    },
    {
      id: '019c7f46-c5ec-7e2e-9205-4e00718a524e',
      wt_session: 'wsl:4504a762-cce0-40c8-ba5e-310424165b01',
      codex_session_id: '019c7f46-c5ec-7e2e-9205-4e00718a524e',
      reported_model_provider: 'api_router',
      reported_model: null,
      reported_base_url: 'http://172.26.144.1:4000/v1',
      last_seen_unix_ms: DEV_NOW - 28000,
      active: false,
      preferred_provider: null,
      current_provider: null,
      current_reason: null,
      verified: true,
      is_agent: false,
    },
    {
      id: '019c600a-56f3-77b2-8465-f64a4f0566ec',
      wt_session: 'e60f8534-f300-4415-8669-dbebf9008271',
      codex_session_id: '019c600a-56f3-77b2-8465-f64a4f0566ec',
      reported_model_provider: 'api_router',
      reported_model: null,
      reported_base_url: null,
      last_seen_unix_ms: DEV_NOW - 42000,
      active: false,
      preferred_provider: null,
      current_provider: null,
      current_reason: null,
      verified: false,
      is_agent: false,
    },
    {
      id: '019c7f4d-b7a5-7add-b7f9-f41049dbe667',
      wt_session: 'wsl:6f8d5f2a-9d35-4f36-a0c7-5b5b8f0b84aa',
      codex_session_id: '019c7f4d-b7a5-7add-b7f9-f41049dbe667',
      reported_model_provider: 'api_router',
      reported_model: null,
      reported_base_url: null,
      last_seen_unix_ms: DEV_NOW - 51000,
      active: false,
      preferred_provider: null,
      current_provider: null,
      current_reason: null,
      verified: false,
      is_agent: false,
    },
    {
      id: '019c9f18-3d72-7ce3-a9a1-2fd7f4d9d100',
      wt_session: '3f9d88a2-5f14-4f8e-a3be-214eb4f6c2b1',
      codex_session_id: '019c9f18-3d72-7ce3-a9a1-2fd7f4d9d100',
      reported_model_provider: 'api_router',
      reported_model: 'gpt-5.2',
      reported_base_url: 'http://127.0.0.1:4000/v1',
      last_seen_unix_ms: DEV_NOW - 9000,
      active: true,
      preferred_provider: null,
      current_provider: 'provider_2',
      current_reason: 'preferred_unhealthy',
      verified: true,
      is_agent: true,
      is_review: true,
    },
    {
      id: '019c9f18-89aa-7b11-bc42-6fbe3dc89002',
      wt_session: 'wsl:1c9a4f93-3214-4ef5-b6d4-0f6e6e1af991',
      codex_session_id: '019c9f18-89aa-7b11-bc42-6fbe3dc89002',
      reported_model_provider: 'api_router',
      reported_model: 'gpt-5.2',
      reported_base_url: 'http://172.26.144.1:4000/v1',
      last_seen_unix_ms: DEV_NOW - 7000,
      active: true,
      preferred_provider: null,
      current_provider: 'provider_2',
      current_reason: 'preferred_unhealthy',
      verified: true,
      is_agent: true,
      is_review: true,
    },
  ],
  active_provider: null,
  active_reason: null,
  quota: {
    provider_1: {
      kind: 'token_stats',
      updated_at_unix_ms: DEV_NOW - 90000,
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
      updated_at_unix_ms: DEV_NOW - 420000,
      remaining: null,
      today_used: null,
      today_added: null,
      daily_spent_usd: 5.8,
      daily_budget_usd: 5,
      weekly_spent_usd: 51.2,
      weekly_budget_usd: 40,
      monthly_spent_usd: 12.3,
      monthly_budget_usd: 40,
      last_error: '',
      effective_usage_base: null,
    },
    provider_3: {
      kind: 'token_stats',
      updated_at_unix_ms: DEV_NOW - 150000,
      remaining: 4210,
      today_used: 1890,
      today_added: 6100,
      daily_spent_usd: null,
      daily_budget_usd: null,
      weekly_spent_usd: null,
      weekly_budget_usd: null,
      monthly_spent_usd: null,
      monthly_budget_usd: null,
      last_error: '',
      effective_usage_base: null,
    },
  },
  ledgers: {},
  last_activity_unix_ms: DEV_NOW - 30000,
  codex_account: {
    ok: true,
    checked_at_unix_ms: DEV_NOW - 90000,
    signed_in: true,
    remaining: '13%',
    limit_5h_remaining: '87%',
    limit_weekly_remaining: '13%',
    limit_weekly_reset_at: String(DEV_NOW + 3 * 24 * 60 * 60 * 1000),
    code_review_remaining: '92%',
    code_review_reset_at: String(DEV_NOW + 24 * 60 * 60 * 1000),
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
    provider_3: {
      display_name: 'provider_3',
      base_url: 'https://code.pumpkinai.vip/v1',
      usage_adapter: 'pumpkinai',
      usage_base_url: 'https://code.pumpkinai.vip',
      has_key: true,
      key_preview: 'sk-pu********x7Q',
      has_usage_token: false,
    },
  },
  provider_order: ['provider_1', 'provider_2', 'provider_3'],
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
