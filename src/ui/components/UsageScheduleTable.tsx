import type { Dispatch, SetStateAction } from 'react'
import type { Config } from '../types'
import type {
  PricingTimelineMode,
  ProviderScheduleDraft,
  UsagePricingMode,
  UsageScheduleSaveState,
} from '../types/usage'
import type { UsageScheduleCurrencyMenuState } from './UsageScheduleCurrencyMenuPortal'

type UsageScheduleTableProps = {
  usageScheduleLoading: boolean
  usageScheduleRows: ProviderScheduleDraft[]
  providerDisplayName: (provider: string) => string
  providerApiKeyLabel: (provider: string) => string
  usageScheduleCurrencyMenu: UsageScheduleCurrencyMenuState
  setUsageScheduleCurrencyMenu: Dispatch<SetStateAction<UsageScheduleCurrencyMenuState>>
  setUsageScheduleCurrencyQuery: Dispatch<SetStateAction<string>>
  currencyLabel: (currencyCode: string) => string
  normalizeCurrencyCode: (currencyCode: string) => string
  setUsageScheduleSaveState: Dispatch<SetStateAction<UsageScheduleSaveState>>
  setUsageScheduleRows: Dispatch<SetStateAction<ProviderScheduleDraft[]>>
  usageScheduleProviderOptions: string[]
  usageScheduleProvider: string
  parsePositiveAmount: (value: string) => number | null
  providerPreferredCurrency: (providerName: string) => string
  config: Config | null
  fxRatesByCurrency: Record<string, number>
  convertCurrencyToUsd: (fxRatesByCurrency: Record<string, number>, amount: number, currencyCode: string) => number | null
  linkedProvidersForApiKey: (apiKeyRef: string, providerName: string) => string[]
  newScheduleDraft: (
    providerName: string,
    seedAmountUsd: number | null,
    seedCurrency: string,
    seedMode: PricingTimelineMode,
    linkedProviders: string[],
  ) => ProviderScheduleDraft
  usageScheduleSaveState: UsageScheduleSaveState
  usageScheduleSaveStatusText: string
}

export function UsageScheduleTable({
  usageScheduleLoading,
  usageScheduleRows,
  providerDisplayName,
  providerApiKeyLabel,
  usageScheduleCurrencyMenu,
  setUsageScheduleCurrencyMenu,
  setUsageScheduleCurrencyQuery,
  currencyLabel,
  normalizeCurrencyCode,
  setUsageScheduleSaveState,
  setUsageScheduleRows,
  usageScheduleProviderOptions,
  usageScheduleProvider,
  parsePositiveAmount,
  providerPreferredCurrency,
  config,
  fxRatesByCurrency,
  convertCurrencyToUsd,
  linkedProvidersForApiKey,
  newScheduleDraft,
  usageScheduleSaveState,
  usageScheduleSaveStatusText,
}: UsageScheduleTableProps) {
  if (usageScheduleLoading) {
    return <div className="aoHint">Loading...</div>
  }

  return (
    <>
      <table className="aoUsageScheduleTable">
        <colgroup>
          <col className="aoUsageScheduleColProvider" />
          <col className="aoUsageScheduleColApiKey" />
          <col className="aoUsageScheduleColMode" />
          <col className="aoUsageScheduleColStart" />
          <col className="aoUsageScheduleColExpires" />
          <col className="aoUsageScheduleColAmount" />
          <col className="aoUsageScheduleColCurrency" />
          <col className="aoUsageScheduleColAction" />
        </colgroup>
        <thead>
          <tr>
            <th>Provider</th>
            <th>API Key</th>
            <th>Mode</th>
            <th>Start</th>
            <th>Expires</th>
            <th>Amount</th>
            <th>Currency</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {usageScheduleRows
            .map((row, index) => ({ row, index }))
            .sort(
              (a, b) =>
                a.row.provider.localeCompare(b.row.provider) ||
                a.row.startText.localeCompare(b.row.startText) ||
                a.row.endText.localeCompare(b.row.endText),
            )
            .map(({ row, index }) => (
              <tr key={`${row.provider}-${row.id || 'new'}-${index}`}>
                <td>{providerDisplayName(row.provider)}</td>
                <td>{row.apiKeyRef || providerApiKeyLabel(row.provider)}</td>
                <td>
                  <select
                    className="aoSelect aoUsageScheduleMode"
                    value={row.mode}
                    onChange={(e) => {
                      const nextMode = (e.target.value as PricingTimelineMode) ?? 'package_total'
                      setUsageScheduleSaveState('idle')
                      setUsageScheduleRows((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, mode: nextMode } : item)),
                      )
                    }}
                  >
                    <option value="package_total">Monthly fee</option>
                    <option value="per_request">$ / request</option>
                  </select>
                </td>
                <td>
                  <input
                    className="aoInput aoUsageScheduleInput"
                    type="datetime-local"
                    value={row.startText}
                    onChange={(e) => {
                      setUsageScheduleSaveState('idle')
                      setUsageScheduleRows((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, startText: e.target.value } : item)),
                      )
                    }}
                  />
                </td>
                <td>
                  <input
                    className="aoInput aoUsageScheduleInput"
                    type="datetime-local"
                    value={row.endText}
                    onChange={(e) => {
                      setUsageScheduleSaveState('idle')
                      setUsageScheduleRows((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, endText: e.target.value } : item)),
                      )
                    }}
                  />
                </td>
                <td>
                  <input
                    className="aoInput aoUsageScheduleAmount"
                    type="number"
                    min="0"
                    step="0.001"
                    placeholder="0"
                    value={row.amountText}
                    onChange={(e) => {
                      setUsageScheduleSaveState('idle')
                      setUsageScheduleRows((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, amountText: e.target.value } : item)),
                      )
                    }}
                  />
                </td>
                <td>
                  <div className="aoUsageScheduleCurrencyWrap">
                    <button
                      type="button"
                      className="aoSelect aoUsageScheduleCurrencyBtn"
                      aria-haspopup="listbox"
                      aria-expanded={usageScheduleCurrencyMenu?.rowIndex === index}
                      onClick={(e) => {
                        const button = e.currentTarget
                        const rect = button.getBoundingClientRect()
                        setUsageScheduleCurrencyMenu((prev) => {
                          if (prev?.rowIndex === index) {
                            setUsageScheduleCurrencyQuery('')
                            return null
                          }
                          setUsageScheduleCurrencyQuery('')
                          return {
                            rowIndex: index,
                            left: Math.max(8, Math.round(rect.left)),
                            top: Math.round(rect.bottom + 4),
                            width: Math.round(rect.width),
                          }
                        })
                      }}
                    >
                      <span>{currencyLabel(normalizeCurrencyCode(row.currency))}</span>
                      <span className="aoUsagePricingCurrencyChevron" aria-hidden="true">
                        ▼
                      </span>
                    </button>
                  </div>
                </td>
                <td>
                  <button
                    className="aoTinyBtn"
                    onClick={() => {
                      setUsageScheduleSaveState('idle')
                      setUsageScheduleRows((prev) => prev.filter((_, i) => i !== index))
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          {usageScheduleRows.length === 0 ? (
            <tr>
              <td colSpan={8}>
                <div className="aoHint">No scheduled periods yet. Click Add Period to create one.</div>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="aoUsageScheduleActions">
        <button
          className="aoTinyBtn"
          onClick={() => {
            setUsageScheduleSaveState('idle')
            const targetProvider = usageScheduleProviderOptions.includes(usageScheduleProvider)
              ? usageScheduleProvider
              : usageScheduleProviderOptions[0] ?? usageScheduleProvider
            if (!targetProvider) return
            setUsageScheduleRows((prev) => {
              const providerRows = prev.filter((item) => item.provider === targetProvider)
              const last = providerRows[providerRows.length - 1]
              const lastAmount = parsePositiveAmount(last?.amountText ?? '')
              const lastCurrency = last?.currency
              const fallbackCurrency = lastCurrency ?? providerPreferredCurrency(targetProvider)
              const providerAmountUsd = config?.providers?.[targetProvider]?.manual_pricing_amount_usd ?? null
              const seedAmountUsd =
                lastAmount != null
                  ? convertCurrencyToUsd(fxRatesByCurrency, lastAmount, fallbackCurrency)
                  : providerAmountUsd
              const providerMode =
                (config?.providers?.[targetProvider]?.manual_pricing_mode ?? 'package_total') as UsagePricingMode
              const seedMode: PricingTimelineMode =
                providerMode === 'per_request' ? 'per_request' : 'package_total'
              const linkedProviders = linkedProvidersForApiKey(providerApiKeyLabel(targetProvider), targetProvider)
              return [
                ...prev,
                newScheduleDraft(targetProvider, seedAmountUsd, fallbackCurrency, seedMode, linkedProviders),
              ]
            })
          }}
        >
          Add Period
        </button>
        <span className={`aoHint aoUsageScheduleAutosave aoUsageScheduleAutosave-${usageScheduleSaveState}`}>
          {usageScheduleSaveStatusText}
        </span>
      </div>
      <div className="aoHint aoUsageScheduleHint">
        Timeline rows are the source for historical base pricing. Editing here updates only listed rows.
      </div>
    </>
  )
}
