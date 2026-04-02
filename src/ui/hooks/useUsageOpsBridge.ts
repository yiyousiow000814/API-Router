import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { startTransition, useCallback, useMemo, useRef } from 'react'
import type { SpendHistoryRow } from '../devMockData'
import { invoke, recordUiTrace } from '../tauriCore'
import type { Config, UsageStatistics, UsageStatisticsOverview } from '../types'
import type { ProviderScheduleDraft, UsageHistoryDraft, UsagePricingDraft, UsagePricingSaveState, UsageScheduleSaveState } from '../types/usage'
import { buildUsageCurrencyOptions, convertCurrencyToUsd, convertUsdToCurrency } from '../utils/currency'
import { buildDevUsageStatistics } from '../utils/devUsageStatistics'
import { buildUsageStatisticsOverviewFromFull } from '../utils/usageStatisticsOverview'
import { runSingleFlight } from '../utils/singleFlight'
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

export function isDashboardUsageRefreshSource(source: string): boolean {
  return source.startsWith('usage_page_') && source.endsWith(':dashboard')
}

export function buildDevPreviewUsageSnapshot(params: {
  now: number
  usageWindowHours: number
  usageFilterNodes: string[]
  usageFilterProviders: string[]
  usageFilterModels: string[]
  usageFilterOrigins: string[]
  config: Config | null
}): {
  stats: UsageStatistics
  overview: UsageStatisticsOverview | null
} {
  const stats = buildDevUsageStatistics(params)
  return {
    stats,
    overview: buildUsageStatisticsOverviewFromFull(stats),
  }
}

type Params = {
  isDevPreview: boolean
  usageWindowHours: number
  usageFilterNodes: string[]
  usageFilterProviders: string[]
  usageFilterModels: string[]
  usageFilterOrigins: string[]
  setUsageOverview: Dispatch<SetStateAction<UsageStatisticsOverview | null>>
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
    usageFilterNodes,
    usageFilterProviders,
    usageFilterModels,
    usageFilterOrigins,
    setUsageOverview,
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
  const usageOverviewInFlightRef = useRef<Map<string, Promise<UsageStatisticsOverview>>>(new Map())
  const usageStatisticsInFlightRef = useRef<Map<string, Promise<UsageStatistics>>>(new Map())

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

  const refreshUsageStatistics = useCallback(async (options?: {
    silent?: boolean
    applyGuard?: () => boolean
    interactive?: boolean
    source?: string
    }) => {
    const silent = options?.silent === true
    const shouldApply = options?.applyGuard ?? (() => true)
    const interactive = options?.interactive ?? true
    const source = options?.source?.trim() || 'unknown'
    if (isDevPreview) {
      const { stats: devStats, overview: devOverview } = buildDevPreviewUsageSnapshot({
        now: Date.now(),
        usageWindowHours,
        usageFilterNodes,
        usageFilterProviders,
        usageFilterModels,
        usageFilterOrigins,
        config,
      })
      const apply = () => {
        setUsageStatistics(devStats)
        if (devOverview) {
          setUsageOverview(devOverview)
        }
      }
      if (interactive) apply()
      else startTransition(apply)
      return
    }
    if (isDashboardUsageRefreshSource(source)) {
      try {
        const requestKey = JSON.stringify({
          detail_level: 'overview',
          hours: usageWindowHours,
          nodes: usageFilterNodes,
          providers: usageFilterProviders,
          models: usageFilterModels,
          origins: usageFilterOrigins,
        })
        const res = await runSingleFlight(usageOverviewInFlightRef.current, requestKey, () =>
          invoke<UsageStatisticsOverview>('get_usage_statistics', {
            detailLevel: 'overview',
            hours: usageWindowHours,
            nodes: usageFilterNodes.length ? usageFilterNodes : null,
            providers: usageFilterProviders.length ? usageFilterProviders : null,
            models: usageFilterModels.length ? usageFilterModels : null,
            origins: usageFilterOrigins.length ? usageFilterOrigins : null,
          }),
        )
        if (!shouldApply()) return
        const applyOverview = () => setUsageOverview(res)
        if (interactive) applyOverview()
        else startTransition(applyOverview)
      } catch (e) {
        if (!silent) flashToast(String(e), 'error')
      }
      return
    }
    if (!silent) setUsageStatisticsLoading(true)
    recordUiTrace('usage_refresh_requested', {
      source,
      silent,
      interactive,
      hours: usageWindowHours,
      node_filter_count: usageFilterNodes.length,
      provider_filter_count: usageFilterProviders.length,
      model_filter_count: usageFilterModels.length,
      origin_filter_count: usageFilterOrigins.length,
    })
    try {
      const requestKey = JSON.stringify({
        hours: usageWindowHours,
        nodes: usageFilterNodes,
        providers: usageFilterProviders,
        models: usageFilterModels,
        origins: usageFilterOrigins,
      })
      const res = await runSingleFlight(usageStatisticsInFlightRef.current, requestKey, () =>
        invoke<UsageStatistics>('get_usage_statistics', {
          hours: usageWindowHours,
          nodes: usageFilterNodes.length ? usageFilterNodes : null,
          providers: usageFilterProviders.length ? usageFilterProviders : null,
          models: usageFilterModels.length ? usageFilterModels : null,
          origins: usageFilterOrigins.length ? usageFilterOrigins : null,
        }),
      )
      if (!shouldApply()) return
      const overview = buildUsageStatisticsOverviewFromFull(res)
      const apply = () => setUsageStatistics(res)
      if (interactive) apply()
      else startTransition(apply)
      if (overview) {
        const applyOverview = () => setUsageOverview(overview)
        if (interactive) applyOverview()
        else startTransition(applyOverview)
      }
    } catch (e) {
      if (!silent) flashToast(String(e), 'error')
    } finally {
      if (!silent) setUsageStatisticsLoading(false)
    }
  }, [
    isDevPreview,
    config,
    setUsageStatistics,
    usageWindowHours,
    usageFilterNodes,
    usageFilterProviders,
    usageFilterModels,
    usageFilterOrigins,
    setUsageStatisticsLoading,
    flashToast,
    setUsageOverview,
  ])

  const refreshUsageOverview = useCallback(async (options?: {
    silent?: boolean
    applyGuard?: () => boolean
    interactive?: boolean
    source?: string
  }) => {
    const silent = options?.silent === true
    const shouldApply = options?.applyGuard ?? (() => true)
    const interactive = options?.interactive ?? true
    const source = options?.source?.trim() || 'unknown'
    if (isDevPreview) {
      const devStats = buildDevUsageStatistics({
        now: Date.now(),
        usageWindowHours,
        usageFilterNodes,
        usageFilterProviders,
        usageFilterModels,
        usageFilterOrigins,
        config,
      })
      const overview = buildUsageStatisticsOverviewFromFull(devStats)
      if (!overview) return
      const apply = () => setUsageOverview(overview)
      if (interactive) apply()
      else startTransition(apply)
      return
    }
    recordUiTrace('usage_overview_refresh_requested', {
      source,
      silent,
      interactive,
      hours: usageWindowHours,
      node_filter_count: usageFilterNodes.length,
      provider_filter_count: usageFilterProviders.length,
      model_filter_count: usageFilterModels.length,
      origin_filter_count: usageFilterOrigins.length,
    })
    try {
      const requestKey = JSON.stringify({
        detail_level: 'overview',
        hours: usageWindowHours,
        nodes: usageFilterNodes,
        providers: usageFilterProviders,
        models: usageFilterModels,
        origins: usageFilterOrigins,
      })
      const res = await runSingleFlight(usageOverviewInFlightRef.current, requestKey, () =>
        invoke<UsageStatisticsOverview>('get_usage_statistics', {
          detailLevel: 'overview',
          hours: usageWindowHours,
          nodes: usageFilterNodes.length ? usageFilterNodes : null,
          providers: usageFilterProviders.length ? usageFilterProviders : null,
          models: usageFilterModels.length ? usageFilterModels : null,
          origins: usageFilterOrigins.length ? usageFilterOrigins : null,
        }),
      )
      if (!shouldApply()) return
      const apply = () => setUsageOverview(res)
      if (interactive) apply()
      else startTransition(apply)
    } catch (e) {
      if (!silent) flashToast(String(e), 'error')
    }
  }, [
    isDevPreview,
    usageWindowHours,
    usageFilterNodes,
    usageFilterProviders,
    usageFilterModels,
    usageFilterOrigins,
    config,
    setUsageOverview,
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
    refreshUsageOverview,
    refreshUsageStatistics,
    usageCurrencyOptions,
    ...scheduleCore,
    ...pricingHistory,
  }
}
