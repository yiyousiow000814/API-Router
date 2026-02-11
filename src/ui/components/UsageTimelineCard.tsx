type UsageTimelinePoint = {
  point: {
    bucket_unix_ms: number
    requests: number
    total_tokens: number
  }
  x: number
  barY: number
  reqH: number
  tokenY: number
}

type UsageTimelineChartData = {
  w: number
  h: number
  yBase: number
  barW: number
  hoverW: number
  linePath: string
  points: UsageTimelinePoint[]
  tickIndexes: number[]
}

type UsageChartHover = {
  x: number
  y: number
  title: string
  subtitle: string
}

type Props = {
  usageChart: UsageTimelineChartData | null
  usageChartHover: UsageChartHover | null
  usageSummaryTotalRequests: number
  onClearHover: () => void
  onPointHover: (
    event: MouseEvent<SVGRectElement>,
    bucketUnixMs: number,
    requests: number,
    totalTokens: number,
  ) => void
  fmtUsageBucketLabel: (bucketUnixMs: number) => string
}

export function UsageTimelineCard({
  usageChart,
  usageChartHover,
  usageSummaryTotalRequests,
  onClearHover,
  onPointHover,
  fmtUsageBucketLabel,
}: Props) {
  return (
    <div className="aoUsageChartsGrid">
      <div className="aoUsageChartCard">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Requests Timeline</div>
          <div className="aoHint">
            {usageSummaryTotalRequests
              ? `${usageSummaryTotalRequests.toLocaleString()} requests in window`
              : 'No request data yet'}
          </div>
        </div>
        {usageChart ? (
          <div className="aoUsageTimelineChartWrap" onMouseLeave={onClearHover}>
            <svg
              className="aoUsageTimelineSvg"
              viewBox={`0 0 ${usageChart.w} ${usageChart.h}`}
              preserveAspectRatio="none"
            >
              <line
                className="aoUsageTimelineAxis"
                x1={26}
                y1={usageChart.yBase}
                x2={usageChart.w - 14}
                y2={usageChart.yBase}
              />
              {usageChart.points.map((point) => (
                <rect
                  key={`bar-${point.point.bucket_unix_ms}`}
                  className="aoUsageTimelineBarRect"
                  x={point.x - usageChart.barW / 2}
                  y={point.barY}
                  width={usageChart.barW}
                  height={point.reqH}
                  rx={4}
                  ry={4}
                >
                  <title>{`${fmtUsageBucketLabel(point.point.bucket_unix_ms)} | requests ${point.point.requests}`}</title>
                </rect>
              ))}
              <path className="aoUsageTimelineLine" d={usageChart.linePath} />
              {usageChart.points.map((point) => (
                <circle
                  key={`dot-${point.point.bucket_unix_ms}`}
                  className="aoUsageTimelineDot"
                  cx={point.x}
                  cy={point.tokenY}
                  r={3}
                >
                  <title>{`${fmtUsageBucketLabel(point.point.bucket_unix_ms)} | tokens ${point.point.total_tokens.toLocaleString()}`}</title>
                </circle>
              ))}
              {usageChart.points.map((point) => (
                <rect
                  key={`hover-${point.point.bucket_unix_ms}`}
                  className="aoUsageTimelineHoverBand"
                  x={point.x - usageChart.hoverW / 2}
                  y={16}
                  width={usageChart.hoverW}
                  height={usageChart.yBase - 16}
                  onMouseMove={(event) =>
                    onPointHover(
                      event,
                      point.point.bucket_unix_ms,
                      point.point.requests,
                      point.point.total_tokens,
                    )
                  }
                />
              ))}
            </svg>
            {usageChartHover ? (
              <div className="aoUsageTooltip" style={{ left: `${usageChartHover.x}px`, top: `${usageChartHover.y}px` }}>
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
                const point = usageChart.points[index]
                return <span key={`tick-${point.point.bucket_unix_ms}`}>{fmtUsageBucketLabel(point.point.bucket_unix_ms)}</span>
              })}
            </div>
          </div>
        ) : (
          <div className="aoHint">No requests have gone through the gateway in this time window.</div>
        )}
      </div>
    </div>
  )
}
import type { MouseEvent } from 'react'
