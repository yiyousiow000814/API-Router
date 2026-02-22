import type { Dispatch, SetStateAction } from 'react'
import type { Config, UsageStatistics } from '../types'
import { UsageProviderStatsTable } from './UsageProviderStatsTable'

type UsageProviderRow = UsageStatistics['summary']['by_provider'][number]

export type UsageProviderDisplayGroup = {
  id: string
  rows: UsageProviderRow[]
  displayName: string
  detailLabel: string
  requests: number
  totalTokens: number
  tokensPerRequest: number | null
  estimatedAvgRequestCostUsd: number | null
  usdPerMillionTokens: number | null
  effectiveDaily: number | null
  effectiveTotal: number | null
  pricingSource: string | null
}

export type UsageProviderTotalsAndAverages = {
  totalTokPerReq: number | null
  avgUsdPerReq: number | null
  avgUsdPerMillion: number | null
  avgEstDaily: number | null
  avgTotalUsed: number | null
}

type Props = {
  config: Config | null
  setUsageHistoryModalOpen: (open: boolean) => void
  setUsagePricingModalOpen: (open: boolean) => void
  usageScheduleProviderOptions: string[]
  usageByProvider: UsageProviderRow[]
  openUsageScheduleModal: (providerName: string, currency: string) => Promise<void>
  providerPreferredCurrency: (providerName: string) => string
  setUsageProviderShowDetails: Dispatch<SetStateAction<boolean>>
  usageProviderShowDetails: boolean
  usageProviderShowDetailsStorageKey: string
  usageProviderDisplayGroups: UsageProviderDisplayGroup[]
  usageProviderRowKey: (row: UsageProviderRow) => string
  usageAnomaliesHighCostRowKeys: Set<string>
  formatUsdMaybe: (value: number | null | undefined) => string
  formatPricingSource: (source: string | null | undefined) => string
  usageProviderTotalsAndAverages: UsageProviderTotalsAndAverages | null
}

export function UsageProviderStatisticsSection({
  config,
  setUsageHistoryModalOpen,
  setUsagePricingModalOpen,
  usageScheduleProviderOptions,
  usageByProvider,
  openUsageScheduleModal,
  providerPreferredCurrency,
  setUsageProviderShowDetails,
  usageProviderShowDetails,
  usageProviderShowDetailsStorageKey,
  usageProviderDisplayGroups,
  usageProviderRowKey,
  usageAnomaliesHighCostRowKeys,
  formatUsdMaybe,
  formatPricingSource,
  usageProviderTotalsAndAverages,
}: Props) {
  return (
    <div className="aoUsageProviderCard">
      <div className="aoSwitchboardSectionHead">
        <div className="aoMiniLabel">Provider Statistics</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <div className="aoHint">Includes tok/req, $/M tokens, est/workday (16h), and selected-window total used cost.</div>
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
                  (name) => config?.providers?.[name]?.manual_pricing_mode === 'package_total',
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
          <span className="aoUsageActionsSep" aria-hidden="true">
            |
          </span>
          <button
            className="aoTinyBtn"
            onClick={() => {
              setUsageProviderShowDetails((prev) => {
                const next = !prev
                if (typeof window !== 'undefined') {
                  window.localStorage.setItem(usageProviderShowDetailsStorageKey, next ? '1' : '0')
                }
                return next
              })
            }}
          >
            {usageProviderShowDetails ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {usageByProvider.length ? (
        <UsageProviderStatsTable
          usageProviderDisplayGroups={usageProviderDisplayGroups}
          usageProviderShowDetails={usageProviderShowDetails}
          usageAnomaliesHighCostRowKeys={usageAnomaliesHighCostRowKeys}
          usageProviderRowKey={usageProviderRowKey}
          formatUsdMaybe={formatUsdMaybe}
          formatPricingSource={formatPricingSource}
          usageProviderTotalsAndAverages={usageProviderTotalsAndAverages}
        />
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
