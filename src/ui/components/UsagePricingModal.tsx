import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Config } from '../types'
import type { UsagePricingDraft, UsagePricingGroup, UsagePricingSaveState } from '../types/usage'
import { ModalBackdrop } from './ModalBackdrop'
import { UsagePricingCurrencyMenuPortal } from './UsagePricingCurrencyMenuPortal'
import { UsagePricingRow } from './UsagePricingRow'
import type { UsagePricingCurrencyMenuState } from './UsagePricingRow'

type Props = {
  open: boolean
  onClose: () => void
  fxRatesDate: string
  usagePricingGroups: UsagePricingGroup[]
  usagePricingProviderNames: string[]
  config: Config | null
  usagePricingDrafts: Record<string, UsagePricingDraft>
  usagePricingSaveState: Record<string, UsagePricingSaveState>
  setUsagePricingDrafts: Dispatch<SetStateAction<Record<string, UsagePricingDraft>>>
  buildUsagePricingDraft: (providerName: string, providerCfg?: Config['providers'][string]) => UsagePricingDraft
  queueUsagePricingAutoSaveForProviders: (providerNames: string[], draft: UsagePricingDraft) => void
  clearAutoSaveTimer: (key: string) => void
  setUsagePricingSaveStateForProviders: (providerNames: string[], state: UsagePricingSaveState) => void
  saveUsagePricingForProviders: (
    providerNames: string[],
    draft: UsagePricingDraft,
    options?: { silent?: boolean; skipPackageActivation?: boolean },
  ) => Promise<boolean>
  openUsageScheduleModal: (
    providerName: string,
    seedCurrency?: string,
    options?: { keepVisible?: boolean },
  ) => Promise<void>
  providerPreferredCurrency: (providerName: string) => string
  pricingDraftSignature: (draft: UsagePricingDraft) => string
  onMarkPricingSaved: (providerNames: string[], signature: string) => void
  usagePricingCurrencyMenu: UsagePricingCurrencyMenuState
  setUsagePricingCurrencyMenu: Dispatch<SetStateAction<UsagePricingCurrencyMenuState>>
  usagePricingCurrencyQuery: string
  setUsagePricingCurrencyQuery: (value: string) => void
  usageCurrencyOptions: string[]
  normalizeCurrencyCode: (code: string) => string
  currencyLabel: (code: string) => string
  usagePricingCurrencyMenuRef: RefObject<HTMLDivElement | null>
  updateUsagePricingCurrency: (providerNames: string[], draft: UsagePricingDraft, nextCurrency: string) => void
  closeUsagePricingCurrencyMenu: () => void
}

export function UsagePricingModal({
  open,
  onClose,
  fxRatesDate,
  usagePricingGroups,
  usagePricingProviderNames,
  config,
  usagePricingDrafts,
  usagePricingSaveState,
  setUsagePricingDrafts,
  buildUsagePricingDraft,
  queueUsagePricingAutoSaveForProviders,
  clearAutoSaveTimer,
  setUsagePricingSaveStateForProviders,
  saveUsagePricingForProviders,
  openUsageScheduleModal,
  providerPreferredCurrency,
  pricingDraftSignature,
  onMarkPricingSaved,
  usagePricingCurrencyMenu,
  setUsagePricingCurrencyMenu,
  usagePricingCurrencyQuery,
  setUsagePricingCurrencyQuery,
  usageCurrencyOptions,
  normalizeCurrencyCode,
  currencyLabel,
  usagePricingCurrencyMenuRef,
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
              const groupState = usagePricingSaveState[providerName] ?? 'idle'
              return (
                <UsagePricingRow
                  key={`pricing-${group.id}`}
                  group={group}
                  providerName={providerName}
                  providerCfg={providerCfg}
                  draft={draft}
                  groupState={groupState}
                  setUsagePricingDrafts={setUsagePricingDrafts}
                  queueUsagePricingAutoSaveForProviders={queueUsagePricingAutoSaveForProviders}
                  clearAutoSaveTimer={clearAutoSaveTimer}
                  setUsagePricingSaveStateForProviders={setUsagePricingSaveStateForProviders}
                  saveUsagePricingForProviders={saveUsagePricingForProviders}
                  openUsageScheduleModal={openUsageScheduleModal}
                  providerPreferredCurrency={providerPreferredCurrency}
                  pricingDraftSignature={pricingDraftSignature}
                  onMarkPricingSaved={onMarkPricingSaved}
                  usagePricingCurrencyMenu={usagePricingCurrencyMenu}
                  setUsagePricingCurrencyMenu={setUsagePricingCurrencyMenu}
                  setUsagePricingCurrencyQuery={setUsagePricingCurrencyQuery}
                  normalizeCurrencyCode={normalizeCurrencyCode}
                  currencyLabel={currencyLabel}
                />
              )
            })}
          </div>
          <div className="aoHint">
            Monthly fee uses Scheduled Period History. Switching to Monthly credit keeps past history and applies credit
            after scheduled expiry.
          </div>
          <div className="aoHint">
            Providers sharing the same API key are linked as one row in Usage editing. Other pages still keep
            provider-level separation.
          </div>
        </div>
      </div>
      <UsagePricingCurrencyMenuPortal
        usagePricingCurrencyMenu={usagePricingCurrencyMenu}
        usagePricingProviderNames={usagePricingProviderNames}
        config={config}
        usagePricingDrafts={usagePricingDrafts}
        buildUsagePricingDraft={buildUsagePricingDraft}
        usagePricingCurrencyQuery={usagePricingCurrencyQuery}
        setUsagePricingCurrencyQuery={setUsagePricingCurrencyQuery}
        usageCurrencyOptions={usageCurrencyOptions}
        normalizeCurrencyCode={normalizeCurrencyCode}
        currencyLabel={currencyLabel}
        usagePricingCurrencyMenuRef={usagePricingCurrencyMenuRef}
        updateUsagePricingCurrency={updateUsagePricingCurrency}
        closeUsagePricingCurrencyMenu={closeUsagePricingCurrencyMenu}
      />
    </ModalBackdrop>
  )
}
