import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { computeActiveRefreshDelayMs, computeIdleRefreshDelayMs } from '../utils/usageRefresh'

type UseAppPollingOptions = {
  isDevPreview: boolean
  statusLastActivityUnixMs: number | undefined
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  refreshStatus: () => Promise<void>
  refreshConfig: () => Promise<void>
  refreshProviderSwitchStatus: () => Promise<void>
  refreshQuotaAll: (options?: { silent?: boolean }) => Promise<unknown>
  onDevPreviewBootstrap: () => void
}

export function useAppPolling({
  isDevPreview,
  statusLastActivityUnixMs,
  codexSwapDir1,
  codexSwapDir2,
  codexSwapUseWindows,
  codexSwapUseWsl,
  refreshStatus,
  refreshConfig,
  refreshProviderSwitchStatus,
  refreshQuotaAll,
  onDevPreviewBootstrap,
}: UseAppPollingOptions) {
  const refreshStatusRef = useRef(refreshStatus)
  const refreshConfigRef = useRef(refreshConfig)
  const refreshProviderSwitchStatusRef = useRef(refreshProviderSwitchStatus)
  const refreshQuotaAllRef = useRef(refreshQuotaAll)
  const usageRefreshTimerRef = useRef<number | null>(null)
  const idleUsageSchedulerRef = useRef<(() => void) | null>(null)
  const usageActiveRef = useRef<boolean>(false)
  const activeUsageTimerRef = useRef<number | null>(null)
  const providerSwitchRefreshTimerRef = useRef<number | null>(null)
  const providerSwitchDirWatcherPrimedRef = useRef<boolean>(false)

  useEffect(() => {
    refreshStatusRef.current = refreshStatus
    refreshConfigRef.current = refreshConfig
    refreshProviderSwitchStatusRef.current = refreshProviderSwitchStatus
    refreshQuotaAllRef.current = refreshQuotaAll
  }, [refreshConfig, refreshProviderSwitchStatus, refreshQuotaAll, refreshStatus])

  useEffect(() => {
    if (isDevPreview) {
      onDevPreviewBootstrap()
      void refreshProviderSwitchStatusRef.current()
      return
    }
    void refreshStatusRef.current()
    void refreshConfigRef.current()
    const once = window.setTimeout(() => void refreshQuotaAllRef.current({ silent: true }), 850)
    const scheduleUsageRefresh = () => {
      if (usageActiveRef.current) return
      if (usageRefreshTimerRef.current) {
        window.clearTimeout(usageRefreshTimerRef.current)
      }
      const nowMs = Date.now()
      const jitterMs = (Math.random() * 10 - 5) * 60 * 1000
      const delayMs = computeIdleRefreshDelayMs(nowMs, jitterMs)
      usageRefreshTimerRef.current = window.setTimeout(() => {
        if (usageActiveRef.current) {
          if (usageRefreshTimerRef.current) {
            window.clearTimeout(usageRefreshTimerRef.current)
            usageRefreshTimerRef.current = null
          }
          return
        }
        void refreshQuotaAllRef.current({ silent: true }).finally(() => {
          if (!usageActiveRef.current) scheduleUsageRefresh()
        })
      }, delayMs)
    }
    idleUsageSchedulerRef.current = scheduleUsageRefresh
    scheduleUsageRefresh()
    const t = setInterval(() => void refreshStatusRef.current(), 1500)
    const codexRefresh = window.setInterval(() => {
      invoke('codex_account_refresh').catch((e) => {
        console.warn('Codex refresh failed', e)
      })
    }, 5 * 60 * 1000)
    return () => {
      clearInterval(t)
      window.clearInterval(codexRefresh)
      window.clearTimeout(once)
      if (usageRefreshTimerRef.current) {
        window.clearTimeout(usageRefreshTimerRef.current)
      }
      idleUsageSchedulerRef.current = null
    }
  }, [isDevPreview, onDevPreviewBootstrap])

  useEffect(() => {
    if (isDevPreview) return
    const lastActivity = statusLastActivityUnixMs ?? 0
    const isActive = lastActivity > 0 && Date.now() - lastActivity <= 5 * 60 * 1000
    usageActiveRef.current = isActive
    if (isActive && usageRefreshTimerRef.current) {
      window.clearTimeout(usageRefreshTimerRef.current)
      usageRefreshTimerRef.current = null
    }
    const clearActiveTimer = () => {
      if (activeUsageTimerRef.current) {
        window.clearTimeout(activeUsageTimerRef.current)
        activeUsageTimerRef.current = null
      }
    }
    if (!isActive) {
      clearActiveTimer()
      if (!usageRefreshTimerRef.current && idleUsageSchedulerRef.current) idleUsageSchedulerRef.current()
      return
    }
    if (!activeUsageTimerRef.current) {
      const schedule = () => {
        const jitterMs = (Math.random() * 2 - 1) * 60 * 1000
        const delayMs = computeActiveRefreshDelayMs(jitterMs)
        activeUsageTimerRef.current = window.setTimeout(() => {
          if (!usageActiveRef.current) {
            if (idleUsageSchedulerRef.current) idleUsageSchedulerRef.current()
            return
          }
          void refreshQuotaAllRef.current({ silent: true }).finally(() => {
            if (usageActiveRef.current) schedule()
          })
        }, delayMs)
      }
      schedule()
    }
  }, [isDevPreview, statusLastActivityUnixMs])

  useEffect(() => {
    return () => {
      if (activeUsageTimerRef.current) {
        window.clearTimeout(activeUsageTimerRef.current)
        activeUsageTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!providerSwitchDirWatcherPrimedRef.current) {
      providerSwitchDirWatcherPrimedRef.current = true
      return
    }
    if (providerSwitchRefreshTimerRef.current) {
      window.clearTimeout(providerSwitchRefreshTimerRef.current)
      providerSwitchRefreshTimerRef.current = null
    }
    providerSwitchRefreshTimerRef.current = window.setTimeout(() => {
      void refreshProviderSwitchStatusRef.current()
      providerSwitchRefreshTimerRef.current = null
    }, 220)
    return () => {
      if (providerSwitchRefreshTimerRef.current) {
        window.clearTimeout(providerSwitchRefreshTimerRef.current)
        providerSwitchRefreshTimerRef.current = null
      }
    }
  }, [codexSwapUseWindows, codexSwapUseWsl, codexSwapDir1, codexSwapDir2])
}
