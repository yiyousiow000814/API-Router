import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { SpendHistoryRow } from '../devMockData'
import type { Config, UsageStatistics } from '../types'
import type { ProviderScheduleDraft, UsageHistoryDraft, UsagePricingDraft, UsagePricingSaveState, UsageScheduleSaveState } from '../types/usage'
import { buildUsageCurrencyOptions, convertCurrencyToUsd, convertUsdToCurrency } from '../utils/currency'
import { buildDevUsageStatistics } from '../utils/devUsageStatistics'
import { useUsageScheduleCore } from './useUsageScheduleCore'
import { useUsagePricingHistoryActions } from './useUsagePricingHistoryActions'

type UsagePricingCurrencyMenuState = {
  provider: string
  providers: string[]
  left: number
  top: number
  width: number
} | null

type UsageScheduleCurrencyMenuState = {
  rowIndex: number
  left: number
  top: number
  width: number
} | null

type Params = {
  isDevPreview: boolean
  usageWindowHours: number
  usageFilterProviders: string[]
  usageFilterModels: string[]
  usageFilterOrigins: string[]
  setUsageStatistics: Dispatch<SetStateAction<UsageStatistics | null>>
  setUsageStatisticsLoading: Dispatch<SetStateAction<boolean>>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  autoSaveTimersRef: MutableRefObject<Record<string, number>>
  fxRatesByCurrency: Record<string, number>
  setFxRatesByCurrency: Dispatch<SetStateAction<Record<string, number>>>
  setFxRatesDate: Dispatch<SetStateAction<string>>
  config: Config | null
  setUsagePricingDrafts: Dispatch<SetStateAction<Record<string, UsagePricingDraft>>>
  usageScheduleRows: ProviderScheduleDraft[]
  setUsageScheduleRows: Dispatch<SetStateAction<ProviderScheduleDraft[]>>
  setUsageScheduleCurrencyMenu: Dispatch<SetStateAction<UsageScheduleCurrencyMenuState>>
  setUsageScheduleCurrencyQuery: Dispatch<SetStateAction<string>>
  setUsageScheduleProvider: Dispatch<SetStateAction<string>>
  setUsageScheduleModalOpen: Dispatch<SetStateAction<boolean>>
  setUsageScheduleLoading: Dispatch<SetStateAction<boolean>>
  setUsageScheduleSaveState: Dispatch<SetStateAction<UsageScheduleSaveState>>
  setUsageScheduleSaveError: Dispatch<SetStateAction<string>>
  setUsageScheduleSaving: Dispatch<SetStateAction<boolean>>
  usageScheduleModalOpen: boolean
  usageScheduleLastSavedSigRef: MutableRefObject<string>
  usageScheduleLastSavedByProviderRef: MutableRefObject<Record<string, string>>
  setUsagePricingCurrencyMenu: Dispatch<SetStateAction<UsagePricingCurrencyMenuState>>
  setUsagePricingCurrencyQuery: Dispatch<SetStateAction<string>>
  refreshConfig: () => Promise<void>
  usageHistoryModalOpen: boolean
  usagePricingModalOpen: boolean
  setUsagePricingSaveState: Dispatch<SetStateAction<Record<string, UsagePricingSaveState>>>
  usagePricingLastSavedSigRef: MutableRefObject<Record<string, string>>
  usagePricingDrafts: Record<string, UsagePricingDraft>
  setUsageHistoryLoading: Dispatch<SetStateAction<boolean>>
  devMockHistoryEnabled: boolean
  setUsageHistoryRows: Dispatch<SetStateAction<SpendHistoryRow[]>>
  usageHistoryLoadedRef: MutableRefObject<boolean>
  setUsageHistoryDrafts: Dispatch<SetStateAction<Record<string, UsageHistoryDraft>>>
  setUsageHistoryEditCell: Dispatch<SetStateAction<string | null>>
  usageHistoryDrafts: Record<string, UsageHistoryDraft>
}

export function useUsageOpsBridge(params: Params) {
  const {
    isDevPreview,
    usageWindowHours,
    usageFilterProviders,
    usageFilterModels,
    usageFilterOrigins,
    setUsageStatistics,
    setUsageStatisticsLoading,
    flashToast,
    autoSaveTimersRef,
    fxRatesByCurrency,
    setFxRatesByCurrency,
    setFxRatesDate,
    config,
    setUsagePricingDrafts,
    usageScheduleRows,
    setUsageScheduleRows,
    setUsageScheduleCurrencyMenu,
    setUsageScheduleCurrencyQuery,
    setUsageScheduleProvider,
    setUsageScheduleModalOpen,
    setUsageScheduleLoading,
    setUsageScheduleSaveState,
    setUsageScheduleSaveError,
    setUsageScheduleSaving,
    usageScheduleModalOpen,
    usageScheduleLastSavedSigRef,
    usageScheduleLastSavedByProviderRef,
    setUsagePricingCurrencyMenu,
    setUsagePricingCurrencyQuery,
    refreshConfig,
    usageHistoryModalOpen,
    usagePricingModalOpen,
    setUsagePricingSaveState,
    usagePricingLastSavedSigRef,
    usagePricingDrafts,
    setUsageHistoryLoading,
    devMockHistoryEnabled,
    setUsageHistoryRows,
    usageHistoryLoadedRef,
    setUsageHistoryDrafts,
    setUsageHistoryEditCell,
    usageHistoryDrafts,
  } = params

  function clearAutoSaveTimer(key: string) {
    const timer = autoSaveTimersRef.current[key]
    if (timer) {
      window.clearTimeout(timer)
      delete autoSaveTimersRef.current[key]
    }
  }

  function clearAutoSaveTimersByPrefix(prefix: string) {
    Object.keys(autoSaveTimersRef.current).forEach((key) => {
      if (key.startsWith(prefix)) {
        window.clearTimeout(autoSaveTimersRef.current[key])
        delete autoSaveTimersRef.current[key]
      }
    })
  }

  function queueAutoSaveTimer(key: string, callback: () => void, delayMs = 700) {
    clearAutoSaveTimer(key)
    autoSaveTimersRef.current[key] = window.setTimeout(() => {
      delete autoSaveTimersRef.current[key]
      callback()
    }, delayMs)
  }

  const refreshUsageStatistics = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true
    if (isDevPreview) {
      setUsageStatistics(
        buildDevUsageStatistics({
          now: Date.now(),
          usageWindowHours,
          usageFilterProviders,
          usageFilterModels,
          usageFilterOrigins,
        }),
      )
      return
    }
    if (!silent) setUsageStatisticsLoading(true)
    try {
      const res = await invoke<UsageStatistics>('get_usage_statistics', {
        hours: usageWindowHours,
        providers: usageFilterProviders.length ? usageFilterProviders : null,
        models: usageFilterModels.length ? usageFilterModels : null,
        origins: usageFilterOrigins.length ? usageFilterOrigins : null,
      })
      setUsageStatistics(res)
    } catch (e) {
      if (!silent) flashToast(String(e), 'error')
    } finally {
      if (!silent) setUsageStatisticsLoading(false)
    }
  }, [
    isDevPreview,
    setUsageStatistics,
    usageWindowHours,
    usageFilterProviders,
    usageFilterModels,
    usageFilterOrigins,
    setUsageStatisticsLoading,
    flashToast,
  ])

  const usageCurrencyOptions = useMemo(() => buildUsageCurrencyOptions(fxRatesByCurrency), [fxRatesByCurrency])

  const queueUsagePricingAutoSaveRef = useRef<((providerNames: string[], draft: UsagePricingDraft) => void) | null>(null)
  const refreshUsageHistoryRef = useRef<((options?: { silent?: boolean; keepEditCell?: boolean }) => Promise<void>) | null>(null)

  const scheduleCore = useUsageScheduleCore({
    config,
    fxRatesByCurrency,
    setFxRatesByCurrency,
    setFxRatesDate,
    setUsagePricingDrafts,
    queueUsagePricingAutoSaveForProviders: (providerNames: string[], draft: UsagePricingDraft) => {
      queueUsagePricingAutoSaveRef.current?.(providerNames, draft)
    },
    usageScheduleRows,
    setUsageScheduleRows,
    setUsageScheduleCurrencyMenu,
    setUsageScheduleCurrencyQuery,
    setUsageScheduleProvider,
    setUsageScheduleModalOpen,
    setUsageScheduleLoading,
    setUsageScheduleSaveState,
    setUsageScheduleSaveError,
    setUsageScheduleSaving,
    usageScheduleModalOpen,
    usageScheduleProviderOptions: Object.keys(config?.providers ?? {}).filter((name) => name !== 'official'),
    usageScheduleLastSavedSigRef,
    usageScheduleLastSavedByProviderRef,
    setUsagePricingCurrencyMenu,
    setUsagePricingCurrencyQuery,
    flashToast,
    refreshConfig,
    refreshUsageStatistics,
    usageHistoryModalOpen,
    refreshUsageHistory: (options?: { silent?: boolean; keepEditCell?: boolean }) =>
      refreshUsageHistoryRef.current ? refreshUsageHistoryRef.current(options) : Promise.resolve(),
  })

  const pricingHistory = useUsagePricingHistoryActions({
    config,
    fxRatesByCurrency,
    convertCurrencyToUsd,
    convertUsdToCurrency,
    providerApiKeyLabel: scheduleCore.providerApiKeyLabel,
    setUsagePricingSaveState,
    usagePricingLastSavedSigRef,
    pricingDraftSignature: scheduleCore.pricingDraftSignature,
    refreshConfig,
    refreshUsageStatistics,
    flashToast,
    usagePricingModalOpen,
    clearAutoSaveTimer,
    queueAutoSaveTimer,
    usagePricingDrafts,
    openUsageScheduleModal: scheduleCore.openUsageScheduleModal,
    setUsageHistoryLoading,
    devMockHistoryEnabled,
    isDevPreview,
    setUsageHistoryRows,
    usageHistoryLoadedRef,
    setUsageHistoryDrafts,
    setUsageHistoryEditCell,
    usageHistoryModalOpen,
    usageHistoryDrafts,
    historyDraftFromRow: scheduleCore.historyDraftFromRow,
    historyEffectiveDisplayValue: scheduleCore.historyEffectiveDisplayValue,
    historyPerReqDisplayValue: scheduleCore.historyPerReqDisplayValue,
  })

  queueUsagePricingAutoSaveRef.current = pricingHistory.queueUsagePricingAutoSaveForProviders
  refreshUsageHistoryRef.current = pricingHistory.refreshUsageHistory

  return {
    clearAutoSaveTimer,
    clearAutoSaveTimersByPrefix,
    queueAutoSaveTimer,
    refreshUsageStatistics,
    usageCurrencyOptions,
    ...scheduleCore,
    ...pricingHistory,
  }
}
