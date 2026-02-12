import { useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { UsageStatistics } from '../types'
import type { UsagePricingDraft } from '../types/usage'
import { buildUsageCurrencyOptions, convertCurrencyToUsd, convertUsdToCurrency } from '../utils/currency'
import { buildDevUsageStatistics } from '../utils/devUsageStatistics'
import { useUsageScheduleCore } from './useUsageScheduleCore'
import { useUsagePricingHistoryActions } from './useUsagePricingHistoryActions'

type Params = Record<string, any>

export function useUsageOpsBridge(params: Params) {
  const {
    isDevPreview,
    usageWindowHours,
    usageFilterProviders,
    usageFilterModels,
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

  async function refreshUsageStatistics(options?: { silent?: boolean }) {
    const silent = options?.silent === true
    if (isDevPreview) {
      setUsageStatistics(
        buildDevUsageStatistics({
          now: Date.now(),
          usageWindowHours,
          usageFilterProviders,
          usageFilterModels,
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
      })
      setUsageStatistics(res)
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      if (!silent) setUsageStatisticsLoading(false)
    }
  }

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
    usageScheduleProviderOptions: Object.keys(config?.providers ?? {}),
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
