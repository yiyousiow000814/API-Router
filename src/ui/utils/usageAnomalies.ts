type UsageTimelinePoint = {
  bucket_unix_ms: number
  requests: number
}

type UsageProviderRow = {
  provider: string
  requests?: number
  pricing_source?: string | null
  estimated_avg_request_cost_usd?: number | null
}

export function computeUsageAnomalies<T extends UsageProviderRow>(
  usageTimeline: UsageTimelinePoint[],
  usageByProvider: T[],
  windowHours: number,
  usageProviderRowKey: (row: T) => string,
  formatUsdMaybe: (value?: number | null) => string,
): { messages: string[]; highCostRowKeys: Set<string> } {
  const messages: string[] = []
  const highCostRowKeys = new Set<string>()
  const isPerRequestComparableSource = (sourceRaw?: string | null) => {
    const source = (sourceRaw ?? '').trim().toLowerCase()
    if (!source || source === 'none') return false
    return source === 'manual_per_request' || source === 'manual_per_request_timeline' || source === 'gap_fill_per_request'
  }
  const formatBucket = (unixMs: number) => {
    const d = new Date(unixMs)
    const pad = (n: number) => String(n).padStart(2, '0')
    if (windowHours <= 48) {
      return `${pad(d.getHours())}:00`
    }
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}`
  }

  const reqValues = usageTimeline
    .map((point) => point.requests ?? 0)
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
  if (reqValues.length >= 4) {
    const providerCount = Math.max(1, usageByProvider.length)
    const mid = Math.floor(reqValues.length / 2)
    const reqMedian = reqValues.length % 2 === 0 ? (reqValues[mid - 1] + reqValues[mid]) / 2 : reqValues[mid]
    const peakPoint = usageTimeline.reduce(
      (best, point) => ((point.requests ?? 0) > (best?.requests ?? 0) ? point : best),
      usageTimeline[0],
    )
    const peakReq = peakPoint?.requests ?? 0
    const medianPerProvider = reqMedian / providerCount
    const peakPerProvider = peakReq / providerCount
    if (medianPerProvider > 0 && peakPerProvider >= medianPerProvider * 5) {
      messages.push(
        `Request spike around ${formatBucket(peakPoint.bucket_unix_ms)}: ${peakPerProvider.toFixed(1)}/provider vs median ${medianPerProvider.toFixed(1)}/provider`,
      )
    }
  }

  const priced = usageByProvider.filter(
    (row) =>
      isPerRequestComparableSource(row.pricing_source) &&
      row.estimated_avg_request_cost_usd != null &&
      Number.isFinite(row.estimated_avg_request_cost_usd) &&
      (row.estimated_avg_request_cost_usd ?? 0) > 0 &&
      (row.requests ?? 0) >= 3,
  )
  const priceValues = priced.map((row) => row.estimated_avg_request_cost_usd as number).sort((a, b) => a - b)
  if (priceValues.length >= 2) {
    const mid = Math.floor(priceValues.length / 2)
    const priceMedian = priceValues.length % 2 === 0 ? (priceValues[mid - 1] + priceValues[mid]) / 2 : priceValues[mid]
    priced.forEach((row) => {
      const value = row.estimated_avg_request_cost_usd as number
      if (priceMedian > 0 && value >= priceMedian * 2 && value - priceMedian >= 0.05) {
        highCostRowKeys.add(usageProviderRowKey(row))
        messages.push(`High $/req: ${row.provider} at ${formatUsdMaybe(value)} vs median ${formatUsdMaybe(priceMedian)}`)
      }
    })
  }

  return { messages, highCostRowKeys }
}
