import { createPortal } from 'react-dom'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { PricingTimelineMode, ProviderScheduleDraft, UsageScheduleSaveState } from '../appTypes'
import { ModalBackdrop } from './ModalBackdrop'

type CurrencyMenuState = {
  rowIndex: number
  left: number
  top: number
  width: number
}

type Props = {
  open: boolean
  loading: boolean
  rows: ProviderScheduleDraft[]
  provider: string
  providerOptions: string[]
  saveState: UsageScheduleSaveState
  saveStatusText: string
  currencyMenu: CurrencyMenuState | null
  currencyMenuRef: MutableRefObject<HTMLDivElement | null>
  currencyQuery: string
  setCurrencyQuery: Dispatch<SetStateAction<string>>
  usageCurrencyOptions: string[]
  setRows: Dispatch<SetStateAction<ProviderScheduleDraft[]>>
  setSaveState: Dispatch<SetStateAction<UsageScheduleSaveState>>
  setSaveError: Dispatch<SetStateAction<string>>
  closeCurrencyMenu: () => void
  clearAutoSaveTimer: (key: string) => void
  setOpen: (next: boolean) => void
  providerDisplayName: (provider: string) => string
  providerApiKeyLabel: (provider: string) => string
  normalizeCurrencyCode: (code: string) => string
  currencyLabel: (code: string) => string
  updateCurrency: (rowIndex: number, currency: string) => void
  setCurrencyMenu: Dispatch<SetStateAction<CurrencyMenuState | null>>
  onAddPeriod: () => void
}

export function UsageScheduleModal({
  open,
  loading,
  rows,
  provider,
  providerOptions,
  saveState,
  saveStatusText,
  currencyMenu,
  currencyMenuRef,
  currencyQuery,
  setCurrencyQuery,
  usageCurrencyOptions,
  setRows,
  setSaveState,
  setSaveError,
  closeCurrencyMenu,
  clearAutoSaveTimer,
  setOpen,
  providerDisplayName,
  providerApiKeyLabel,
  normalizeCurrencyCode,
  currencyLabel,
  updateCurrency,
  setCurrencyMenu,
  onAddPeriod,
}: Props) {
  if (!open) return null
  return (
    <ModalBackdrop
      className="aoModalBackdrop aoModalBackdropTop"
      onClose={() => {
        closeCurrencyMenu()
        clearAutoSaveTimer('schedule:rows')
        setSaveState('idle')
        setSaveError('')
        setOpen(false)
      }}
    >
      <div className="aoModal aoModalWide aoUsageScheduleModal" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Pricing Timeline</div>
            <div className="aoModalSub">
              Edit base pricing timeline rows (monthly fee or $/request) with explicit start/expires.
            </div>
          </div>
          <button
            className="aoBtn"
            onClick={() => {
              closeCurrencyMenu()
              clearAutoSaveTimer('schedule:rows')
              setSaveState('idle')
              setSaveError('')
              setOpen(false)
            }}
          >
            Close
          </button>
        </div>
        <div className="aoModalBody">
          {loading ? (
            <div className="aoHint">Loading...</div>
          ) : (
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
                  {rows
                    .map((row, index) => ({ row, index }))
                    .sort((a, b) =>
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
                              setSaveState('idle')
                              setRows((prev) =>
                                prev.map((item, i) =>
                                  i === index ? { ...item, mode: nextMode } : item,
                                ),
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
                              setSaveState('idle')
                              setRows((prev) =>
                                prev.map((item, i) =>
                                  i === index ? { ...item, startText: e.target.value } : item,
                                ),
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
                              setSaveState('idle')
                              setRows((prev) =>
                                prev.map((item, i) =>
                                  i === index ? { ...item, endText: e.target.value } : item,
                                ),
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
                              setSaveState('idle')
                              setRows((prev) =>
                                prev.map((item, i) =>
                                  i === index ? { ...item, amountText: e.target.value } : item,
                                ),
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
                              aria-expanded={currencyMenu?.rowIndex === index}
                              onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect()
                                setCurrencyMenu((prev) => {
                                  if (prev?.rowIndex === index) {
                                    setCurrencyQuery('')
                                    return null
                                  }
                                  setCurrencyQuery('')
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
                              setSaveState('idle')
                              setRows((prev) => prev.filter((_, i) => i !== index))
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={8}>
                        <div className="aoHint">No scheduled periods yet. Click Add Period to create one.</div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <div className="aoUsageScheduleActions">
                <button className="aoTinyBtn" onClick={onAddPeriod} disabled={!providerOptions.length && !provider}>
                  Add Period
                </button>
                <span className={`aoHint aoUsageScheduleAutosave aoUsageScheduleAutosave-${saveState}`}>
                  {saveStatusText}
                </span>
              </div>
              <div className="aoHint aoUsageScheduleHint">
                Timeline rows are the source for historical base pricing. Editing here updates only listed rows.
              </div>
            </>
          )}
        </div>
      </div>
      {currencyMenu
        ? createPortal(
            (() => {
              const row = rows[currencyMenu.rowIndex]
              if (!row) return null
              const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
              const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800
              const width = Math.max(86, Math.min(132, currencyMenu.width))
              const left = Math.max(8, Math.min(currencyMenu.left, viewportWidth - width - 8))
              const menuHeight = 260
              const belowSpace = viewportHeight - currencyMenu.top - 8
              const top =
                belowSpace >= 180 ? currencyMenu.top : Math.max(8, currencyMenu.top - menuHeight - 36)
              const maxHeight = Math.max(140, Math.min(menuHeight, viewportHeight - top - 8))
              const query = currencyQuery.trim().toUpperCase()
              const filteredOptions = usageCurrencyOptions.filter((currencyCode) => {
                const normalized = normalizeCurrencyCode(currencyCode)
                const label = currencyLabel(normalized).toUpperCase()
                return query.length === 0 || normalized.includes(query) || label.includes(query)
              })

              return (
                <div
                  ref={currencyMenuRef}
                  className="aoUsagePricingCurrencyMenu aoUsagePricingCurrencyMenuPortal"
                  role="listbox"
                  style={{ left, top, width, maxHeight }}
                >
                  <div className="aoUsagePricingCurrencySearchWrap">
                    <input
                      className="aoInput aoUsagePricingCurrencySearch"
                      placeholder="Search"
                      value={currencyQuery}
                      onChange={(e) => setCurrencyQuery(e.target.value)}
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
                          updateCurrency(currencyMenu.rowIndex, normalized)
                          closeCurrencyMenu()
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
        : null}
    </ModalBackdrop>
  )
}
