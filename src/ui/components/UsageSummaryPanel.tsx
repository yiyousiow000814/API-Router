type UsageSummary = {
  total_requests?: number
  total_tokens?: number
  unique_models?: number
}

type UsageTopModel = {
  model: string
  share_pct?: number | null
}

type Props = {
  usageWindowHours: number
  usageStatisticsLoading: boolean
  usageFilterProviders: string[]
  usageProviderFilterOptions: string[]
  usageFilterModels: string[]
  usageModelFilterOptions: string[]
  usageAnomalyMessages: string[]
  usageSummary: UsageSummary | null
  usageTopModel: UsageTopModel | null
  usageDedupedTotalUsedUsd: number | null
  usageTotalInputTokens: number
  usageTotalOutputTokens: number
  usageAvgTokensPerRequest: number
  usageActiveWindowHours: number
  usagePricedRequestCount: number
  usagePricedCoveragePct: number
  usageAvgRequestsPerHour: number
  usageAvgTokensPerHour: number
  usageWindowLabel: string
  usageGeneratedAtUnixMs?: number
  onSetWindowHours: (hours: number) => void
  onSetFilterProviders: (providers: string[]) => void
  onToggleProviderFilter: (providerName: string) => void
  onSetFilterModels: (models: string[]) => void
  onToggleModelFilter: (modelName: string) => void
  fmtKpiTokens: (value: number | null | undefined) => string
  fmtUsdMaybe: (value: number | null | undefined) => string
  fmtWhen: (unixMs: number) => string
}

export function UsageSummaryPanel({
  usageWindowHours,
  usageStatisticsLoading,
  usageFilterProviders,
  usageProviderFilterOptions,
  usageFilterModels,
  usageModelFilterOptions,
  usageAnomalyMessages,
  usageSummary,
  usageTopModel,
  usageDedupedTotalUsedUsd,
  usageTotalInputTokens,
  usageTotalOutputTokens,
  usageAvgTokensPerRequest,
  usageActiveWindowHours,
  usagePricedRequestCount,
  usagePricedCoveragePct,
  usageAvgRequestsPerHour,
  usageAvgTokensPerHour,
  usageWindowLabel,
  usageGeneratedAtUnixMs,
  onSetWindowHours,
  onSetFilterProviders,
  onToggleProviderFilter,
  onSetFilterModels,
  onToggleModelFilter,
  fmtKpiTokens,
  fmtUsdMaybe,
  fmtWhen,
}: Props) {
  return (
    <>
      <div className="aoUsageStatsHeader">
        <div>
          <div className="aoPagePlaceholderTitle">Usage Statistics</div>
          <div className="aoHint">Requests, tokens, model mix, and provider-aware estimated request pricing.</div>
        </div>
        <div className="aoUsageStatsActions">
          <button
            className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 24 ? ' aoUsageWindowBtnActive' : ''}`}
            onClick={() => onSetWindowHours(24)}
            disabled={usageStatisticsLoading}
            aria-pressed={usageWindowHours === 24}
          >
            24h
          </button>
          <button
            className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 7 * 24 ? ' aoUsageWindowBtnActive' : ''}`}
            onClick={() => onSetWindowHours(7 * 24)}
            disabled={usageStatisticsLoading}
            aria-pressed={usageWindowHours === 7 * 24}
          >
            7d
          </button>
          <button
            className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 30 * 24 ? ' aoUsageWindowBtnActive' : ''}`}
            onClick={() => onSetWindowHours(30 * 24)}
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
              onClick={() => onSetFilterProviders([])}
            >
              All providers
            </button>
            {usageProviderFilterOptions.map((providerName) => (
              <button
                key={providerName}
                className={`aoUsageFilterChip${usageFilterProviders.includes(providerName) ? ' is-active' : ''}`}
                disabled={usageStatisticsLoading}
                onClick={() => onToggleProviderFilter(providerName)}
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
              onClick={() => onSetFilterModels([])}
            >
              All models
            </button>
            {usageModelFilterOptions.map((modelName) => (
              <button
                key={modelName}
                className={`aoUsageFilterChip${usageFilterModels.includes(modelName) ? ' is-active' : ''}`}
                disabled={usageStatisticsLoading}
                onClick={() => onToggleModelFilter(modelName)}
              >
                {modelName}
              </button>
            ))}
          </div>
        </div>
      </div>
      {usageAnomalyMessages.length ? (
        <div className="aoUsageAnomalyBanner" role="status" aria-live="polite">
          <div className="aoMiniLabel">Anomaly Watch</div>
          {usageAnomalyMessages.map((message, index) => (
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
          <div className="aoUsageKpiValue aoUsageKpiValueSmall">{usageTopModel ? usageTopModel.model : '-'}</div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Total $ Used</div>
          <div className="aoUsageKpiValue">{fmtUsdMaybe(usageDedupedTotalUsedUsd)}</div>
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
              <td>{usageGeneratedAtUnixMs ? fmtWhen(usageGeneratedAtUnixMs) : '-'}</td>
              <th>Sample Coverage</th>
              <td>
                {(usageSummary?.total_requests ?? 0).toLocaleString()} req · {usageActiveWindowHours.toFixed(1)} active h
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}
