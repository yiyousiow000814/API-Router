import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'

type UseAppPollingOptions = {
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

export function useAppPolling({
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
  const refreshStatusRef = useRef(refreshStatus)
  const refreshConfigRef = useRef(refreshConfig)
  const refreshProviderSwitchStatusRef = useRef(refreshProviderSwitchStatus)
  const providerSwitchRefreshTimerRef = useRef<number | null>(null)
  const providerSwitchDirWatcherPrimedRef = useRef<boolean>(false)

  useEffect(() => {
    refreshStatusRef.current = refreshStatus
    refreshConfigRef.current = refreshConfig
    refreshProviderSwitchStatusRef.current = refreshProviderSwitchStatus
  }, [refreshConfig, refreshProviderSwitchStatus, refreshStatus])

  useEffect(() => {
    if (isDevPreview) {
      onDevPreviewBootstrap()
      const timer = window.setInterval(() => onDevPreviewTick(), 1800)
      void refreshProviderSwitchStatusRef.current()
      return () => window.clearInterval(timer)
    }
    void refreshStatusRef.current()
    void refreshConfigRef.current()
    const t = setInterval(() => void refreshStatusRef.current(), 1500)
    const codexRefresh = window.setInterval(() => {
      invoke('codex_account_refresh').catch((e) => {
        console.warn('Codex refresh failed', e)
      })
    }, 5 * 60 * 1000)
    return () => {
      clearInterval(t)
      window.clearInterval(codexRefresh)
    }
  }, [isDevPreview, onDevPreviewBootstrap, onDevPreviewTick])

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
