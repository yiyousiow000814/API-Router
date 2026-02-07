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

export function fmtAgo(unixMs: number, nowMs: number = Date.now()): string {
  if (!unixMs) return '-'
  const diff = nowMs - unixMs
  if (!Number.isFinite(diff)) return '-'

  const sec = Math.max(0, Math.floor(diff / 1000))
  if (sec < 10) return 'just now'
  if (sec < 60) return `${sec}s ago`

  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`

  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`

  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`

  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`

  const yr = Math.floor(mo / 12)
  return `${yr}y ago`
}

const EPOCH_MS_THRESHOLD = 1_000_000_000_000

export function parseWhenAnyToMs(value?: string | number | null): number | null {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return value < EPOCH_MS_THRESHOLD ? value * 1000 : value
  }
  const s = String(value).trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    return n < EPOCH_MS_THRESHOLD ? n * 1000 : n
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
  if (d > 0) {
    parts.push(`${d}d`)
    parts.push(`${h}h`)
    return `Reset in ${parts.join(' ')}`
  }
  if (h > 0) {
    parts.push(`${h}h`)
    parts.push(`${m}m`)
    return `Reset in ${parts.join(' ')}`
  }
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
