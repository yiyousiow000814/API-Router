import { createPortal } from 'react-dom'
import type { RefObject } from 'react'
import type { Config } from '../types'
import type { UsagePricingDraft } from '../types/usage'
import type { UsagePricingCurrencyMenuState } from './UsagePricingRow'

type Props = {
  usagePricingCurrencyMenu: UsagePricingCurrencyMenuState
  usagePricingProviderNames: string[]
  config: Config | null
  usagePricingDrafts: Record<string, UsagePricingDraft>
  buildUsagePricingDraft: (providerName: string, providerCfg?: Config['providers'][string]) => UsagePricingDraft
  usagePricingCurrencyQuery: string
  setUsagePricingCurrencyQuery: (value: string) => void
  usageCurrencyOptions: string[]
  normalizeCurrencyCode: (code: string) => string
  currencyLabel: (code: string) => string
  usagePricingCurrencyMenuRef: RefObject<HTMLDivElement | null>
  updateUsagePricingCurrency: (providerNames: string[], draft: UsagePricingDraft, nextCurrency: string) => void
  closeUsagePricingCurrencyMenu: () => void
}

export function UsagePricingCurrencyMenuPortal({
  usagePricingCurrencyMenu,
  usagePricingProviderNames,
  config,
  usagePricingDrafts,
  buildUsagePricingDraft,
  usagePricingCurrencyQuery,
  setUsagePricingCurrencyQuery,
  usageCurrencyOptions,
  normalizeCurrencyCode,
  currencyLabel,
  usagePricingCurrencyMenuRef,
  updateUsagePricingCurrency,
  closeUsagePricingCurrencyMenu,
}: Props) {
  if (!usagePricingCurrencyMenu) return null

  const providerName = usagePricingCurrencyMenu.provider
  if (!usagePricingProviderNames.includes(providerName)) return null
  const providerNames = (usagePricingCurrencyMenu.providers ?? []).filter((name) =>
    usagePricingProviderNames.includes(name),
  )
  const targets = providerNames.length ? providerNames : [providerName]
  const providerCfg = config?.providers?.[providerName]
  const draft = usagePricingDrafts[providerName] ?? buildUsagePricingDraft(providerName, providerCfg)
  const amountDisabled = !providerCfg || draft.mode === 'package_total'
  if (amountDisabled) return null

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800
  const width = Math.max(74, Math.min(130, usagePricingCurrencyMenu.width))
  const left = Math.max(8, Math.min(usagePricingCurrencyMenu.left, viewportWidth - width - 8))
  const top = usagePricingCurrencyMenu.top
  const maxHeight = Math.max(140, Math.min(260, viewportHeight - top - 8))
  const query = usagePricingCurrencyQuery.trim().toUpperCase()
  const filteredOptions = usageCurrencyOptions.filter((currencyCode) => {
    const normalized = normalizeCurrencyCode(currencyCode)
    const label = currencyLabel(normalized).toUpperCase()
    return query.length === 0 || normalized.includes(query) || label.includes(query)
  })

  return createPortal(
    <div
      ref={usagePricingCurrencyMenuRef}
      className="aoUsagePricingCurrencyMenu aoUsagePricingCurrencyMenuPortal"
      role="listbox"
      style={{ left, top, width, maxHeight }}
    >
      <div className="aoUsagePricingCurrencySearchWrap">
        <input
          className="aoInput aoUsagePricingCurrencySearch"
          placeholder="Search"
          value={usagePricingCurrencyQuery}
          onChange={(e) => setUsagePricingCurrencyQuery(e.target.value)}
        />
      </div>
      {filteredOptions.map((currencyCode) => {
        const normalized = normalizeCurrencyCode(currencyCode)
        const isActive = normalizeCurrencyCode(draft.currency) === normalized
        return (
          <button
            type="button"
            key={currencyCode}
            className={`aoUsagePricingCurrencyItem${isActive ? ' is-active' : ''}`}
            onClick={() => {
              updateUsagePricingCurrency(targets, draft, normalized)
              closeUsagePricingCurrencyMenu()
            }}
          >
            {currencyLabel(normalized)}
          </button>
        )
      })}
      {filteredOptions.length === 0 ? (
        <div className="aoHint" style={{ padding: '6px 10px 8px' }}>
          No currency
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
