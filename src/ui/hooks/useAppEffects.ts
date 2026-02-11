import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { computeActiveRefreshDelayMs, computeIdleRefreshDelayMs } from '../utils/usageRefresh'
import { devConfig, devStatus } from '../utils/devPreviewState'
import type { UsagePricingDraft, UsagePricingSaveState } from '../appTypes'

type Params = {
  isDevPreview: boolean
  activePage: 'dashboard' | 'usage_statistics' | 'provider_switchboard'
  statusLastActivityUnixMs?: number
  usageWindowHours: number
  usageFilterProviders: string[]
  usageFilterModels: string[]
  usagePricingModalOpen: boolean
  usagePricingProviderNames: string[]
  usageHistoryModalOpen: boolean
  usageScheduleCurrencyMenu: unknown
  usagePricingCurrencyMenu: unknown
  usageScheduleModalOpen: boolean
  usageScheduleLoading: boolean
  usageScheduleSaving: boolean
  usageScheduleRows: any[]
  usageScheduleSaveState: string
  config: any
  setStatus: (value: any) => void
  setConfig: (value: any) => void
  setBaselineBaseUrls: (value: Record<string, string>) => void
  setGatewayTokenPreview: (value: string) => void
  refreshProviderSwitchStatus: () => Promise<void>
  refreshStatus: () => Promise<void>
  refreshConfig: () => Promise<void>
  refreshQuotaAll: (options?: { silent?: boolean }) => Promise<void>
  usageActiveRef: React.MutableRefObject<boolean>
  usageRefreshTimerRef: React.MutableRefObject<number | null>
  idleUsageSchedulerRef: React.MutableRefObject<(() => void) | null>
  activeUsageTimerRef: React.MutableRefObject<number | null>
  providerSwitchDirWatcherPrimedRef: React.MutableRefObject<boolean>
  providerSwitchRefreshTimerRef: React.MutableRefObject<number | null>
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapApplyBoth: boolean
  refreshUsageStatistics: (options?: { silent?: boolean }) => Promise<void>
  refreshFxRatesDaily: (force?: boolean) => Promise<void>
  usagePricingDraftsPrimedRef: React.MutableRefObject<boolean>
  closeUsagePricingCurrencyMenu: () => void
  clearAutoSaveTimersByPrefix: (prefix: string) => void
  usagePricingLastSavedSigRef: React.MutableRefObject<Record<string, string>>
  setUsagePricingSaveState: React.Dispatch<React.SetStateAction<Record<string, UsagePricingSaveState>>>
  setUsagePricingDrafts: React.Dispatch<React.SetStateAction<Record<string, UsagePricingDraft>>>
  buildUsagePricingDraft: (providerName: string, providerCfg?: any) => UsagePricingDraft
  pricingDraftSignature: (draft: UsagePricingDraft) => string
  usageHistoryLoadedRef: React.MutableRefObject<boolean>
  clearAutoSaveTimer: (key: string) => void
  usageHistoryScrollbar: {
    clearRuntime: () => void
    setVisible: (visible: boolean) => void
    refreshUi: () => void
    scheduleSync: () => void
  }
  refreshUsageHistory: (options?: { silent?: boolean; keepEditCell?: boolean }) => Promise<void>
  usageHistoryRows: any[]
  usagePricingCurrencyMenuRef: React.RefObject<HTMLDivElement | null>
  closeUsageScheduleCurrencyMenu: () => void
  usageScheduleCurrencyMenuRef: React.RefObject<HTMLDivElement | null>
  usageScheduleLastSavedSigRef: React.MutableRefObject<string>
  setUsageScheduleSaveState: React.Dispatch<React.SetStateAction<any>>
  setUsageScheduleSaveError: React.Dispatch<React.SetStateAction<string>>
  queueAutoSaveTimer: (key: string, callback: () => void, delayMs?: number) => void
  autoSaveUsageScheduleRows: (rows: any[], signature: string) => Promise<void>
  scheduleRowsSignature: (rows: any[]) => string
}

export function useAppEffects(params: Params) {
  useEffect(() => {
    if (params.isDevPreview) {
      params.setStatus(devStatus)
      params.setConfig(devConfig)
      params.setBaselineBaseUrls(
        Object.fromEntries(Object.entries(devConfig.providers).map(([name, p]) => [name, p.base_url])),
      )
      params.setGatewayTokenPreview('ao_dev********7f2a')
      void params.refreshProviderSwitchStatus()
      return
    }
    void params.refreshStatus()
    void params.refreshConfig()
    const once = window.setTimeout(() => void params.refreshQuotaAll({ silent: true }), 850)
    const scheduleUsageRefresh = () => {
      if (params.usageActiveRef.current) return
      if (params.usageRefreshTimerRef.current) {
        window.clearTimeout(params.usageRefreshTimerRef.current)
      }
      const delayMs = computeIdleRefreshDelayMs(Date.now(), (Math.random() * 10 - 5) * 60 * 1000)
      params.usageRefreshTimerRef.current = window.setTimeout(() => {
        if (params.usageActiveRef.current) {
          if (params.usageRefreshTimerRef.current) {
            window.clearTimeout(params.usageRefreshTimerRef.current)
            params.usageRefreshTimerRef.current = null
          }
          return
        }
        void params.refreshQuotaAll({ silent: true }).finally(() => {
          if (!params.usageActiveRef.current) scheduleUsageRefresh()
        })
      }, delayMs)
    }
    params.idleUsageSchedulerRef.current = scheduleUsageRefresh
    scheduleUsageRefresh()
    const statusTimer = window.setInterval(() => void params.refreshStatus(), 1500)
    const codexRefresh = window.setInterval(() => {
      invoke('codex_account_refresh').catch(() => {})
    }, 5 * 60 * 1000)
    return () => {
      window.clearInterval(statusTimer)
      window.clearInterval(codexRefresh)
      window.clearTimeout(once)
      if (params.usageRefreshTimerRef.current) window.clearTimeout(params.usageRefreshTimerRef.current)
      params.idleUsageSchedulerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (params.isDevPreview) return
    const isActive =
      (params.statusLastActivityUnixMs ?? 0) > 0 && Date.now() - (params.statusLastActivityUnixMs ?? 0) <= 5 * 60 * 1000
    params.usageActiveRef.current = isActive
    if (isActive && params.usageRefreshTimerRef.current) {
      window.clearTimeout(params.usageRefreshTimerRef.current)
      params.usageRefreshTimerRef.current = null
    }
    const clearActiveTimer = () => {
      if (params.activeUsageTimerRef.current) {
        window.clearTimeout(params.activeUsageTimerRef.current)
        params.activeUsageTimerRef.current = null
      }
    }
    if (!isActive) {
      clearActiveTimer()
      if (!params.usageRefreshTimerRef.current && params.idleUsageSchedulerRef.current) {
        params.idleUsageSchedulerRef.current()
      }
      return
    }
    if (!params.activeUsageTimerRef.current) {
      const schedule = () => {
        const delayMs = computeActiveRefreshDelayMs((Math.random() * 2 - 1) * 60 * 1000)
        params.activeUsageTimerRef.current = window.setTimeout(() => {
          if (!params.usageActiveRef.current) {
            if (params.idleUsageSchedulerRef.current) params.idleUsageSchedulerRef.current()
            return
          }
          void params.refreshQuotaAll({ silent: true }).finally(() => {
            if (params.usageActiveRef.current) schedule()
          })
        }, delayMs)
      }
      schedule()
    }
    return () => clearActiveTimer()
  }, [params.isDevPreview, params.statusLastActivityUnixMs])

  useEffect(() => {
    if (!params.providerSwitchDirWatcherPrimedRef.current) {
      params.providerSwitchDirWatcherPrimedRef.current = true
      return
    }
    if (params.providerSwitchRefreshTimerRef.current) {
      window.clearTimeout(params.providerSwitchRefreshTimerRef.current)
      params.providerSwitchRefreshTimerRef.current = null
    }
    params.providerSwitchRefreshTimerRef.current = window.setTimeout(() => {
      void params.refreshProviderSwitchStatus()
      params.providerSwitchRefreshTimerRef.current = null
    }, 220)
    return () => {
      if (params.providerSwitchRefreshTimerRef.current) {
        window.clearTimeout(params.providerSwitchRefreshTimerRef.current)
        params.providerSwitchRefreshTimerRef.current = null
      }
    }
  }, [params.codexSwapDir1, params.codexSwapDir2, params.codexSwapApplyBoth])

  useEffect(() => {
    if (params.activePage !== 'usage_statistics') return
    void params.refreshUsageStatistics()
    const timer = window.setInterval(() => void params.refreshUsageStatistics({ silent: true }), 15_000)
    return () => window.clearInterval(timer)
  }, [params.activePage, params.usageWindowHours, params.usageFilterProviders, params.usageFilterModels])

  useEffect(() => {
    if (params.isDevPreview) return
    void params.refreshFxRatesDaily(false)
  }, [params.isDevPreview])

  useEffect(() => {
    if (!params.usagePricingModalOpen) {
      params.usagePricingDraftsPrimedRef.current = false
      params.closeUsagePricingCurrencyMenu()
      params.clearAutoSaveTimersByPrefix('pricing:')
      params.usagePricingLastSavedSigRef.current = {}
      params.setUsagePricingSaveState({})
      return
    }
    if (!params.config) return
    void params.refreshFxRatesDaily(false)
    if (params.usagePricingDraftsPrimedRef.current) return
    params.setUsagePricingDrafts(() => {
      const next: Record<string, UsagePricingDraft> = {}
      params.usagePricingProviderNames.forEach((providerName) => {
        const providerCfg = params.config?.providers?.[providerName]
        next[providerName] = params.buildUsagePricingDraft(providerName, providerCfg)
        params.usagePricingLastSavedSigRef.current[providerName] = params.pricingDraftSignature(next[providerName])
      })
      return next
    })
    params.setUsagePricingSaveState(() =>
      Object.fromEntries(params.usagePricingProviderNames.map((providerName) => [providerName, 'saved'])),
    )
    params.usagePricingDraftsPrimedRef.current = true
  }, [params.usagePricingModalOpen, params.usagePricingProviderNames, params.config, params.closeUsagePricingCurrencyMenu])

  useEffect(() => {
    if (!params.usagePricingModalOpen || !params.config || !params.usagePricingDraftsPrimedRef.current) return
    const providerSet = new Set(params.usagePricingProviderNames)
    params.setUsagePricingDrafts((previous) => {
      const next: Record<string, UsagePricingDraft> = { ...previous }
      let changed = false
      params.usagePricingProviderNames.forEach((providerName) => {
        if (next[providerName]) return
        const providerCfg = params.config.providers?.[providerName]
        next[providerName] = params.buildUsagePricingDraft(providerName, providerCfg)
        params.usagePricingLastSavedSigRef.current[providerName] = params.pricingDraftSignature(next[providerName])
        changed = true
      })
      Object.keys(next).forEach((providerName) => {
        if (providerSet.has(providerName)) return
        delete next[providerName]
        delete params.usagePricingLastSavedSigRef.current[providerName]
        changed = true
      })
      return changed ? next : previous
    })
    params.setUsagePricingSaveState((previous) => {
      const next: Record<string, UsagePricingSaveState> = { ...previous }
      let changed = false
      params.usagePricingProviderNames.forEach((providerName) => {
        if (next[providerName]) return
        next[providerName] = 'saved'
        changed = true
      })
      Object.keys(next).forEach((providerName) => {
        if (providerSet.has(providerName)) return
        delete next[providerName]
        changed = true
      })
      return changed ? next : previous
    })
  }, [params.usagePricingModalOpen, params.usagePricingProviderNames, params.config])

  useEffect(() => {
    if (!params.usageHistoryModalOpen) {
      params.clearAutoSaveTimer('history:edit')
      params.usageHistoryScrollbar.clearRuntime()
      params.usageHistoryScrollbar.setVisible(false)
      return
    }
    void params.refreshUsageHistory({ silent: params.usageHistoryLoadedRef.current })
  }, [params.usageHistoryModalOpen, params.usageHistoryScrollbar])

  useEffect(() => {
    if (!params.usageHistoryModalOpen || typeof window === 'undefined') return
    const frame = window.requestAnimationFrame(() => params.usageHistoryScrollbar.refreshUi())
    return () => window.cancelAnimationFrame(frame)
  }, [params.usageHistoryModalOpen, params.usageHistoryRows, params.usageHistoryScrollbar])

  useEffect(() => {
    if (!params.usageHistoryModalOpen || typeof window === 'undefined') return
    const onResize = () => params.usageHistoryScrollbar.scheduleSync()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [params.usageHistoryModalOpen, params.usageHistoryScrollbar])

  useEffect(() => () => params.usageHistoryScrollbar.clearRuntime(), [params.usageHistoryScrollbar])

  useEffect(() => {
    if (!params.usagePricingCurrencyMenu) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return params.closeUsagePricingCurrencyMenu()
      if (params.usagePricingCurrencyMenuRef.current?.contains(target)) return
      if (target.closest('.aoUsagePricingCurrencyWrap')) return
      params.closeUsagePricingCurrencyMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') params.closeUsagePricingCurrencyMenu()
    }
    const onViewportChange = () => params.closeUsagePricingCurrencyMenu()
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [params.usagePricingCurrencyMenu, params.closeUsagePricingCurrencyMenu])

  useEffect(() => {
    if (!params.usageScheduleCurrencyMenu) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return params.closeUsageScheduleCurrencyMenu()
      if (params.usageScheduleCurrencyMenuRef.current?.contains(target)) return
      if (target.closest('.aoUsageScheduleCurrencyWrap')) return
      params.closeUsageScheduleCurrencyMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') params.closeUsageScheduleCurrencyMenu()
    }
    const onViewportChange = () => params.closeUsageScheduleCurrencyMenu()
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [params.usageScheduleCurrencyMenu])

  useEffect(() => {
    if (!params.usageScheduleModalOpen || params.usageScheduleLoading || params.usageScheduleSaving) return
    const signature = params.scheduleRowsSignature(params.usageScheduleRows)
    if (signature === params.usageScheduleLastSavedSigRef.current) {
      if (params.usageScheduleSaveState === 'saving') {
        params.setUsageScheduleSaveState('saved')
      } else if (params.usageScheduleSaveState === 'invalid' || params.usageScheduleSaveState === 'error') {
        params.setUsageScheduleSaveState('idle')
        params.setUsageScheduleSaveError('')
      }
      return
    }
    params.queueAutoSaveTimer('schedule:rows', () => {
      void params.autoSaveUsageScheduleRows(params.usageScheduleRows, signature)
    })
    return () => {
      params.clearAutoSaveTimer('schedule:rows')
    }
  }, [
    params.usageScheduleModalOpen,
    params.usageScheduleLoading,
    params.usageScheduleRows,
    params.usageScheduleSaving,
    params.usageScheduleSaveState,
  ])
}
