type UsageTimelinePoint = {
  bucket_unix_ms: number
  requests: number
  total_tokens: number
}

export function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    const c1x = p1.x + (p2.x - p0.x) / 6
    const yMin = Math.min(p1.y, p2.y)
    const yMax = Math.max(p1.y, p2.y)
    const c1y = clamp(p1.y + (p2.y - p0.y) / 6, yMin, yMax)
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = clamp(p2.y - (p3.y - p1.y) / 6, yMin, yMax)
    path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`
  }
  return path
}

export function buildUsageChartModel(
  usageTimeline: UsageTimelinePoint[],
  usageMaxTimelineRequests: number,
  usageMaxTimelineTokens: number,
) {
  if (!usageTimeline.length) return null
  const w = 1000
  const h = 220
  const padL = 26
  const padR = 14
  const padT = 16
  const padB = 34
  const plotW = w - padL - padR
  const plotH = h - padT - padB
  const n = usageTimeline.length
  const step = n > 1 ? plotW / (n - 1) : 0
  const barW = Math.max(8, Math.min(24, Math.floor((plotW / Math.max(n, 1)) * 0.55)))
  const hoverW = n > 1 ? Math.max(12, step) : Math.max(24, barW * 2)
  const yBase = padT + plotH
  const points = usageTimeline.map((point, index) => {
    const x = padL + (n === 1 ? plotW / 2 : index * step)
    const reqH = Math.max(2, Math.round((point.requests / usageMaxTimelineRequests) * plotH))
    const barY = yBase - reqH
    const tokenY = yBase - Math.round((point.total_tokens / usageMaxTimelineTokens) * plotH)
    return { point, x, barY, reqH, tokenY }
  })
  const linePath = buildSmoothPath(points.map((p) => ({ x: p.x, y: p.tokenY })))
  const tickIndexes = Array.from(new Set([0, Math.floor((n - 1) / 2), n - 1]))
  return {
    w,
    h,
    yBase,
    points,
    linePath,
    tickIndexes,
    barW,
    hoverW,
  }
}

export function fmtUsdMaybe(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '-'
  return `$${value >= 10 ? value.toFixed(2) : value.toFixed(3)}`
}

export function fmtKpiTokens(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '-'
  if (value >= 1_000_000_000_000) {
    const compact = value / 1_000_000_000_000
    const rounded = compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)
    return rounded.replace(/\.0$/, '') + 'T'
  }
  if (value >= 1_000_000_000) {
    const compact = value / 1_000_000_000
    const rounded = compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)
    return rounded.replace(/\.0$/, '') + 'B'
  }
  if (value >= 10_000_000) {
    const compact = value / 1_000_000
    const rounded = compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)
    return rounded.replace(/\.0$/, '') + 'M'
  }
  return Math.round(value).toLocaleString()
}

export function fmtPricingSource(source?: string | null): string {
  if (!source || source === 'none') return 'unconfigured'
  if (source === 'token_rate') return 'monthly credit'
  if (source === 'provider_budget_api') return 'monthly credit'
  if (source === 'provider_budget_api+manual_history') return 'monthly credit'
  if (source === 'provider_budget_api_latest_day') return 'monthly credit'
  if (source === 'provider_token_rate') return 'monthly credit'
  if (source === 'manual_per_request') return 'manual'
  if (source === 'manual_per_request_timeline') return 'manual'
  if (source === 'manual_package_total') return 'manual package total'
  if (source === 'manual_package_timeline') return 'scheduled'
  if (source === 'manual_package_timeline+manual_history') return 'scheduled + manual'
  if (source === 'manual_history') return 'history manual'
  if (source === 'gap_fill_per_request') return 'gap fill $/req'
  if (source === 'gap_fill_total') return 'gap fill total'
  if (source === 'gap_fill_per_day_average') return 'gap fill $/day'
  return source
}

export function fmtUsageBucketLabel(unixMs: number, windowHours: number): string {
  const d = new Date(unixMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (windowHours <= 48) {
    return `${pad(d.getHours())}:00`
  }
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}`
}
