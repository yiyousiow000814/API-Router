import { createPortal } from 'react-dom'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { UsagePricingDraft, UsagePricingGroup, UsagePricingMode, UsagePricingSaveState } from '../appTypes'
import type { Config } from '../types'
import { ModalBackdrop } from './ModalBackdrop'

type CurrencyMenuState = {
  provider: string
  providers: string[]
  left: number
  top: number
  width: number
}

type Props = {
  open: boolean
  onClose: () => void
  fxRatesDate: string
  config: Config | null
  usagePricingGroups: UsagePricingGroup[]
  usagePricingDrafts: Record<string, UsagePricingDraft>
  usagePricingSaveState: Record<string, UsagePricingSaveState>
  usagePricingProviderNames: string[]
  usagePricingCurrencyMenu: CurrencyMenuState | null
  usagePricingCurrencyQuery: string
  usageCurrencyOptions: string[]
  usagePricingCurrencyMenuRef: MutableRefObject<HTMLDivElement | null>
  usagePricingLastSavedSigRef: MutableRefObject<Record<string, string>>
  setUsagePricingCurrencyMenu: Dispatch<SetStateAction<CurrencyMenuState | null>>
  setUsagePricingCurrencyQuery: Dispatch<SetStateAction<string>>
  setUsagePricingDrafts: Dispatch<SetStateAction<Record<string, UsagePricingDraft>>>
  setUsagePricingSaveStateForProviders: (providerNames: string[], state: UsagePricingSaveState) => void
  buildUsagePricingDraft: (
    providerName: string,
    providerCfg: Config['providers'][string] | undefined,
  ) => UsagePricingDraft
  queueUsagePricingAutoSaveForProviders: (providerNames: string[], draft: UsagePricingDraft) => void
  clearAutoSaveTimer: (key: string) => void
  saveUsagePricingForProviders: (
    providerNames: string[],
    draft: UsagePricingDraft,
    options?: { silent?: boolean },
  ) => Promise<boolean>
  openUsageScheduleModal: (providerName: string, defaultCurrency: string) => Promise<void>
  providerPreferredCurrency: (providerName: string) => string
  pricingDraftSignature: (draft: UsagePricingDraft) => string
  normalizeCurrencyCode: (code: string) => string
  currencyLabel: (code: string) => string
  updateUsagePricingCurrency: (providerNames: string[], draft: UsagePricingDraft, nextCurrency: string) => void
  closeUsagePricingCurrencyMenu: () => void
}

export function UsagePricingModal({
  open,
  onClose,
  fxRatesDate,
  config,
  usagePricingGroups,
  usagePricingDrafts,
  usagePricingSaveState,
  usagePricingProviderNames,
  usagePricingCurrencyMenu,
  usagePricingCurrencyQuery,
  usageCurrencyOptions,
  usagePricingCurrencyMenuRef,
  usagePricingLastSavedSigRef,
  setUsagePricingCurrencyMenu,
  setUsagePricingCurrencyQuery,
  setUsagePricingDrafts,
  setUsagePricingSaveStateForProviders,
  buildUsagePricingDraft,
  queueUsagePricingAutoSaveForProviders,
  clearAutoSaveTimer,
  saveUsagePricingForProviders,
  openUsageScheduleModal,
  providerPreferredCurrency,
  pricingDraftSignature,
  normalizeCurrencyCode,
  currencyLabel,
  updateUsagePricingCurrency,
  closeUsagePricingCurrencyMenu,
}: Props) {
  if (!open) return null

  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onClose}>
      <div className="aoModal aoModalWide aoUsagePricingModal" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Base Pricing</div>
            <div className="aoModalSub">Configure base pricing only. Values auto-convert to USD.</div>
          </div>
          <button className="aoBtn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="aoModalBody">
          <div className="aoHint" style={{ marginBottom: 8 }}>
            FX rates date: {fxRatesDate || 'loading'} (daily update)
          </div>
          <div className="aoUsagePricingGrid">
            {usagePricingGroups.map((group) => {
              const providerName = group.primaryProvider
              const providerCfg = config?.providers?.[providerName]
              const draft = usagePricingDrafts[providerName] ?? buildUsagePricingDraft(providerName, providerCfg)
              const mode = draft.mode
              const scheduleManaged = mode === 'package_total'
              const amountDisabled = !providerCfg || mode === 'none' || scheduleManaged
              const groupState = usagePricingSaveState[providerName] ?? 'idle'
              return (
                <div key={`pricing-${group.id}`} className="aoUsagePricingRow">
                  <div className="aoUsagePricingProviderWrap">
                    <div className="aoUsagePricingProvider">{group.displayName}</div>
                    <div className="aoHint aoUsagePricingKeyHint">key: {group.keyLabel}</div>
                  </div>
                  <select
                    className="aoSelect aoUsagePricingSelect aoUsagePricingMode"
                    value={mode}
                    disabled={!providerCfg}
                    onChange={(e) => {
                      const nextMode = (e.target.value as UsagePricingMode) ?? 'none'
                      const nextDraft: UsagePricingDraft = {
                        ...draft,
                        mode: nextMode,
                        amountText: nextMode === 'none' ? '' : draft.amountText,
                      }
                      setUsagePricingDrafts((prev) => {
                        const next = { ...prev }
                        group.providers.forEach((name) => {
                          next[name] = nextDraft
                        })
                        return next
                      })
                      if (nextMode !== 'package_total') {
                        queueUsagePricingAutoSaveForProviders(group.providers, nextDraft)
                      } else {
                        clearAutoSaveTimer(`pricing:${group.id}`)
                        setUsagePricingSaveStateForProviders(group.providers, 'saving')
                        void (async () => {
                          const activated = await saveUsagePricingForProviders(group.providers, nextDraft, {
                            silent: true,
                          })
                          if (!activated) {
                            await openUsageScheduleModal(providerName, providerPreferredCurrency(providerName))
                            setUsagePricingSaveStateForProviders(group.providers, 'error')
                          } else {
                            const signature = pricingDraftSignature(nextDraft)
                            group.providers.forEach((name) => {
                              usagePricingLastSavedSigRef.current[name] = signature
                            })
                            setUsagePricingSaveStateForProviders(group.providers, 'saved')
                          }
                        })()
                      }
                    }}
                  >
                    <option value="none">Monthly credit</option>
                    <option value="package_total">Monthly fee</option>
                    <option value="per_request">$ / request</option>
                  </select>
                  {scheduleManaged ? (
                    <>
                      <button
                        className="aoTinyBtn aoUsagePricingScheduleInline"
                        disabled={!providerCfg}
                        onClick={() => void openUsageScheduleModal(providerName, providerPreferredCurrency(providerName))}
                      >
                        Schedule
                      </button>
                      <div className="aoUsagePricingSchedulePlaceholder" />
                    </>
                  ) : (
                    <>
                      <input
                        className="aoInput aoUsagePricingInput aoUsagePricingAmount"
                        type="number"
                        step="0.001"
                        min="0"
                        disabled={amountDisabled}
                        placeholder="Amount"
                        value={draft.amountText}
                        onChange={(e) => {
                          const nextDraft: UsagePricingDraft = {
                            ...draft,
                            amountText: e.target.value,
                          }
                          setUsagePricingDrafts((prev) => {
                            const next = { ...prev }
                            group.providers.forEach((name) => {
                              next[name] = nextDraft
                            })
                            return next
                          })
                          queueUsagePricingAutoSaveForProviders(group.providers, nextDraft)
                        }}
                      />
                      <div className="aoUsagePricingCurrencyWrap">
                        <button
                          type="button"
                          className="aoSelect aoUsagePricingCurrencyBtn"
                          disabled={!providerCfg || amountDisabled}
                          aria-haspopup="listbox"
                          aria-expanded={usagePricingCurrencyMenu?.provider === providerName}
                          onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setUsagePricingCurrencyMenu((prev) => {
                              if (prev?.provider === providerName) {
                                setUsagePricingCurrencyQuery('')
                                return null
                              }
                              setUsagePricingCurrencyQuery('')
                              return {
                                provider: providerName,
                                providers: group.providers,
                                left: Math.max(8, Math.round(rect.left)),
                                top: Math.round(rect.bottom + 4),
                                width: Math.round(rect.width),
                              }
                            })
                          }}
                        >
                          <span>{currencyLabel(normalizeCurrencyCode(draft.currency))}</span>
                          <span className="aoUsagePricingCurrencyChevron" aria-hidden="true">
                            ▼
                          </span>
                        </button>
                      </div>
                    </>
                  )}
                  <div className="aoUsagePricingActions">
                    <span className={`aoHint aoUsagePricingAutosave aoUsagePricingAutosave-${groupState}`}>
                      {groupState === 'saving'
                        ? 'Auto-saving...'
                        : groupState === 'saved'
                          ? 'Auto-saved'
                          : groupState === 'error'
                            ? 'Auto-save failed'
                            : 'Auto-save'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="aoHint">
            Monthly fee uses Scheduled Period History. Switching to Monthly credit keeps past history and applies
            credit after scheduled expiry.
          </div>
          <div className="aoHint">
            Providers sharing the same API key are linked as one row in Usage editing. Other pages still keep
            provider-level separation.
          </div>
        </div>
      </div>
      {usagePricingCurrencyMenu
        ? createPortal(
            (() => {
              const providerName = usagePricingCurrencyMenu.provider
              if (!usagePricingProviderNames.includes(providerName)) return null
              const providerNames = usagePricingCurrencyMenu.providers.filter((name) =>
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

              return (
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
                </div>
              )
            })(),
            document.body,
          )
        : null}
    </ModalBackdrop>
  )
}
