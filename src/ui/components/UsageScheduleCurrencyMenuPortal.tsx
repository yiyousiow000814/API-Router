import type { Dispatch, RefObject, SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderScheduleDraft } from '../types/usage'

type UsageScheduleCurrencyMenuPosition = {
  rowIndex: number
  left: number
  top: number
  width: number
}

export type UsageScheduleCurrencyMenuState = UsageScheduleCurrencyMenuPosition | null

type UsageScheduleCurrencyMenuPortalProps = {
  usageScheduleCurrencyMenu: UsageScheduleCurrencyMenuState
  usageScheduleRows: ProviderScheduleDraft[]
  usageScheduleCurrencyMenuRef: RefObject<HTMLDivElement | null>
  usageScheduleCurrencyQuery: string
  setUsageScheduleCurrencyQuery: Dispatch<SetStateAction<string>>
  usageCurrencyOptions: string[]
  currencyLabel: (currencyCode: string) => string
  normalizeCurrencyCode: (currencyCode: string) => string
  updateUsageScheduleCurrency: (rowIndex: number, currencyCode: string) => void
  closeUsageScheduleCurrencyMenu: () => void
}

export function UsageScheduleCurrencyMenuPortal({
  usageScheduleCurrencyMenu,
  usageScheduleRows,
  usageScheduleCurrencyMenuRef,
  usageScheduleCurrencyQuery,
  setUsageScheduleCurrencyQuery,
  usageCurrencyOptions,
  currencyLabel,
  normalizeCurrencyCode,
  updateUsageScheduleCurrency,
  closeUsageScheduleCurrencyMenu,
}: UsageScheduleCurrencyMenuPortalProps) {
  if (!usageScheduleCurrencyMenu) return null

  return createPortal(
    (() => {
      const row = usageScheduleRows[usageScheduleCurrencyMenu.rowIndex]
      if (!row) return null
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
      const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800
      const width = Math.max(86, Math.min(132, usageScheduleCurrencyMenu.width))
      const left = Math.max(8, Math.min(usageScheduleCurrencyMenu.left, viewportWidth - width - 8))
      const menuHeight = 260
      const belowSpace = viewportHeight - usageScheduleCurrencyMenu.top - 8
      const top =
        belowSpace >= 180
          ? usageScheduleCurrencyMenu.top
          : Math.max(8, usageScheduleCurrencyMenu.top - menuHeight - 36)
      const maxHeight = Math.max(140, Math.min(menuHeight, viewportHeight - top - 8))
      const query = usageScheduleCurrencyQuery.trim().toUpperCase()
      const filteredOptions = usageCurrencyOptions.filter((currencyCode) => {
        const normalized = normalizeCurrencyCode(currencyCode)
        const label = currencyLabel(normalized).toUpperCase()
        return query.length === 0 || normalized.includes(query) || label.includes(query)
      })

      return (
        <div
          ref={usageScheduleCurrencyMenuRef}
          className="aoUsagePricingCurrencyMenu aoUsagePricingCurrencyMenuPortal"
          role="listbox"
          style={{ left, top, width, maxHeight }}
        >
          <div className="aoUsagePricingCurrencySearchWrap">
            <input
              className="aoInput aoUsagePricingCurrencySearch"
              placeholder="Search"
              value={usageScheduleCurrencyQuery}
              onChange={(e) => setUsageScheduleCurrencyQuery(e.target.value)}
              autoFocus
            />
          </div>
          {filteredOptions.map((currencyCode) => {
            const normalized = normalizeCurrencyCode(currencyCode)
            const isActive = normalizeCurrencyCode(row.currency) === normalized
            return (
              <button
                type="button"
                key={currencyCode}
                className={`aoUsagePricingCurrencyItem${isActive ? ' is-active' : ''}`}
                onClick={() => {
                  updateUsageScheduleCurrency(usageScheduleCurrencyMenu.rowIndex, normalized)
                  closeUsageScheduleCurrencyMenu()
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
        </div>
      )
    })(),
    document.body,
  )
}