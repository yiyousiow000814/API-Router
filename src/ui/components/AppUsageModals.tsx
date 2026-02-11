import { invoke } from '@tauri-apps/api/core'
import type { Dispatch, MutableRefObject, ReactNode, RefObject, SetStateAction } from 'react'

import { UsageHistoryModal } from './UsageHistoryModal'
import { UsagePricingModal } from './UsagePricingModal'
import { UsageScheduleModal } from './UsageScheduleModal'

type Props = {
  usageHistoryModalOpen: boolean
  usageHistoryLoading: boolean
  usageHistoryRows: any[]
  usageHistoryTableSurfaceRef: RefObject<HTMLDivElement | null>
  usageHistoryTableWrapRef: RefObject<HTMLDivElement | null>
  usageHistoryScrollbarOverlayRef: RefObject<HTMLDivElement | null>
  usageHistoryScrollbarThumbRef: RefObject<HTMLDivElement | null>
  renderUsageHistoryColGroup: () => ReactNode
  setUsageHistoryModalOpen: (open: boolean) => void
  scheduleUsageHistoryScrollbarSync: () => void
  activateUsageHistoryScrollbarUi: () => void
  usageHistoryDrafts: Record<string, any>
  usageHistoryEditCell: string | null
  setUsageHistoryEditCell: Dispatch<SetStateAction<string | null>>
  setUsageHistoryDrafts: Dispatch<SetStateAction<Record<string, any>>>
  historyDraftFromRow: (row: any, formatDraftAmount: (value: number) => string) => any
  formatDraftAmount: (value: number) => string
  historyPerReqDisplayValue: (row: any) => number | null
  historyEffectiveDisplayValue: (row: any) => number | null
  queueUsageHistoryAutoSave: (row: any, field: 'effective' | 'per_req') => void
  clearAutoSaveTimer: (key: string) => void
  saveUsageHistoryRow: (
    row: any,
    options?: { silent?: boolean; keepEditCell?: boolean; field?: 'effective' | 'per_req' },
  ) => Promise<void>
  refreshUsageHistory: (options?: { silent?: boolean; keepEditCell?: boolean }) => Promise<void>
  refreshUsageStatistics: (options?: { silent?: boolean }) => Promise<void>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  fmtUsdMaybe: (value?: number | null) => string
  fmtHistorySource: (source?: string | null) => string
  onUsageHistoryScrollbarPointerDown: (event: any) => void
  onUsageHistoryScrollbarPointerMove: (event: any) => void
  onUsageHistoryScrollbarPointerUp: (event: any) => void
  onUsageHistoryScrollbarLostPointerCapture: (event: any) => void
  usagePricingModalOpen: boolean
  setUsagePricingModalOpen: (open: boolean) => void
  fxRatesDate: string
  config: any
  usagePricingGroups: any[]
  usagePricingDrafts: Record<string, any>
  usagePricingSaveState: Record<string, any>
  usagePricingProviderNames: string[]
  usagePricingCurrencyMenu: any
  usagePricingCurrencyQuery: string
  usageCurrencyOptions: string[]
  usagePricingCurrencyMenuRef: RefObject<HTMLDivElement | null>
  usagePricingLastSavedSigRef: MutableRefObject<Record<string, string>>
  setUsagePricingCurrencyMenu: Dispatch<SetStateAction<any>>
  setUsagePricingCurrencyQuery: Dispatch<SetStateAction<string>>
  setUsagePricingDrafts: Dispatch<SetStateAction<Record<string, any>>>
  setUsagePricingSaveStateForProviders: (providerNames: string[], state: any) => void
  buildUsagePricingDraft: (providerName: string, providerCfg?: any) => any
  queueUsagePricingAutoSaveForProviders: (providerNames: string[], draft: any) => void
  saveUsagePricingForProviders: (providerNames: string[], draft: any, options?: { silent?: boolean }) => Promise<boolean>
  openUsageScheduleModal: (providerName: string, seedCurrency?: string, options?: { keepVisible?: boolean }) => Promise<void>
  providerPreferredCurrency: (providerName: string) => string
  pricingDraftSignature: (draft: any) => string
  normalizeCurrencyCode: (value: string) => string
  currencyLabel: (code: string) => string
  updateUsagePricingCurrency: (providerNames: string[], draft: any, nextCurrency: string) => void
  closeUsagePricingCurrencyMenu: () => void
  usageScheduleModalOpen: boolean
  usageScheduleLoading: boolean
  usageScheduleRows: any[]
  usageScheduleProvider: string
  usageScheduleProviderOptions: string[]
  usageScheduleSaveState: any
  usageScheduleSaveStatusText: string
  usageScheduleCurrencyMenu: any
  usageScheduleCurrencyMenuRef: RefObject<HTMLDivElement | null>
  usageScheduleCurrencyQuery: string
  setUsageScheduleCurrencyQuery: Dispatch<SetStateAction<string>>
  setUsageScheduleRows: Dispatch<SetStateAction<any[]>>
  setUsageScheduleSaveState: Dispatch<SetStateAction<any>>
  setUsageScheduleSaveError: Dispatch<SetStateAction<string>>
  closeUsageScheduleCurrencyMenu: () => void
  setUsageScheduleModalOpen: (open: boolean) => void
  providerDisplayName: (providerName: string) => string
  providerApiKeyLabel: (providerName: string) => string
  updateUsageScheduleCurrency: (rowIndex: number, nextCurrency: string) => void
  setUsageScheduleCurrencyMenu: React.Dispatch<React.SetStateAction<any>>
  parsePositiveAmount: (value: string) => number | null
  convertCurrencyToUsd: (amount: number, currency: string) => number
  configProviders: Record<string, any>
  linkedProvidersForApiKey: (apiKeyRef: string, fallbackProvider: string) => string[]
  buildNewScheduleDraft: (...args: any[]) => any
  readPreferredCurrency: (providerName: string, apiKeyRef?: string) => string
  fxRatesByCurrency: Record<string, number>
}

export function AppUsageModals(props: Props) {
  return (
    <>
      <UsageHistoryModal
        open={props.usageHistoryModalOpen}
        loading={props.usageHistoryLoading}
        rows={props.usageHistoryRows}
        tableSurfaceRef={props.usageHistoryTableSurfaceRef}
        tableWrapRef={props.usageHistoryTableWrapRef}
        scrollbarOverlayRef={props.usageHistoryScrollbarOverlayRef}
        scrollbarThumbRef={props.usageHistoryScrollbarThumbRef}
        renderColGroup={props.renderUsageHistoryColGroup}
        onClose={() => props.setUsageHistoryModalOpen(false)}
        onBodyScroll={() => {
          props.scheduleUsageHistoryScrollbarSync()
          props.activateUsageHistoryScrollbarUi()
        }}
        onBodyWheel={() => {
          props.scheduleUsageHistoryScrollbarSync()
          props.activateUsageHistoryScrollbarUi()
        }}
        onBodyTouchMove={props.activateUsageHistoryScrollbarUi}
        drafts={props.usageHistoryDrafts}
        editCell={props.usageHistoryEditCell}
        setEditCell={props.setUsageHistoryEditCell}
        setDrafts={props.setUsageHistoryDrafts}
        buildBaseDraft={(row) => props.historyDraftFromRow(row, props.formatDraftAmount)}
        perReqDisplay={props.historyPerReqDisplayValue}
        effectiveDisplay={props.historyEffectiveDisplayValue}
        queueAutoSave={props.queueUsageHistoryAutoSave}
        clearAutoSaveTimer={props.clearAutoSaveTimer}
        saveRow={props.saveUsageHistoryRow}
        onClearRow={async (row) => {
          try {
            await invoke('set_spend_history_entry', {
              provider: row.provider,
              dayKey: row.day_key,
              totalUsedUsd: null,
              usdPerReq: null,
            })
            props.setUsageHistoryEditCell(null)
            await props.refreshUsageHistory({ silent: true })
            await props.refreshUsageStatistics({ silent: true })
            props.flashToast(`History cleared: ${row.provider} ${row.day_key}`)
          } catch (error) {
            props.flashToast(String(error), 'error')
          }
        }}
        fmtUsdMaybe={props.fmtUsdMaybe}
        fmtHistorySource={props.fmtHistorySource}
        onScrollbarPointerDown={props.onUsageHistoryScrollbarPointerDown}
        onScrollbarPointerMove={props.onUsageHistoryScrollbarPointerMove}
        onScrollbarPointerUp={props.onUsageHistoryScrollbarPointerUp}
        onScrollbarLostPointerCapture={props.onUsageHistoryScrollbarLostPointerCapture}
      />

      <UsagePricingModal
        open={props.usagePricingModalOpen}
        onClose={() => props.setUsagePricingModalOpen(false)}
        fxRatesDate={props.fxRatesDate}
        config={props.config}
        usagePricingGroups={props.usagePricingGroups}
        usagePricingDrafts={props.usagePricingDrafts}
        usagePricingSaveState={props.usagePricingSaveState}
        usagePricingProviderNames={props.usagePricingProviderNames}
        usagePricingCurrencyMenu={props.usagePricingCurrencyMenu}
        usagePricingCurrencyQuery={props.usagePricingCurrencyQuery}
        usageCurrencyOptions={props.usageCurrencyOptions}
        usagePricingCurrencyMenuRef={props.usagePricingCurrencyMenuRef}
        usagePricingLastSavedSigRef={props.usagePricingLastSavedSigRef}
        setUsagePricingCurrencyMenu={props.setUsagePricingCurrencyMenu}
        setUsagePricingCurrencyQuery={props.setUsagePricingCurrencyQuery}
        setUsagePricingDrafts={props.setUsagePricingDrafts}
        setUsagePricingSaveStateForProviders={props.setUsagePricingSaveStateForProviders}
        buildUsagePricingDraft={props.buildUsagePricingDraft}
        queueUsagePricingAutoSaveForProviders={props.queueUsagePricingAutoSaveForProviders}
        clearAutoSaveTimer={props.clearAutoSaveTimer}
        saveUsagePricingForProviders={props.saveUsagePricingForProviders}
        openUsageScheduleModal={props.openUsageScheduleModal}
        providerPreferredCurrency={props.providerPreferredCurrency}
        pricingDraftSignature={props.pricingDraftSignature}
        normalizeCurrencyCode={props.normalizeCurrencyCode}
        currencyLabel={props.currencyLabel}
        updateUsagePricingCurrency={props.updateUsagePricingCurrency}
        closeUsagePricingCurrencyMenu={props.closeUsagePricingCurrencyMenu}
      />

      <UsageScheduleModal
        open={props.usageScheduleModalOpen}
        loading={props.usageScheduleLoading}
        rows={props.usageScheduleRows}
        provider={props.usageScheduleProvider}
        providerOptions={props.usageScheduleProviderOptions}
        saveState={props.usageScheduleSaveState}
        saveStatusText={props.usageScheduleSaveStatusText}
        currencyMenu={props.usageScheduleCurrencyMenu}
        currencyMenuRef={props.usageScheduleCurrencyMenuRef}
        currencyQuery={props.usageScheduleCurrencyQuery}
        setCurrencyQuery={props.setUsageScheduleCurrencyQuery}
        usageCurrencyOptions={props.usageCurrencyOptions}
        setRows={props.setUsageScheduleRows}
        setSaveState={props.setUsageScheduleSaveState}
        setSaveError={props.setUsageScheduleSaveError}
        closeCurrencyMenu={props.closeUsageScheduleCurrencyMenu}
        clearAutoSaveTimer={props.clearAutoSaveTimer}
        setOpen={props.setUsageScheduleModalOpen}
        providerDisplayName={props.providerDisplayName}
        providerApiKeyLabel={props.providerApiKeyLabel}
        normalizeCurrencyCode={props.normalizeCurrencyCode}
        currencyLabel={props.currencyLabel}
        updateCurrency={props.updateUsageScheduleCurrency}
        setCurrencyMenu={props.setUsageScheduleCurrencyMenu}
        onAddPeriod={() => {
          props.setUsageScheduleSaveState('idle')
          const targetProvider = props.usageScheduleProviderOptions.includes(props.usageScheduleProvider)
            ? props.usageScheduleProvider
            : props.usageScheduleProviderOptions[0] ?? props.usageScheduleProvider
          if (!targetProvider) return
          props.setUsageScheduleRows((prev) => {
            const providerRows = prev.filter((item) => item.provider === targetProvider)
            const last = providerRows[providerRows.length - 1]
            const lastAmount = props.parsePositiveAmount(last?.amountText ?? '')
            const lastCurrency = last?.currency
            const fallbackCurrency = lastCurrency ?? props.providerPreferredCurrency(targetProvider)
            const providerAmountUsd = props.configProviders?.[targetProvider]?.manual_pricing_amount_usd ?? null
            const seedAmountUsd =
              lastAmount != null ? props.convertCurrencyToUsd(lastAmount, fallbackCurrency) : providerAmountUsd
            const providerMode = (props.configProviders?.[targetProvider]?.manual_pricing_mode ??
              'package_total') as 'per_request' | 'package_total'
            const seedMode = providerMode === 'per_request' ? 'per_request' : 'package_total'
            const linkedProviders = props.linkedProvidersForApiKey(
              props.providerApiKeyLabel(targetProvider),
              targetProvider,
            )
            return [
              ...prev,
              props.buildNewScheduleDraft(
                targetProvider,
                seedAmountUsd,
                fallbackCurrency,
                seedMode,
                linkedProviders,
                props.providerApiKeyLabel,
                props.readPreferredCurrency,
                props.fxRatesByCurrency,
              ),
            ]
          })
        }}
      />
    </>
  )
}
