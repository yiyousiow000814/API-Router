import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import type { Config, Status } from '../types'
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

type ActivePage =
  | 'dashboard'
  | 'usage_statistics'
  | 'usage_requests'
  | 'provider_switchboard'
  | 'event_log'
  | 'web_codex'

type Params = {
  activePage: ActivePage
  enqueueBackgroundRefresh: (
    key: string,
    owner: ActivePage | 'any',
    run: (guard: () => boolean) => Promise<void> | void,
  ) => void
  refreshUsageStatistics: (options?: {
    silent?: boolean
    applyGuard?: () => boolean
    interactive?: boolean
    source?: string
  }) => Promise<void>
  usageWindowHours: number
  usageFilterNodes: string[]
  usageFilterProviders: string[]
  usageFilterModels: string[]
  usageFilterOrigins: string[]
  hasUsageStatistics: boolean
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
  usageHistoryQuotaRefreshToken: string
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

export function buildUsageHistoryQuotaRefreshToken(
  quota: Status['quota'] | null | undefined,
): string {
  if (!quota) return ''
  return Object.entries(quota)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, snapshot]) => {
      const updatedAt = snapshot?.updated_at_unix_ms ?? 0
      const appliedAt = snapshot?.applied_at_unix_ms ?? 0
      const spent = snapshot?.daily_spent_usd ?? null
      return `${provider}:${updatedAt}:${appliedAt}:${spent ?? 'null'}`
    })
    .join('|')
}

export function usageStatisticsRefreshIntervalMs(
  activePage: ActivePage,
): number | null {
  if (activePage === 'usage_statistics') return 15_000
  if (activePage === 'dashboard') return 60_000
  return null
}

export function shouldRefreshUsageSilently(
  previousActivePage: ActivePage | null,
  activePage: ActivePage,
  hasUsageStatistics: boolean,
): boolean {
  return previousActivePage !== activePage && hasUsageStatistics
}

function scheduleDeferredUiRefresh(run: () => void, delayMs: number): () => void {
  if (typeof window === 'undefined') {
    run()
    return () => {}
  }
  let cancelled = false
  let idleId: number | null = null
  let timerId: number | null = null
  const execute = () => {
    if (cancelled) return
    run()
  }
  if (typeof window.requestIdleCallback === 'function') {
    idleId = window.requestIdleCallback(execute, { timeout: delayMs })
  } else {
    timerId = window.setTimeout(execute, delayMs)
  }
  return () => {
    cancelled = true
    if (idleId != null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId)
    }
    if (timerId != null) {
      window.clearTimeout(timerId)
    }
  }
}

export function useAppUsageEffects(params: Params) {
  const previousActivePageRef = useRef<ActivePage | null>(null)
  const refreshUsageStatisticsRef = useRef(params.refreshUsageStatistics)
  const {
    activePage,
    enqueueBackgroundRefresh,
    refreshUsageStatistics,
    usageWindowHours,
    usageFilterNodes,
    usageFilterProviders,
    usageFilterModels,
    usageFilterOrigins,
    hasUsageStatistics,
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
    usageHistoryQuotaRefreshToken,
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
    refreshUsageStatisticsRef.current = refreshUsageStatistics
  }, [refreshUsageStatistics])

  useEffect(() => {
    refreshUsageHistoryRef.current = refreshUsageHistory
  }, [refreshUsageHistory])

  useEffect(() => {
    const refreshMs = usageStatisticsRefreshIntervalMs(activePage)
    if (refreshMs == null) return
    const silent = shouldRefreshUsageSilently(
      previousActivePageRef.current,
      activePage,
      hasUsageStatistics,
    )
    const isInitialDashboardBoot =
      previousActivePageRef.current == null && activePage === 'dashboard'
    const scheduleRefresh = (nextSilent: boolean, source: string) =>
      enqueueBackgroundRefresh(`usage:${activePage}`, activePage, (guard) =>
        refreshUsageStatisticsRef.current({
          silent: nextSilent,
          applyGuard: guard,
          interactive: false,
          source,
        }),
      )
    const initialDelayMs = isInitialDashboardBoot ? 350 : 140
    const cancelInitialRefresh = scheduleDeferredUiRefresh(() => {
      scheduleRefresh(
        silent,
        isInitialDashboardBoot
          ? `usage_page_bootstrap:${activePage}`
          : `usage_page_entry:${activePage}`,
      )
    }, initialDelayMs)
    const t = window.setInterval(
      () => scheduleRefresh(true, `usage_page_interval:${activePage}`),
      refreshMs,
    )
    return () => {
      window.clearInterval(t)
      cancelInitialRefresh()
    }
  }, [
    activePage,
    enqueueBackgroundRefresh,
    usageFilterModels,
    usageFilterNodes,
    usageFilterOrigins,
    usageFilterProviders,
    usageWindowHours,
  ])

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
    if (!usageHistoryModalOpen) return
    if (!usageHistoryLoadedRef.current) return
    if (!usageHistoryQuotaRefreshToken) return
    void refreshUsageHistory({ silent: true })
  }, [usageHistoryModalOpen, usageHistoryQuotaRefreshToken, refreshUsageHistory])

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
