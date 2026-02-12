import { useEffect } from 'react'

type Params = Record<string, any>

export function useAppUsageEffects(params: Params) {
  const {
    activePage,
    refreshUsageStatistics,
    usageWindowHours,
    usageFilterProviders,
    usageFilterModels,
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

  useEffect(() => {
    if (activePage !== 'usage_statistics') return
    void refreshUsageStatistics()
    const t = window.setInterval(() => void refreshUsageStatistics({ silent: true }), 15_000)
    return () => window.clearInterval(t)
  }, [activePage, usageWindowHours, usageFilterProviders, usageFilterModels])

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
      const next: Record<string, any> = {}
      usagePricingProviderNames.forEach((providerName: string) => {
        const providerCfg = config?.providers?.[providerName]
        next[providerName] = buildUsagePricingDraft(providerName, providerCfg)
        usagePricingLastSavedSigRef.current[providerName] = pricingDraftSignature(next[providerName])
      })
      return next
    })
    setUsagePricingSaveState(() => {
      const next: Record<string, any> = {}
      usagePricingProviderNames.forEach((providerName: string) => {
        next[providerName] = 'saved'
      })
      return next
    })
    usagePricingDraftsPrimedRef.current = true
  }, [usagePricingModalOpen, usagePricingProviderNames, config, closeUsagePricingCurrencyMenu])

  useEffect(() => {
    if (!usagePricingModalOpen || !config || !usagePricingDraftsPrimedRef.current) return
    const providerSet = new Set(usagePricingProviderNames)
    setUsagePricingDrafts((prev: Record<string, any>) => {
      const next: Record<string, any> = { ...prev }
      let changed = false
      usagePricingProviderNames.forEach((providerName: string) => {
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
    setUsagePricingSaveState((prev: Record<string, any>) => {
      const next: Record<string, any> = { ...prev }
      let changed = false
      usagePricingProviderNames.forEach((providerName: string) => {
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
