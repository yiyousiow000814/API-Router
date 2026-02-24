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
  const asFinite = (value: number | null | undefined): number | null => {
    if (value == null || !Number.isFinite(value)) return null
    return Number(value)
  }

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
            ...(() => {
              const detailRows = new Map<
                string,
                {
                  apiKeyRef: string
                  rowKeys: string[]
                  requests: number
                  totalTokens: number
                  estimatedDaily: number | null
                  totalUsed: number | null
                  pricingSources: Set<string>
                }
              >()
              group.rows.forEach((row) => {
                const apiKeyRef = String(row.api_key_ref ?? '').trim() || '-'
                const key = apiKeyRef.toLowerCase()
                const rowKey = usageProviderRowKey(row)
                const existing = detailRows.get(key)
                const rowRequests = row.requests ?? 0
                const rowTokens = row.total_tokens ?? 0
                const rowEstimatedDaily = asFinite(row.estimated_daily_cost_usd)
                const rowTotalUsed = asFinite(row.total_used_cost_usd)
                const rowPricingSource = String(row.pricing_source ?? '').trim()
                if (existing) {
                  existing.rowKeys.push(rowKey)
                  existing.requests += rowRequests
                  existing.totalTokens += rowTokens
                  if (rowEstimatedDaily != null) {
                    existing.estimatedDaily = (existing.estimatedDaily ?? 0) + rowEstimatedDaily
                  }
                  if (rowTotalUsed != null) {
                    existing.totalUsed = (existing.totalUsed ?? 0) + rowTotalUsed
                  }
                  if (rowPricingSource) existing.pricingSources.add(rowPricingSource)
                  return
                }
                detailRows.set(key, {
                  apiKeyRef,
                  rowKeys: [rowKey],
                  requests: rowRequests,
                  totalTokens: rowTokens,
                  estimatedDaily: rowEstimatedDaily,
                  totalUsed: rowTotalUsed,
                  pricingSources: rowPricingSource ? new Set([rowPricingSource]) : new Set<string>(),
                })
              })

              return [...detailRows.values()].map((row) => {
                const rowHasAnomaly = row.rowKeys.some((rowKey) => usageAnomaliesHighCostRowKeys.has(rowKey))
                const rowTokPerReq =
                  row.requests > 0 && row.totalTokens > 0 ? row.totalTokens / row.requests : null
                const avgReqUsd =
                  row.totalUsed != null && row.requests > 0 ? row.totalUsed / row.requests : null
                const usdPerMillion =
                  row.totalUsed != null && row.totalTokens > 0 ? (row.totalUsed * 1_000_000) / row.totalTokens : null
                const pricingSource =
                  row.pricingSources.size === 0
                    ? null
                    : row.pricingSources.size === 1
                      ? [...row.pricingSources][0]
                      : 'mixed'
                return (
                  <tr key={`detail-${group.id}-${row.apiKeyRef}`} className={rowHasAnomaly ? 'aoUsageProviderRowAnomaly' : ''}>
                    <td className="aoUsageProviderDetailName" title={row.apiKeyRef}>
                      <span className="aoUsageProviderDetailKey">{row.apiKeyRef}</span>
                    </td>
                    <td>{row.requests.toLocaleString()}</td>
                    <td>{row.totalTokens.toLocaleString()}</td>
                    <td>
                      {rowTokPerReq == null || !Number.isFinite(rowTokPerReq) ? '-' : Math.round(rowTokPerReq).toLocaleString()}
                    </td>
                    <td>{formatUsdMaybe(avgReqUsd)}</td>
                    <td>{formatUsdMaybe(usdPerMillion)}</td>
                    <td>{formatUsdMaybe(row.estimatedDaily)}</td>
                    <td>{formatUsdMaybe(row.totalUsed)}</td>
                    <td>{formatPricingSource(pricingSource)}</td>
                  </tr>
                )
              })
            })(),
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
