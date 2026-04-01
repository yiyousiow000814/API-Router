import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'

type TopPage =
  | 'dashboard'
  | 'usage_statistics'
  | 'usage_requests'
  | 'provider_switchboard'
  | 'event_log'
  | 'web_codex'

type UseAppPollingOptions = {
  activePage: TopPage
  isDevPreview: boolean
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  refreshStatus: () => Promise<void>
  refreshConfig: () => Promise<void>
  refreshProviderSwitchStatus: () => Promise<void>
  onDevPreviewBootstrap: () => void
  onDevPreviewTick: () => void
}

export function statusPollIntervalMs(activePage: TopPage, isDocumentVisible: boolean): number {
  if (!isDocumentVisible) return 15_000
  if (activePage === 'dashboard' || activePage === 'provider_switchboard') return 1_500
  return 5_000
}

export function useAppPolling({
  activePage,
  isDevPreview,
  codexSwapDir1,
  codexSwapDir2,
  codexSwapUseWindows,
  codexSwapUseWsl,
  refreshStatus,
  refreshConfig,
  refreshProviderSwitchStatus,
  onDevPreviewBootstrap,
  onDevPreviewTick,
}: UseAppPollingOptions) {
  const UI_WATCHDOG_SLOW_REFRESH_AFTER_MS = 2_000
  const refreshStatusRef = useRef(refreshStatus)
  const refreshConfigRef = useRef(refreshConfig)
  const refreshProviderSwitchStatusRef = useRef(refreshProviderSwitchStatus)
  const providerSwitchRefreshTimerRef = useRef<number | null>(null)
  const providerSwitchDirWatcherPrimedRef = useRef<boolean>(false)
  const activePageRef = useRef(activePage)
  const documentVisibleRef = useRef(true)
  const statusRefreshInFlightCountRef = useRef(0)
  const configRefreshInFlightCountRef = useRef(0)
  const providerSwitchRefreshInFlightCountRef = useRef(0)
  const [isDocumentVisible, setIsDocumentVisible] = useState<boolean>(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  )

  useEffect(() => {
    refreshStatusRef.current = refreshStatus
    refreshConfigRef.current = refreshConfig
    refreshProviderSwitchStatusRef.current = refreshProviderSwitchStatus
  }, [refreshConfig, refreshProviderSwitchStatus, refreshStatus])

  useEffect(() => {
    activePageRef.current = activePage
    if (typeof window !== 'undefined') {
      window.__API_ROUTER_ACTIVE_PAGE__ = activePage
    }
  }, [activePage])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const handleVisibilityChange = () => {
      const visible = document.visibilityState !== 'hidden'
      documentVisibleRef.current = visible
      setIsDocumentVisible(visible)
    }
    handleVisibilityChange()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    documentVisibleRef.current = isDocumentVisible
  }, [isDocumentVisible])

  const reportSlowRefresh = (kind: 'status' | 'config' | 'provider_switch', elapsedMs: number) => {
    if (isDevPreview || elapsedMs < UI_WATCHDOG_SLOW_REFRESH_AFTER_MS) {
      return
    }
    void invoke('record_ui_slow_refresh', {
      kind,
      elapsedMs,
      activePage: activePageRef.current,
      visible: documentVisibleRef.current,
    }).catch(() => {})
  }

  const runTrackedRefresh = async (
    kind: 'status' | 'config' | 'provider_switch',
    counterRef: MutableRefObject<number>,
    refresh: () => Promise<void>,
  ) => {
    counterRef.current += 1
    const startedAt =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    try {
      await refresh()
    } finally {
      counterRef.current = Math.max(0, counterRef.current - 1)
      const endedAt =
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      reportSlowRefresh(kind, Math.round(endedAt - startedAt))
    }
  }

  useEffect(() => {
    if (isDevPreview) return
    const timer = window.setInterval(() => {
      void invoke('record_ui_watchdog_heartbeat', {
        activePage: activePageRef.current,
        visible: documentVisibleRef.current,
        statusInFlight: statusRefreshInFlightCountRef.current > 0,
        configInFlight: configRefreshInFlightCountRef.current > 0,
        providerSwitchInFlight: providerSwitchRefreshInFlightCountRef.current > 0,
      }).catch(() => {})
    }, 1000)
    return () => window.clearInterval(timer)
  }, [isDevPreview])

  useEffect(() => {
    if (isDevPreview) {
      onDevPreviewBootstrap()
      const timer = window.setInterval(() => onDevPreviewTick(), 1800)
      void runTrackedRefresh(
        'provider_switch',
        providerSwitchRefreshInFlightCountRef,
        () => refreshProviderSwitchStatusRef.current(),
      )
      return () => window.clearInterval(timer)
    }
    void runTrackedRefresh('status', statusRefreshInFlightCountRef, () => refreshStatusRef.current())
    const t = setInterval(
      () =>
        void runTrackedRefresh('status', statusRefreshInFlightCountRef, () => refreshStatusRef.current()),
      statusPollIntervalMs(activePage, isDocumentVisible),
    )
    const codexRefresh = window.setInterval(() => {
      invoke('codex_account_refresh').catch((e) => {
        console.warn('Codex refresh failed', e)
      })
    }, 5 * 60 * 1000)
    return () => {
      clearInterval(t)
      window.clearInterval(codexRefresh)
    }
  }, [activePage, isDevPreview, isDocumentVisible, onDevPreviewBootstrap, onDevPreviewTick])

  useEffect(() => {
    if (isDevPreview) return
    let cancelled = false
    let timeoutId: number | null = null
    let idleId: number | null = null
    const rafId = window.requestAnimationFrame(() => {
      const runRefreshConfig = () => {
        if (cancelled) return
        void runTrackedRefresh('config', configRefreshInFlightCountRef, () => refreshConfigRef.current())
      }
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(runRefreshConfig, { timeout: 1200 })
        return
      }
      timeoutId = window.setTimeout(runRefreshConfig, 120)
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(rafId)
      if (idleId != null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId)
      }
      if (timeoutId != null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [isDevPreview])

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
      void runTrackedRefresh('provider_switch', providerSwitchRefreshInFlightCountRef, () =>
        refreshProviderSwitchStatusRef.current(),
      )
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
