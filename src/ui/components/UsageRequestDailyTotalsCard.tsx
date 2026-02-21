import { useCallback, useMemo, useRef, useState } from 'react'

type DailyBarRow = {
  day: number
  providerTotals: Record<string, number>
  total: number
  showLabel: boolean
}

type Props = {
  rows: DailyBarRow[]
  providers: string[]
  colors: readonly string[]
  formatMonthDay: (unixMs: number) => string
  loading: boolean
}

export function UsageRequestDailyTotalsCard({
  rows,
  providers,
  colors,
  formatMonthDay,
  loading,
}: Props) {
  const [dailyHoverDay, setDailyHoverDay] = useState<number | null>(null)
  const [dailyHoverPos, setDailyHoverPos] = useState<{ left: number; top: number } | null>(null)
  const dailyHoverWrapRef = useRef<HTMLDivElement | null>(null)
  const dailyHoverOverlayRef = useRef<HTMLDivElement | null>(null)

  const updateDailyHoverPos = useCallback((clientX: number, clientY: number) => {
    const wrap = dailyHoverWrapRef.current
    if (!wrap) return
    const wrapRect = wrap.getBoundingClientRect()
    const overlay = dailyHoverOverlayRef.current
    const overlayWidth = overlay?.offsetWidth ?? 260
    const overlayHeight = overlay?.offsetHeight ?? 44
    const offset = 12
    const pad = 8
    const maxLeft = Math.max(pad, wrapRect.width - overlayWidth - pad)
    const maxTop = Math.max(pad, wrapRect.height - overlayHeight - pad)
    const left = Math.max(pad, Math.min(clientX - wrapRect.left + offset, maxLeft))
    const top = Math.max(pad, Math.min(clientY - wrapRect.top + offset, maxTop))
    setDailyHoverPos({ left, top })
  }, [])

  const handleDailyBarsMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      updateDailyHoverPos(event.clientX, event.clientY)
      const wrap = dailyHoverWrapRef.current
      if (!wrap) {
        setDailyHoverDay(null)
        return
      }
      const groups = wrap.querySelectorAll<HTMLElement>('.aoUsageRequestDailyBarGroup[data-day]')
      if (!groups.length) {
        setDailyHoverDay(null)
        return
      }
      let nextDay: number | null = null
      let bestDist = Number.POSITIVE_INFINITY
      for (const group of groups) {
        const dayValue = group.dataset.day
        if (!dayValue) continue
        const rect = group.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const dist = Math.abs(event.clientX - centerX)
        if (dist < bestDist) {
          const parsed = Number(dayValue)
          if (Number.isFinite(parsed)) {
            bestDist = dist
            nextDay = parsed
          }
        }
      }
      setDailyHoverDay(nextDay)
    },
    [updateDailyHoverPos],
  )

  const dailyHoverData = useMemo(() => {
    if (dailyHoverDay == null) return null
    const row = rows.find((item) => item.day === dailyHoverDay)
    if (!row) return null
    const out = providers
      .map((provider, idx) => ({
        provider,
        value: row.providerTotals[provider] ?? 0,
        color: colors[idx % colors.length],
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
    return { day: row.day, total: row.total, rows: out }
  }, [colors, dailyHoverDay, providers, rows])

  const dailyMax = useMemo(() => Math.max(1, ...rows.map((row) => row.total)), [rows])

  return (
    <div className="aoUsageRequestChartCard">
      <div className="aoSwitchboardSectionHead">
        <div className="aoMiniLabel">Daily Token Totals</div>
        <div className="aoHint">Newest 45 days from all request history (independent of table paging).</div>
      </div>
      {rows.length ? (
        <div
          ref={dailyHoverWrapRef}
          className="aoUsageRequestDailyBarsWrap"
          onMouseMove={handleDailyBarsMouseMove}
          onMouseLeave={() => {
            setDailyHoverDay(null)
            setDailyHoverPos(null)
          }}
        >
          <div className="aoUsageRequestDailyBars" role="img" aria-label="Daily token totals by selected providers">
            {rows.map((row) => (
              <div key={`request-day-${row.day}`} className="aoUsageRequestDailyBarGroup" data-day={row.day}>
                <div className="aoUsageRequestDailyBarStack">
                  {[...providers]
                    .map((provider, idx) => ({
                      provider,
                      idx,
                      value: row.providerTotals[provider] ?? 0,
                    }))
                    .filter((item) => item.value > 0)
                    .sort((a, b) => b.value - a.value)
                    .map((item) => (
                      <div
                        key={`request-day-${row.day}-${item.provider}`}
                        className="aoUsageRequestDailyBarSegment"
                        style={{
                          height: `${(item.value / dailyMax) * 100}%`,
                          background: colors[item.idx % colors.length],
                        }}
                      />
                    ))}
                </div>
                <div className={`aoUsageRequestDailyLabel${row.showLabel ? '' : ' is-hidden'}`}>
                  {row.showLabel ? <span>{formatMonthDay(row.day)}</span> : null}
                </div>
              </div>
            ))}
          </div>
          {dailyHoverData ? (
            <div
              ref={dailyHoverOverlayRef}
              className="aoUsageRequestDailyHoverOverlay"
              style={dailyHoverPos ? { left: `${dailyHoverPos.left}px`, top: `${dailyHoverPos.top}px` } : undefined}
            >
              <span>{formatMonthDay(dailyHoverData.day)} · Total {dailyHoverData.total.toLocaleString()}</span>
              {dailyHoverData.rows.map((row) => (
                <span key={`daily-hover-${row.provider}`} className="aoUsageRequestHoverSummaryItem">
                  <i style={{ background: row.color }} />
                  {row.provider}: {row.value.toLocaleString()}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="aoHint">
          {loading ? 'Loading daily totals...' : 'No daily data for selected providers.'}
        </div>
      )}
      {providers.length ? (
        <div className="aoUsageRequestLegend">
          {providers.map((provider, idx) => (
            <span key={`request-daily-legend-${provider}`} className="aoUsageRequestLegendItem">
              <i style={{ background: colors[idx % colors.length] }} />
              {provider}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
