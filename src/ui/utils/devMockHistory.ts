import type { SpendHistoryRow } from '../types'

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
