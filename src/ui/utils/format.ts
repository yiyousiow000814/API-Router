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
