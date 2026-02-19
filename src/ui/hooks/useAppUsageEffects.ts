import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import type { Config } from '../types'
import type {
  ProviderScheduleDraft,
  UsagePricingDraft,
  UsagePricingSaveState,
  UsageScheduleSaveState,
} from '../types/usage'
import type { SpendHistoryRow } from '../devMockData'

type PricingCurrencyMenuState = {
  provider: string
  providers: string[]
  left: number
  top: number
  width: number
} | null

type ScheduleCurrencyMenuState = {
  rowIndex: number
  left: number
  top: number
  width: number
} | null

type Params = {
  activePage: 'dashboard' | 'usage_statistics' | 'provider_switchboard' | 'event_log'
  refreshUsageStatistics: (options?: { silent?: boolean }) => Promise<void>
  usageWindowHours: number
  usageFilterProviders: string[]
  usageFilterModels: string[]
  usageFilterOrigins: string[]
  isDevPreview: boolean
  refreshFxRatesDaily: (force?: boolean) => Promise<void>
  usagePricingModalOpen: boolean
  usagePricingDraftsPrimedRef: MutableRefObject<boolean>
  closeUsagePricingCurrencyMenu: () => void
  clearAutoSaveTimersByPrefix: (prefix: string) => void
  usagePricingLastSavedSigRef: MutableRefObject<Record<string, string>>
  setUsagePricingSaveState: Dispatch<SetStateAction<Record<string, UsagePricingSaveState>>>
  config: Config | null
  usagePricingProviderNames: string[]
  setUsagePricingDrafts: Dispatch<SetStateAction<Record<string, UsagePricingDraft>>>
  buildUsagePricingDraft: (providerName: string, providerCfg?: Config['providers'][string]) => UsagePricingDraft
  pricingDraftSignature: (draft: UsagePricingDraft) => string
  usageHistoryModalOpen: boolean
  clearAutoSaveTimer: (key: string) => void
  resetUsageHistoryScrollbarState: () => void
  clearUsageHistoryScrollbarTimers: () => void
  usageHistoryLoadedRef: MutableRefObject<boolean>
  refreshUsageHistory: (options?: { silent?: boolean; keepEditCell?: boolean }) => Promise<void>
  refreshUsageHistoryScrollbarUi: () => void
  usageHistoryRows: SpendHistoryRow[]
  scheduleUsageHistoryScrollbarSync: () => void
  usagePricingCurrencyMenu: PricingCurrencyMenuState
  usagePricingCurrencyMenuRef: RefObject<HTMLDivElement | null>
  usageScheduleCurrencyMenu: ScheduleCurrencyMenuState
  usageScheduleCurrencyMenuRef: RefObject<HTMLDivElement | null>
  closeUsageScheduleCurrencyMenu: () => void
  usageScheduleModalOpen: boolean
  usageScheduleLoading: boolean
  usageScheduleSaving: boolean
  scheduleRowsSignature: (rows: ProviderScheduleDraft[]) => string
  usageScheduleRows: ProviderScheduleDraft[]
  usageScheduleLastSavedSigRef: MutableRefObject<string>
  usageScheduleSaveState: UsageScheduleSaveState
  setUsageScheduleSaveState: Dispatch<SetStateAction<UsageScheduleSaveState>>
  setUsageScheduleSaveError: Dispatch<SetStateAction<string>>
  queueAutoSaveTimer: (key: string, callback: () => void, delayMs?: number) => void
  autoSaveUsageScheduleRows: (rows: ProviderScheduleDraft[], signature: string) => Promise<void>
}

export function useAppUsageEffects(params: Params) {
  const usageHistoryPrefetchStartedRef = useRef(false)
  const previousActivePageRef = useRef<Params['activePage'] | null>(null)
  const {
    activePage,
    refreshUsageStatistics,
    usageWindowHours,
    usageFilterProviders,
    usageFilterModels,
    usageFilterOrigins,
    isDevPreview,
    refreshFxRatesDaily,
    usagePricingModalOpen,
    usagePricingDraftsPrimedRef,
    closeUsagePricingCurrencyMenu,
    clearAutoSaveTimersByPrefix,
    usagePricingLastSavedSigRef,
    setUsagePricingSaveState,
    config,
    usagePricingProviderNames,
    setUsagePricingDrafts,
    buildUsagePricingDraft,
    pricingDraftSignature,
    usageHistoryModalOpen,
    clearAutoSaveTimer,
    resetUsageHistoryScrollbarState,
    clearUsageHistoryScrollbarTimers,
    usageHistoryLoadedRef,
    refreshUsageHistory,
    refreshUsageHistoryScrollbarUi,
    usageHistoryRows,
    scheduleUsageHistoryScrollbarSync,
    usagePricingCurrencyMenu,
    usagePricingCurrencyMenuRef,
    usageScheduleCurrencyMenu,
    usageScheduleCurrencyMenuRef,
    closeUsageScheduleCurrencyMenu,
    usageScheduleModalOpen,
    usageScheduleLoading,
    usageScheduleSaving,
    scheduleRowsSignature,
    usageScheduleRows,
    usageScheduleLastSavedSigRef,
    usageScheduleSaveState,
    setUsageScheduleSaveState,
    setUsageScheduleSaveError,
    queueAutoSaveTimer,
    autoSaveUsageScheduleRows,
  } = params
  const refreshUsageHistoryRef = useRef(refreshUsageHistory)

  useEffect(() => {
    refreshUsageHistoryRef.current = refreshUsageHistory
  }, [refreshUsageHistory])

  useEffect(() => {
    if (activePage !== 'usage_statistics') return
    const enteringUsagePage = previousActivePageRef.current !== 'usage_statistics'
    void refreshUsageStatistics({ silent: enteringUsagePage })
    const t = window.setInterval(() => void refreshUsageStatistics({ silent: true }), 15_000)
    return () => window.clearInterval(t)
  }, [activePage, usageWindowHours, usageFilterProviders, usageFilterModels, usageFilterOrigins])

  useEffect(() => {
    previousActivePageRef.current = activePage
  }, [activePage])

  useEffect(() => {
    if (isDevPreview) return
    void refreshFxRatesDaily(false)
  }, [isDevPreview])

  useEffect(() => {
    if (!usagePricingModalOpen) {
      usagePricingDraftsPrimedRef.current = false
      closeUsagePricingCurrencyMenu()
      clearAutoSaveTimersByPrefix('pricing:')
      usagePricingLastSavedSigRef.current = {}
      setUsagePricingSaveState({})
      return
    }
    if (!config) return
    void refreshFxRatesDaily(false)
    if (usagePricingDraftsPrimedRef.current) return
    setUsagePricingDrafts(() => {
      const next: Record<string, UsagePricingDraft> = {}
      usagePricingProviderNames.forEach((providerName) => {
        const providerCfg = config?.providers?.[providerName]
        next[providerName] = buildUsagePricingDraft(providerName, providerCfg)
        usagePricingLastSavedSigRef.current[providerName] = pricingDraftSignature(next[providerName])
      })
      return next
    })
    setUsagePricingSaveState(() => {
      const next: Record<string, UsagePricingSaveState> = {}
      usagePricingProviderNames.forEach((providerName) => {
        next[providerName] = 'saved'
      })
      return next
    })
    usagePricingDraftsPrimedRef.current = true
  }, [usagePricingModalOpen, usagePricingProviderNames, config, closeUsagePricingCurrencyMenu])

  useEffect(() => {
    if (!usagePricingModalOpen || !config || !usagePricingDraftsPrimedRef.current) return
    const providerSet = new Set(usagePricingProviderNames)
    setUsagePricingDrafts((prev) => {
      const next: Record<string, UsagePricingDraft> = { ...prev }
      let changed = false
      usagePricingProviderNames.forEach((providerName) => {
        if (next[providerName]) return
        const providerCfg = config.providers?.[providerName]
        next[providerName] = buildUsagePricingDraft(providerName, providerCfg)
        usagePricingLastSavedSigRef.current[providerName] = pricingDraftSignature(next[providerName])
        changed = true
      })
      Object.keys(next).forEach((providerName) => {
        if (providerSet.has(providerName)) return
        delete next[providerName]
        delete usagePricingLastSavedSigRef.current[providerName]
        changed = true
      })
      return changed ? next : prev
    })
    setUsagePricingSaveState((prev) => {
      const next: Record<string, UsagePricingSaveState> = { ...prev }
      let changed = false
      usagePricingProviderNames.forEach((providerName) => {
        if (next[providerName]) return
        next[providerName] = 'saved'
        changed = true
      })
      Object.keys(next).forEach((providerName) => {
        if (providerSet.has(providerName)) return
        delete next[providerName]
        changed = true
      })
      return changed ? next : prev
    })
  }, [usagePricingModalOpen, usagePricingProviderNames, config])

  useEffect(() => {
    if (usageHistoryPrefetchStartedRef.current) return
    if (usageHistoryLoadedRef.current) return
    usageHistoryPrefetchStartedRef.current = true
    const timer = window.setTimeout(() => {
      if (usageHistoryLoadedRef.current) return
      void refreshUsageHistoryRef.current({ silent: true })
    }, 400)
    return () => {
      window.clearTimeout(timer)
    }
  }, [usageHistoryLoadedRef])

  useEffect(() => {
    if (!usageHistoryModalOpen) {
      clearAutoSaveTimer('history:edit')
      resetUsageHistoryScrollbarState()
      clearUsageHistoryScrollbarTimers()
      return
    }
    const shouldSilentRefresh = usageHistoryLoadedRef.current
    void refreshUsageHistory({ silent: shouldSilentRefresh })
  }, [usageHistoryModalOpen, resetUsageHistoryScrollbarState, clearUsageHistoryScrollbarTimers])

  useEffect(() => {
    if (!usageHistoryModalOpen || typeof window === 'undefined') return
    const frame = window.requestAnimationFrame(() => {
      refreshUsageHistoryScrollbarUi()
    })
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [usageHistoryModalOpen, usageHistoryRows, refreshUsageHistoryScrollbarUi])

  useEffect(() => {
    if (!usageHistoryModalOpen || typeof window === 'undefined') return
    const onResize = () => {
      scheduleUsageHistoryScrollbarSync()
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [usageHistoryModalOpen, scheduleUsageHistoryScrollbarSync])

  useEffect(() => {
    return () => {
      clearUsageHistoryScrollbarTimers()
    }
  }, [clearUsageHistoryScrollbarTimers])

  useEffect(() => {
    if (!usagePricingCurrencyMenu) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        closeUsagePricingCurrencyMenu()
        return
      }
      if (usagePricingCurrencyMenuRef.current?.contains(target)) return
      if (target.closest('.aoUsagePricingCurrencyWrap')) return
      closeUsagePricingCurrencyMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeUsagePricingCurrencyMenu()
    }
    const onViewportChange = () => {
      closeUsagePricingCurrencyMenu()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [usagePricingCurrencyMenu, closeUsagePricingCurrencyMenu])

  useEffect(() => {
    if (!usageScheduleCurrencyMenu) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        closeUsageScheduleCurrencyMenu()
        return
      }
      if (usageScheduleCurrencyMenuRef.current?.contains(target)) return
      if (target.closest('.aoUsageScheduleCurrencyWrap')) return
      closeUsageScheduleCurrencyMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeUsageScheduleCurrencyMenu()
    }
    const onViewportChange = () => {
      closeUsageScheduleCurrencyMenu()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [usageScheduleCurrencyMenu])

  useEffect(() => {
    if (!usageScheduleModalOpen || usageScheduleLoading || usageScheduleSaving) {
      return
    }
    const signature = scheduleRowsSignature(usageScheduleRows)
    if (signature === usageScheduleLastSavedSigRef.current) {
      if (usageScheduleSaveState === 'saving') {
        setUsageScheduleSaveState('saved')
      } else if (usageScheduleSaveState === 'invalid' || usageScheduleSaveState === 'error') {
        setUsageScheduleSaveState('idle')
        setUsageScheduleSaveError('')
      }
      return
    }
    queueAutoSaveTimer('schedule:rows', () => {
      void autoSaveUsageScheduleRows(usageScheduleRows, signature)
    })
    return () => {
      clearAutoSaveTimer('schedule:rows')
    }
  }, [
    usageScheduleModalOpen,
    usageScheduleLoading,
    usageScheduleRows,
    usageScheduleSaving,
    usageScheduleSaveState,
  ])
}
