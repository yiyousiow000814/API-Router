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
  codexSwapModalOpen: boolean
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  runPrimaryRefresh: (
    key: string,
    owner: TopPage | 'any',
    run: (guard: () => boolean) => Promise<void> | void,
  ) => Promise<void>
  enqueueBackgroundRefresh: (
    key: string,
    owner: TopPage | 'any',
    run: (guard: () => boolean) => Promise<void> | void,
  ) => void
  refreshStatus: (options?: {
    refreshSwapStatus?: boolean
    swapStatusSource?: string
    applyGuard?: () => boolean
    interactive?: boolean
    source?: string
  }) => Promise<void>
  refreshConfig: (options?: {
    refreshProviderSwitchStatus?: boolean
    applyGuard?: () => boolean
    interactive?: boolean
  }) => Promise<void>
  refreshProviderSwitchStatus: (
    cliHomes?: string[],
    options?: { applyGuard?: () => boolean; interactive?: boolean },
  ) => Promise<void>
  refreshGatewayTokenPreview: (options?: {
    applyGuard?: () => boolean
    interactive?: boolean
    source?: string
  }) => Promise<void>
  onDevPreviewBootstrap: () => void
  onDevPreviewTick: () => void
}

export function statusPollIntervalMs(activePage: TopPage, isDocumentVisible: boolean): number {
  if (!isDocumentVisible) return 15_000
  if (activePage === 'dashboard' || activePage === 'provider_switchboard') return 1_500
  return 5_000
}

export function shouldPollSwapStatusOnStatusRefresh(
  activePage: TopPage,
  codexSwapModalOpen: boolean,
): boolean {
  return codexSwapModalOpen || activePage === 'provider_switchboard'
}

export function useAppPolling({
  activePage,
  isDevPreview,
  codexSwapModalOpen,
  codexSwapDir1,
  codexSwapDir2,
  codexSwapUseWindows,
  codexSwapUseWsl,
  runPrimaryRefresh,
  enqueueBackgroundRefresh,
  refreshStatus,
  refreshConfig,
  refreshProviderSwitchStatus,
  refreshGatewayTokenPreview,
  onDevPreviewBootstrap,
  onDevPreviewTick,
}: UseAppPollingOptions) {
  const UI_WATCHDOG_SLOW_REFRESH_AFTER_MS = 2_000
  const onDevPreviewBootstrapRef = useRef(onDevPreviewBootstrap)
  const onDevPreviewTickRef = useRef(onDevPreviewTick)
  const runPrimaryRefreshRef = useRef(runPrimaryRefresh)
  const enqueueBackgroundRefreshRef = useRef(enqueueBackgroundRefresh)
  const refreshGatewayTokenPreviewRef = useRef(refreshGatewayTokenPreview)
  const refreshStatusRef = useRef(refreshStatus)
  const refreshConfigRef = useRef(refreshConfig)
  const refreshProviderSwitchStatusRef = useRef(refreshProviderSwitchStatus)
  const providerSwitchRefreshTimerRef = useRef<number | null>(null)
  const providerSwitchDirWatcherPrimedRef = useRef<boolean>(false)
  const activePageRef = useRef(activePage)
  const documentVisibleRef = useRef(true)
  const statusBootstrappedRef = useRef(false)
  const previousVisibleRef = useRef<boolean>(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  )
  const statusRefreshInFlightCountRef = useRef(0)
  const configRefreshInFlightCountRef = useRef(0)
  const providerSwitchRefreshInFlightCountRef = useRef(0)
  const [isDocumentVisible, setIsDocumentVisible] = useState<boolean>(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  )

  useEffect(() => {
    onDevPreviewBootstrapRef.current = onDevPreviewBootstrap
    onDevPreviewTickRef.current = onDevPreviewTick
    runPrimaryRefreshRef.current = runPrimaryRefresh
    enqueueBackgroundRefreshRef.current = enqueueBackgroundRefresh
    refreshGatewayTokenPreviewRef.current = refreshGatewayTokenPreview
    refreshStatusRef.current = refreshStatus
    refreshConfigRef.current = refreshConfig
    refreshProviderSwitchStatusRef.current = refreshProviderSwitchStatus
  }, [
    enqueueBackgroundRefresh,
    onDevPreviewBootstrap,
    onDevPreviewTick,
    refreshConfig,
    refreshGatewayTokenPreview,
    refreshProviderSwitchStatus,
    refreshStatus,
    runPrimaryRefresh,
  ])

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
      onDevPreviewBootstrapRef.current()
      const timer = window.setInterval(() => onDevPreviewTickRef.current(), 1800)
      enqueueBackgroundRefreshRef.current('provider-switch:dev-preview', 'any', (guard) =>
        runTrackedRefresh('provider_switch', providerSwitchRefreshInFlightCountRef, () =>
          refreshProviderSwitchStatusRef.current(undefined, {
            applyGuard: guard,
            interactive: false,
          }),
        ),
      )
      return () => window.clearInterval(timer)
    }
    const shouldRunImmediateStatusRefresh =
      !statusBootstrappedRef.current || (!previousVisibleRef.current && isDocumentVisible)
    statusBootstrappedRef.current = true
    previousVisibleRef.current = isDocumentVisible
    if (shouldRunImmediateStatusRefresh) {
      void runPrimaryRefreshRef.current('status:poll', 'any', (guard) =>
        runTrackedRefresh('status', statusRefreshInFlightCountRef, () =>
          refreshStatusRef.current({
            source: 'status_poll_bootstrap',
            applyGuard: guard,
            interactive: false,
            refreshSwapStatus: shouldPollSwapStatusOnStatusRefresh(
              activePageRef.current,
              codexSwapModalOpen,
            ),
            swapStatusSource: 'status_poll_bootstrap:swap',
          }),
        ),
      )
    }
    const t = setInterval(
      () =>
        void runPrimaryRefreshRef.current('status:poll', 'any', (guard) =>
          runTrackedRefresh('status', statusRefreshInFlightCountRef, () =>
            refreshStatusRef.current({
              source: 'status_poll_interval',
              applyGuard: guard,
              interactive: false,
              refreshSwapStatus: shouldPollSwapStatusOnStatusRefresh(
                activePageRef.current,
                codexSwapModalOpen,
              ),
              swapStatusSource: 'status_poll_interval:swap',
            }),
          ),
        ),
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
  }, [activePage, codexSwapModalOpen, isDevPreview, isDocumentVisible])

  useEffect(() => {
    if (isDevPreview) return
    enqueueBackgroundRefreshRef.current('config:startup', 'any', (guard) =>
      runTrackedRefresh('config', configRefreshInFlightCountRef, () =>
        refreshConfigRef.current({
          refreshProviderSwitchStatus: false,
          applyGuard: guard,
          interactive: false,
        }),
      ),
    )
    enqueueBackgroundRefreshRef.current('gateway-token-preview:startup', 'any', (guard) =>
      refreshGatewayTokenPreviewRef.current({
        applyGuard: guard,
        interactive: false,
        source: 'startup_prefetch',
      }),
    )
  }, [isDevPreview])

  useEffect(() => {
    if (isDevPreview) return
    if (activePage !== 'provider_switchboard' && !codexSwapModalOpen) return
    const timer = window.setTimeout(() => {
      enqueueBackgroundRefreshRef.current('provider-switch:page', 'any', (guard) =>
        runTrackedRefresh('provider_switch', providerSwitchRefreshInFlightCountRef, () =>
          refreshProviderSwitchStatusRef.current(undefined, {
            applyGuard: guard,
            interactive: false,
          }),
        ),
      )
    }, 140)
    return () => {
      window.clearTimeout(timer)
    }
  }, [activePage, codexSwapModalOpen, isDevPreview])

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
      enqueueBackgroundRefreshRef.current('provider-switch:dirs', 'any', (guard) =>
        runTrackedRefresh('provider_switch', providerSwitchRefreshInFlightCountRef, () =>
          refreshProviderSwitchStatusRef.current(undefined, {
            applyGuard: guard,
            interactive: false,
          }),
        ),
      )
      providerSwitchRefreshTimerRef.current = null
    }, 220)
    return () => {
      if (providerSwitchRefreshTimerRef.current) {
        window.clearTimeout(providerSwitchRefreshTimerRef.current)
        providerSwitchRefreshTimerRef.current = null
      }
    }
  }, [codexSwapDir1, codexSwapDir2, codexSwapUseWindows, codexSwapUseWsl])
}
