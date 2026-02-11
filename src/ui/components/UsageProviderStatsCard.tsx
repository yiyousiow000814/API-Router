import type { UsageStatistics } from '../types'

type UsageProviderRow = UsageStatistics['summary']['by_provider'][number]

type UsageProviderDisplayGroup = {
  id: string
  displayName: string
  detailLabel: string
  rows: UsageProviderRow[]
  requests: number
  totalTokens: number
  tokensPerRequest: number | null
  estimatedAvgRequestCostUsd: number | null
  usdPerMillionTokens: number | null
  effectiveDaily: number | null
  effectiveTotal: number | null
  pricingSource: string | null
}

type UsageProviderTotalsAndAverages = {
  totalTokPerReq: number | null
  avgUsdPerReq: number | null
  avgUsdPerMillion: number | null
  avgEstDaily: number | null
  avgTotalUsed: number | null
}

type Props = {
  usageByProviderLength: number
  usageProviderDisplayGroups: UsageProviderDisplayGroup[]
  usageProviderShowDetails: boolean
  usageAnomalyRowKeys: Set<string>
  usageProviderTotalsAndAverages: UsageProviderTotalsAndAverages | null
  usageScheduleProviderOptionsLength: number
  onOpenHistory: () => void
  onOpenPricing: () => void
  onOpenSchedule: () => void
  onToggleDetails: () => void
  usageProviderRowKey: (row: UsageProviderRow) => string
  fmtUsdMaybe: (value: number | null | undefined) => string
  fmtPricingSource: (source: string | null | undefined) => string
}

export function UsageProviderStatsCard({
  usageByProviderLength,
  usageProviderDisplayGroups,
  usageProviderShowDetails,
  usageAnomalyRowKeys,
  usageProviderTotalsAndAverages,
  usageScheduleProviderOptionsLength,
  onOpenHistory,
  onOpenPricing,
  onOpenSchedule,
  onToggleDetails,
  usageProviderRowKey,
  fmtUsdMaybe,
  fmtPricingSource,
}: Props) {
  return (
    <div className="aoUsageProviderCard">
      <div className="aoSwitchboardSectionHead">
        <div className="aoMiniLabel">Provider Statistics</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <div className="aoHint">Includes tok/req, $/M tokens, est/day, and selected-window total used cost.</div>
          <button className="aoTinyBtn" onClick={onOpenHistory}>
            Daily History
          </button>
          <button className="aoTinyBtn" onClick={onOpenPricing}>
            Base Pricing
          </button>
          <button className="aoTinyBtn" onClick={onOpenSchedule} disabled={!usageScheduleProviderOptionsLength}>
            Pricing Timeline
          </button>
          <span className="aoUsageActionsSep" aria-hidden="true">
            |
          </span>
          <button className="aoTinyBtn" onClick={onToggleDetails}>
            {usageProviderShowDetails ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {usageByProviderLength ? (
        <table className="aoUsageProviderTable">
          <colgroup>
            <col className="aoUsageProviderColProv" />
            <col className="aoUsageProviderColReq" />
            <col className="aoUsageProviderColTok" />
            <col className="aoUsageProviderColTokReq" />
            <col className="aoUsageProviderColReqUsd" />
            <col className="aoUsageProviderColMilUsd" />
            <col className="aoUsageProviderColDay" />
            <col className="aoUsageProviderColTotal" />
            <col className="aoUsageProviderColSrc" />
          </colgroup>
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
            {usageProviderDisplayGroups.flatMap((group) => {
              const hasAnomaly = group.rows.some((row) => usageAnomalyRowKeys.has(usageProviderRowKey(row)))
              if (!usageProviderShowDetails) {
                return [
                  <tr key={`summary-${group.id}`} className={hasAnomaly ? 'aoUsageProviderRowAnomaly' : ''}>
                    <td className="aoUsageProviderName">{group.displayName}</td>
                    <td>{group.requests.toLocaleString()}</td>
                    <td>{group.totalTokens.toLocaleString()}</td>
                    <td>
                      {group.tokensPerRequest == null || !Number.isFinite(group.tokensPerRequest)
                        ? '-'
                        : Math.round(group.tokensPerRequest).toLocaleString()}
                    </td>
                    <td>{fmtUsdMaybe(group.estimatedAvgRequestCostUsd)}</td>
                    <td>{fmtUsdMaybe(group.usdPerMillionTokens)}</td>
                    <td>{fmtUsdMaybe(group.effectiveDaily)}</td>
                    <td>{fmtUsdMaybe(group.effectiveTotal)}</td>
                    <td>{fmtPricingSource(group.pricingSource)}</td>
                  </tr>,
                ]
              }
              return [
                <tr key={`group-${group.id}`} className="aoUsageProviderGroupRow">
                  <td colSpan={9} className="aoUsageProviderName">
                    {group.displayName}
                  </td>
                </tr>,
                <tr key={`detail-${group.id}`} className={hasAnomaly ? 'aoUsageProviderRowAnomaly' : ''}>
                  <td className="aoUsageProviderName aoUsageProviderDetailName" title={group.detailLabel}>
                    <span className="aoUsageProviderDetailText">{group.detailLabel}</span>
                  </td>
                  <td>{group.requests.toLocaleString()}</td>
                  <td>{group.totalTokens.toLocaleString()}</td>
                  <td>
                    {group.tokensPerRequest == null || !Number.isFinite(group.tokensPerRequest)
                      ? '-'
                      : Math.round(group.tokensPerRequest).toLocaleString()}
                  </td>
                  <td>{fmtUsdMaybe(group.estimatedAvgRequestCostUsd)}</td>
                  <td>{fmtUsdMaybe(group.usdPerMillionTokens)}</td>
                  <td>{fmtUsdMaybe(group.effectiveDaily)}</td>
                  <td>{fmtUsdMaybe(group.effectiveTotal)}</td>
                  <td>{fmtPricingSource(group.pricingSource)}</td>
                </tr>,
              ]
            })}
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
        Open Base Pricing for current mode, Pricing Timeline for historical periods, and Daily History for day-level
        fixes.
      </div>
    </div>
  )
}
