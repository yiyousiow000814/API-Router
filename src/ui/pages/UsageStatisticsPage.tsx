export function UsageStatisticsPage(props: any) {
  const {
    config,
    fmtKpiTokens,
    fmtPricingSource,
    fmtUsdMaybe,
    fmtUsageBucketLabel,
    fmtWhen,
    openUsageScheduleModal,
    providerPreferredCurrency,
    providerTotalUsedDisplayUsd,
    setUsageChartHover,
    setUsageFilterModels,
    setUsageFilterProviders,
    setUsageHistoryModalOpen,
    setUsagePricingModalOpen,
    setUsageWindowHours,
    showUsageChartHover,
    toggleUsageModelFilter,
    toggleUsageProviderFilter,
    usageActiveWindowHours,
    usageAnomalies,
    usageAvgRequestsPerHour,
    usageAvgTokensPerHour,
    usageAvgTokensPerRequest,
    usageByProvider,
    usageChart,
    usageChartHover,
    usageFilterModels,
    usageFilterProviders,
    usageModelFilterOptions,
    usagePricedCoveragePct,
    usagePricedRequestCount,
    usageProviderFilterOptions,
    usageProviderTotalsAndAverages,
    usageScheduleProviderOptions,
    usageStatistics,
    usageStatisticsLoading,
    usageSummary,
    usageTopModel,
    usageTotalInputTokens,
    usageTotalOutputTokens,
    usageWindowHours,
    usageWindowLabel,
  } = props

  return (
    <div className="aoCard aoUsageStatsPage">
      <div className="aoUsageStatsHeader">
        <div>
          <div className="aoPagePlaceholderTitle">Usage Statistics</div>
          <div className="aoHint">Requests, tokens, model mix, and provider-aware estimated request pricing.</div>
        </div>
        <div className="aoUsageStatsActions">
          <button
            className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 24 ? ' aoUsageWindowBtnActive' : ''}`}
            onClick={() => setUsageWindowHours(24)}
            disabled={usageStatisticsLoading}
            aria-pressed={usageWindowHours === 24}
          >
            24h
          </button>
          <button
            className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 7 * 24 ? ' aoUsageWindowBtnActive' : ''}`}
            onClick={() => setUsageWindowHours(7 * 24)}
            disabled={usageStatisticsLoading}
            aria-pressed={usageWindowHours === 7 * 24}
          >
            7d
          </button>
          <button
            className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 30 * 24 ? ' aoUsageWindowBtnActive' : ''}`}
            onClick={() => setUsageWindowHours(30 * 24)}
            disabled={usageStatisticsLoading}
            aria-pressed={usageWindowHours === 30 * 24}
          >
            1M
          </button>
        </div>
      </div>
      <div className="aoUsageFilterCard">
        <div className="aoUsageFilterSection aoUsageFilterSectionCompact">
          <div className="aoUsageFilterSectionHead">
            <span className="aoMiniLabel">Providers</span>
          </div>
          <div className="aoUsageFilterChips">
            <button
              className={`aoUsageFilterChip${usageFilterProviders.length === 0 ? ' is-active' : ''}`}
              disabled={usageStatisticsLoading}
              onClick={() => setUsageFilterProviders([])}
            >
              All providers
            </button>
            {usageProviderFilterOptions.map((providerName: string) => (
              <button
                key={providerName}
                className={`aoUsageFilterChip${usageFilterProviders.includes(providerName) ? ' is-active' : ''}`}
                disabled={usageStatisticsLoading}
                onClick={() => toggleUsageProviderFilter(providerName)}
              >
                {providerName}
              </button>
            ))}
          </div>
        </div>
        <div className="aoUsageFilterSection aoUsageFilterSectionCompact">
          <div className="aoUsageFilterSectionHead">
            <span className="aoMiniLabel">Models</span>
          </div>
          <div className="aoUsageFilterChips">
            <button
              className={`aoUsageFilterChip${usageFilterModels.length === 0 ? ' is-active' : ''}`}
              disabled={usageStatisticsLoading}
              onClick={() => setUsageFilterModels([])}
            >
              All models
            </button>
            {usageModelFilterOptions.map((modelName: string) => (
              <button
                key={modelName}
                className={`aoUsageFilterChip${usageFilterModels.includes(modelName) ? ' is-active' : ''}`}
                disabled={usageStatisticsLoading}
                onClick={() => toggleUsageModelFilter(modelName)}
              >
                {modelName}
              </button>
            ))}
          </div>
        </div>
      </div>
      {usageAnomalies.messages.length ? (
        <div className="aoUsageAnomalyBanner" role="status" aria-live="polite">
          <div className="aoMiniLabel">Anomaly Watch</div>
          {usageAnomalies.messages.map((message: string, index: number) => (
            <div key={`usage-anomaly-${index}`} className="aoUsageAnomalyText">
              {message}
            </div>
          ))}
        </div>
      ) : null}

      <div className="aoUsageKpiGrid">
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Total Requests</div>
          <div className="aoUsageKpiValue">{usageSummary?.total_requests?.toLocaleString() ?? '-'}</div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Total Tokens</div>
          <div className="aoUsageKpiValue">{fmtKpiTokens(usageSummary?.total_tokens)}</div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Top Model</div>
          <div className="aoUsageKpiValue aoUsageKpiValueSmall">
            {usageTopModel ? usageTopModel.model : '-'}
          </div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Total $ Used</div>
          <div className="aoUsageKpiValue">{fmtUsdMaybe(usageSummary?.estimated_total_cost_usd)}</div>
        </div>
      </div>
      <div className="aoUsageFactsCard">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Window Details</div>
          <div className="aoHint">Top model share is request share. Priced coverage means calculable-cost requests.</div>
        </div>
        <table className="aoUsageFactsTable">
          <tbody>
            <tr>
              <th>Top Model Share</th>
              <td>{usageTopModel ? `${Math.round(usageTopModel.share_pct ?? 0)}% of requests` : '-'}</td>
              <th>Unique Models</th>
              <td>{usageSummary?.unique_models?.toLocaleString() ?? '-'}</td>
            </tr>
            <tr>
              <th>Input / Output Tokens</th>
              <td>{usageTotalInputTokens.toLocaleString()} / {usageTotalOutputTokens.toLocaleString()}</td>
              <th>Avg Tokens / Request</th>
              <td>{usageSummary?.total_requests ? usageAvgTokensPerRequest.toLocaleString() : '-'}</td>
            </tr>
            <tr>
              <th>Window Data</th>
              <td>
                {(usageSummary?.total_requests ?? 0).toLocaleString()} captured requests
                {usageActiveWindowHours > 0 ? ` · ${usageActiveWindowHours.toFixed(1)} active h` : ''}
              </td>
              <th>Priced Coverage</th>
              <td>
                {usagePricedRequestCount.toLocaleString()} / {(usageSummary?.total_requests ?? 0).toLocaleString()} req ({usagePricedCoveragePct}%)
              </td>
            </tr>
            <tr>
              <th>Window Pace</th>
              <td>
                {usageAvgRequestsPerHour.toFixed(2)} req/h · {Math.round(usageAvgTokensPerHour).toLocaleString()} tok/h
              </td>
              <th>Selected Window</th>
              <td>{usageWindowLabel}</td>
            </tr>
            <tr>
              <th>Data Freshness</th>
              <td>{usageStatistics?.generated_at_unix_ms ? fmtWhen(usageStatistics.generated_at_unix_ms) : '-'}</td>
              <th>Sample Coverage</th>
              <td>
                {(usageSummary?.total_requests ?? 0).toLocaleString()} req · {usageActiveWindowHours.toFixed(1)} active h
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="aoUsageChartsGrid">
        <div className="aoUsageChartCard">
          <div className="aoSwitchboardSectionHead">
            <div className="aoMiniLabel">Requests Timeline</div>
            <div className="aoHint">
              {usageSummary?.total_requests ? `${usageSummary.total_requests.toLocaleString()} requests in window` : 'No request data yet'}
            </div>
          </div>
          {usageChart ? (
            <div className="aoUsageTimelineChartWrap" onMouseLeave={() => setUsageChartHover(null)}>
              <svg className="aoUsageTimelineSvg" viewBox={`0 0 ${usageChart.w} ${usageChart.h}`} preserveAspectRatio="none">
                <line
                  className="aoUsageTimelineAxis"
                  x1={26}
                  y1={usageChart.yBase}
                  x2={usageChart.w - 14}
                  y2={usageChart.yBase}
                />
                {usageChart.points.map((p: any) => (
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
                    <title>{`${fmtUsageBucketLabel(p.point.bucket_unix_ms)} | requests ${p.point.requests}`}</title>
                  </rect>
                ))}
                <path className="aoUsageTimelineLine" d={usageChart.linePath} />
                {usageChart.points.map((p: any) => (
                  <circle
                    key={`dot-${p.point.bucket_unix_ms}`}
                    className="aoUsageTimelineDot"
                    cx={p.x}
                    cy={p.tokenY}
                    r={3}
                  >
                    <title>{`${fmtUsageBucketLabel(p.point.bucket_unix_ms)} | tokens ${p.point.total_tokens.toLocaleString()}`}</title>
                  </circle>
                ))}
                {usageChart.points.map((p: any) => (
                  <rect
                    key={`hover-${p.point.bucket_unix_ms}`}
                    className="aoUsageTimelineHoverBand"
                    x={p.x - usageChart.hoverW / 2}
                    y={16}
                    width={usageChart.hoverW}
                    height={usageChart.yBase - 16}
                    onMouseMove={(event) =>
                      showUsageChartHover(
                        event,
                        p.point.bucket_unix_ms,
                        p.point.requests,
                        p.point.total_tokens,
                      )
                    }
                  />
                ))}
              </svg>
              {usageChartHover ? (
                <div
                  className="aoUsageTooltip"
                  style={{ left: `${usageChartHover.x}px`, top: `${usageChartHover.y}px` }}
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
                {usageChart.tickIndexes.map((index: number) => {
                  const p = usageChart.points[index]
                  return (
                    <span key={`tick-${p.point.bucket_unix_ms}`}>{fmtUsageBucketLabel(p.point.bucket_unix_ms)}</span>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="aoHint">No requests have gone through the gateway in this time window.</div>
          )}
        </div>

      </div>

      <div className="aoUsageProviderCard">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Provider Statistics</div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <div className="aoHint">
              Includes tok/req, $/M tokens, est/day, and selected-window total used cost.
              </div>
            <button className="aoTinyBtn" onClick={() => setUsageHistoryModalOpen(true)}>
              Daily History
            </button>
            <button className="aoTinyBtn" onClick={() => setUsagePricingModalOpen(true)}>
              Base Pricing
            </button>
            <button
              className="aoTinyBtn"
              onClick={() => {
                const providerName =
                  usageScheduleProviderOptions.find(
                    (name: string) => config?.providers?.[name]?.manual_pricing_mode === 'package_total',
                  ) ??
                  usageScheduleProviderOptions[0] ??
                  usageByProvider[0]?.provider
                if (!providerName) return
                void openUsageScheduleModal(providerName, providerPreferredCurrency(providerName))
              }}
              disabled={!usageScheduleProviderOptions.length}
            >
              Pricing Timeline
            </button>
          </div>
        </div>
        {usageByProvider.length ? (
          <table className="aoUsageProviderTable">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Req</th>
                <th>Tokens</th>
                <th>tok/req</th>
                <th>$ / req</th>
                <th>$ / M tok</th>
                <th>Est $ / day</th>
                <th>Total $ Used</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {usageByProvider.map((p: any) => (
                <tr
                  key={p.provider}
                  className={usageAnomalies.highCostProviders.has(p.provider) ? 'aoUsageProviderRowAnomaly' : ''}
                >
                  <td className="aoUsageProviderName">{p.provider}</td>
                  <td>{p.requests.toLocaleString()}</td>
                  <td>{p.total_tokens.toLocaleString()}</td>
                  <td>
                    {p.tokens_per_request == null || !Number.isFinite(p.tokens_per_request)
                      ? '-'
                      : Math.round(p.tokens_per_request).toLocaleString()}
                  </td>
                  <td>{fmtUsdMaybe(p.estimated_avg_request_cost_usd)}</td>
                  <td>{fmtUsdMaybe(p.usd_per_million_tokens)}</td>
                  <td>{fmtUsdMaybe(p.estimated_daily_cost_usd)}</td>
                  <td>{fmtUsdMaybe(providerTotalUsedDisplayUsd(p))}</td>
                  <td>{fmtPricingSource(p.pricing_source)}</td>
                </tr>
              ))}
            </tbody>
            {usageProviderTotalsAndAverages ? (
              <tfoot>
                <tr className="aoUsageProviderAvgRow">
                  <td className="aoUsageProviderName">Average</td>
                  <td>-</td>
                  <td>-</td>
                  <td>
                    {usageProviderTotalsAndAverages.totalTokPerReq == null
                      ? '-'
                      : Math.round(usageProviderTotalsAndAverages.totalTokPerReq).toLocaleString()}
                  </td>
                  <td>{fmtUsdMaybe(usageProviderTotalsAndAverages.avgUsdPerReq)}</td>
                  <td>{fmtUsdMaybe(usageProviderTotalsAndAverages.avgUsdPerMillion)}</td>
                  <td>{fmtUsdMaybe(usageProviderTotalsAndAverages.avgEstDaily)}</td>
                  <td>{fmtUsdMaybe(usageProviderTotalsAndAverages.avgTotalUsed)}</td>
                  <td>-</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        ) : (
          <div className="aoHint">No provider usage data yet.</div>
        )}
        <div className="aoHint">
          Open Base Pricing for current mode, Pricing Timeline for historical periods, and Daily History for
          day-level fixes.
        </div>
      </div>
    </div>
  )
}
