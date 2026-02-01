export function fmtWhen(unixMs: number): string {
  if (!unixMs) return '-'
  const d = new Date(unixMs)
  // day-month-year, per repo conventions.
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${dd}-${mm}-${yyyy} ${hh}:${min}:${ss}`
}

export function fmtWhenAny(value?: string | number | null): string {
  if (value == null) return '-'
  if (typeof value === 'number') return fmtWhen(value)

  const s = String(value).trim()
  if (!s) return '-'

  // Numeric timestamps: accept seconds/ms.
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n)) return '-'
    const ms = n < 2_000_000_000 ? n * 1000 : n
    return fmtWhen(ms)
  }

  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return '-'
  return fmtWhen(ms)
}

export function parseWhenAnyToMs(value?: string | number | null): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const s = String(value).trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    return n < 2_000_000_000 ? n * 1000 : n
  }
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : null
}

export function fmtResetIn(resetAt?: string | number | null, nowMs: number = Date.now()): string | null {
  const ms = parseWhenAnyToMs(resetAt)
  if (ms == null) return null
  let diff = ms - nowMs
  if (!Number.isFinite(diff)) return null
  if (diff <= 0) return 'Reset soon'

  const dayMs = 24 * 60 * 60 * 1000
  const hourMs = 60 * 60 * 1000
  const minMs = 60 * 1000

  const d = Math.floor(diff / dayMs)
  diff -= d * dayMs
  const h = Math.floor(diff / hourMs)
  diff -= h * hourMs
  const m = Math.floor(diff / minMs)

  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0 || d > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return `Reset in ${parts.join(' ')}`
}

export function pctOf(part?: number | null, total?: number | null): number | null {
  if (part == null || total == null) return null
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null
  const pct = (part / total) * 100
  if (!Number.isFinite(pct)) return null
  return Math.max(0, Math.min(100, pct))
}

export function fmtPct(pct: number | null): string {
  if (pct == null) return '-'
  const v = pct < 1 ? 0 : Math.floor(pct)
  return `${v}%`
}

export function fmtAmount(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString()
}

export function fmtUsd(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const trimmed = Math.round(value * 1000) / 1000
  return trimmed.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 })
}

export function parsePct(value?: string | null): string | null {
  if (!value) return null
  const match = String(value).match(/(\d+(?:\.\d+)?)\s*%/)
  if (!match) return null
  const num = Math.max(0, Math.min(100, Number(match[1])))
  if (!Number.isFinite(num)) return null
  return `${Math.floor(num)}%`
}
