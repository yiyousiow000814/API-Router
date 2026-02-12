import type { UsageStatistics } from '../types'
import type {
  UsageProviderDisplayGroup,
  UsageProviderTotalsAndAverages,
} from './UsageProviderStatisticsSection'

type UsageProviderRow = UsageStatistics['summary']['by_provider'][number]

type Props = {
  usageProviderDisplayGroups: UsageProviderDisplayGroup[]
  usageProviderShowDetails: boolean
  usageAnomaliesHighCostRowKeys: Set<string>
  usageProviderRowKey: (row: UsageProviderRow) => string
  formatUsdMaybe: (value: number | null | undefined) => string
  formatPricingSource: (source: string | null | undefined) => string
  usageProviderTotalsAndAverages: UsageProviderTotalsAndAverages | null
}

export function UsageProviderStatsTable({
  usageProviderDisplayGroups,
  usageProviderShowDetails,
  usageAnomaliesHighCostRowKeys,
  usageProviderRowKey,
  formatUsdMaybe,
  formatPricingSource,
  usageProviderTotalsAndAverages,
}: Props) {
  return (
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
          const hasAnomaly = group.rows.some((row) => usageAnomaliesHighCostRowKeys.has(usageProviderRowKey(row)))
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
                <td>{formatUsdMaybe(group.estimatedAvgRequestCostUsd)}</td>
                <td>{formatUsdMaybe(group.usdPerMillionTokens)}</td>
                <td>{formatUsdMaybe(group.effectiveDaily)}</td>
                <td>{formatUsdMaybe(group.effectiveTotal)}</td>
                <td>{formatPricingSource(group.pricingSource)}</td>
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
              <td>{formatUsdMaybe(group.estimatedAvgRequestCostUsd)}</td>
              <td>{formatUsdMaybe(group.usdPerMillionTokens)}</td>
              <td>{formatUsdMaybe(group.effectiveDaily)}</td>
              <td>{formatUsdMaybe(group.effectiveTotal)}</td>
              <td>{formatPricingSource(group.pricingSource)}</td>
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
            <td>{formatUsdMaybe(usageProviderTotalsAndAverages.avgUsdPerReq)}</td>
            <td>{formatUsdMaybe(usageProviderTotalsAndAverages.avgUsdPerMillion)}</td>
            <td>{formatUsdMaybe(usageProviderTotalsAndAverages.avgEstDaily)}</td>
            <td>{formatUsdMaybe(usageProviderTotalsAndAverages.avgTotalUsed)}</td>
            <td>-</td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  )
}
