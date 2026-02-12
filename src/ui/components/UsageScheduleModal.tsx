import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Config } from '../types'
import type {
  PricingTimelineMode,
  ProviderScheduleDraft,
  UsageScheduleSaveState,
} from '../types/usage'
import { ModalBackdrop } from './ModalBackdrop'
import {
  UsageScheduleCurrencyMenuPortal,
  type UsageScheduleCurrencyMenuState,
} from './UsageScheduleCurrencyMenuPortal'
import { UsageScheduleModalHeader } from './UsageScheduleModalHeader'
import { UsageScheduleTable } from './UsageScheduleTable'

type UsageScheduleModalProps = {
  open: boolean
  onClose: () => void
  usageScheduleLoading: boolean
  usageScheduleRows: ProviderScheduleDraft[]
  providerDisplayName: (provider: string) => string
  providerApiKeyLabel: (provider: string) => string
  usageScheduleCurrencyMenu: UsageScheduleCurrencyMenuState
  setUsageScheduleCurrencyMenu: Dispatch<SetStateAction<UsageScheduleCurrencyMenuState>>
  usageScheduleCurrencyQuery: string
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
  usageCurrencyOptions: string[]
  usageScheduleCurrencyMenuRef: RefObject<HTMLDivElement | null>
  updateUsageScheduleCurrency: (rowIndex: number, currencyCode: string) => void
  closeUsageScheduleCurrencyMenu: () => void
}

export function UsageScheduleModal({
  open,
  onClose,
  usageScheduleLoading,
  usageScheduleRows,
  providerDisplayName,
  providerApiKeyLabel,
  usageScheduleCurrencyMenu,
  setUsageScheduleCurrencyMenu,
  usageScheduleCurrencyQuery,
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
  usageCurrencyOptions,
  usageScheduleCurrencyMenuRef,
  updateUsageScheduleCurrency,
  closeUsageScheduleCurrencyMenu,
}: UsageScheduleModalProps) {
  if (!open) return null

  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onClose}>
      <div className="aoModal aoModalWide aoUsageScheduleModal" onClick={(e) => e.stopPropagation()}>
        <UsageScheduleModalHeader onClose={onClose} />
        <div className="aoModalBody">
          <UsageScheduleTable
            usageScheduleLoading={usageScheduleLoading}
            usageScheduleRows={usageScheduleRows}
            providerDisplayName={providerDisplayName}
            providerApiKeyLabel={providerApiKeyLabel}
            usageScheduleCurrencyMenu={usageScheduleCurrencyMenu}
            setUsageScheduleCurrencyMenu={setUsageScheduleCurrencyMenu}
            setUsageScheduleCurrencyQuery={setUsageScheduleCurrencyQuery}
            currencyLabel={currencyLabel}
            normalizeCurrencyCode={normalizeCurrencyCode}
            setUsageScheduleSaveState={setUsageScheduleSaveState}
            setUsageScheduleRows={setUsageScheduleRows}
            usageScheduleProviderOptions={usageScheduleProviderOptions}
            usageScheduleProvider={usageScheduleProvider}
            parsePositiveAmount={parsePositiveAmount}
            providerPreferredCurrency={providerPreferredCurrency}
            config={config}
            fxRatesByCurrency={fxRatesByCurrency}
            convertCurrencyToUsd={convertCurrencyToUsd}
            linkedProvidersForApiKey={linkedProvidersForApiKey}
            newScheduleDraft={newScheduleDraft}
            usageScheduleSaveState={usageScheduleSaveState}
            usageScheduleSaveStatusText={usageScheduleSaveStatusText}
          />
        </div>
      </div>
      <UsageScheduleCurrencyMenuPortal
        usageScheduleCurrencyMenu={usageScheduleCurrencyMenu}
        usageScheduleRows={usageScheduleRows}
        usageScheduleCurrencyMenuRef={usageScheduleCurrencyMenuRef}
        usageScheduleCurrencyQuery={usageScheduleCurrencyQuery}
        setUsageScheduleCurrencyQuery={setUsageScheduleCurrencyQuery}
        usageCurrencyOptions={usageCurrencyOptions}
        currencyLabel={currencyLabel}
        normalizeCurrencyCode={normalizeCurrencyCode}
        updateUsageScheduleCurrency={updateUsageScheduleCurrency}
        closeUsageScheduleCurrencyMenu={closeUsageScheduleCurrencyMenu}
      />
    </ModalBackdrop>
  )
}
