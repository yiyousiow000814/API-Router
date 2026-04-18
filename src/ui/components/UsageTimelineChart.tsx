import { memo, useCallback, useState } from "react"

export type UsageChartPoint = {
  x: number
  barY: number
  reqH: number
  tokenY: number
  point: {
    bucket_unix_ms: number
    requests: number
    total_tokens: number
  }
}

export type UsageChartModel = {
  w: number
  h: number
  yBase: number
  barW: number
  hoverW: number
  linePath: string
  points: UsageChartPoint[]
  tickIndexes: number[]
}

export type UsageChartHover = {
  x: number
  y: number
  title: string
  subtitle: string
}

type Props = {
  usageChart: UsageChartModel | null
  usageWindowHours: number
  formatUsageBucketLabel: (bucketUnixMs: number, windowHours: number) => string
}

export const UsageTimelineChart = memo(function UsageTimelineChart({
  usageChart,
  usageWindowHours,
  formatUsageBucketLabel,
}: Props) {
  const [usageChartHover, setUsageChartHover] = useState<UsageChartHover | null>(null)

  const showUsageChartHover = useCallback(
    (
      event: {
        clientX: number
        clientY: number
        currentTarget: { ownerSVGElement?: SVGSVGElement | null }
      },
      bucketUnixMs: number,
      requests: number,
      totalTokens: number,
    ) => {
      const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
      if (!rect) return
      const rawX = event.clientX - rect.left
      const rawY = event.clientY - rect.top
      const maxX = Math.max(8, rect.width - 176)
      const maxY = Math.max(8, rect.height - 54)
      setUsageChartHover({
        x: Math.min(Math.max(rawX + 10, 8), maxX),
        y: Math.min(Math.max(rawY - 42, 8), maxY),
        title: formatUsageBucketLabel(bucketUnixMs, usageWindowHours),
        subtitle: `Requests ${requests} | Tokens ${totalTokens.toLocaleString()}`,
      })
    },
    [formatUsageBucketLabel, usageWindowHours],
  )

  if (!usageChart) {
    return <div className="aoHint">No requests have gone through the gateway in this time window.</div>
  }

  return (
    <div className="aoUsageTimelineChartWrap" onMouseLeave={() => setUsageChartHover(null)}>
      <svg className="aoUsageTimelineSvg" viewBox={`0 0 ${usageChart.w} ${usageChart.h}`} preserveAspectRatio="none">
        <line className="aoUsageTimelineAxis" x1={26} y1={usageChart.yBase} x2={usageChart.w - 14} y2={usageChart.yBase} />
        {usageChart.points.map((p) => (
          <rect
            key={`bar-${p.point.bucket_unix_ms}`}
            className="aoUsageTimelineBarRect"
            x={p.x - usageChart.barW / 2}
            y={p.barY}
            width={usageChart.barW}
            height={p.reqH}
            rx={4}
            ry={4}
          >
            <title>{`${formatUsageBucketLabel(p.point.bucket_unix_ms, usageWindowHours)} | requests ${p.point.requests}`}</title>
          </rect>
        ))}
        <path className="aoUsageTimelineLine" d={usageChart.linePath} />
        {usageChart.points.map((p) => (
          <circle key={`dot-${p.point.bucket_unix_ms}`} className="aoUsageTimelineDot" cx={p.x} cy={p.tokenY} r={3}>
            <title>{`${formatUsageBucketLabel(p.point.bucket_unix_ms, usageWindowHours)} | tokens ${p.point.total_tokens.toLocaleString()}`}</title>
          </circle>
        ))}
        {usageChart.points.map((p) => (
          <rect
            key={`hover-${p.point.bucket_unix_ms}`}
            className="aoUsageTimelineHoverBand"
            x={p.x - usageChart.hoverW / 2}
            y={16}
            width={usageChart.hoverW}
            height={usageChart.yBase - 16}
            onMouseMove={(event) => showUsageChartHover(event, p.point.bucket_unix_ms, p.point.requests, p.point.total_tokens)}
          />
        ))}
      </svg>
      {usageChartHover ? (
        <div
          className="aoUsageTooltip"
          style={{ transform: `translate(${usageChartHover.x}px, ${usageChartHover.y}px)` }}
        >
          <div className="aoUsageTooltipTitle">{usageChartHover.title}</div>
          <div className="aoUsageTooltipSub">{usageChartHover.subtitle}</div>
        </div>
      ) : null}
      <div className="aoUsageTimelineLegend">
        <span className="aoUsageLegendItem aoUsageLegendBars">Bars: Requests</span>
        <span className="aoUsageLegendItem aoUsageLegendLine">Line: Tokens</span>
      </div>
      <div className="aoUsageTimelineTicks">
        {usageChart.tickIndexes.map((index) => {
          const p = usageChart.points[index]
          return (
            <span key={`tick-${p.point.bucket_unix_ms}`}>
              {formatUsageBucketLabel(p.point.bucket_unix_ms, usageWindowHours)}
            </span>
          )
        })}
      </div>
    </div>
  )
})
