import { useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { UseProviderActionsParams } from './types'

type ProviderUsageActions = Pick<
  UseProviderActionsParams,
  | 'status'
  | 'isDevPreview'
  | 'usageBaseModal'
  | 'setUsageBaseModal'
  | 'setRefreshingProviders'
  | 'refreshStatus'
  | 'refreshConfig'
  | 'flashToast'
>

export function useProviderUsageActions({
  status,
  isDevPreview,
  usageBaseModal,
  setUsageBaseModal,
  setRefreshingProviders,
  refreshStatus,
  refreshConfig,
  flashToast,
}: ProviderUsageActions) {
  const refreshQuota = useCallback(
    async (name: string) => {
      setRefreshingProviders((prev) => ({ ...prev, [name]: true }))
      try {
        await invoke('refresh_quota_shared', { provider: name })
        await refreshStatus()
        flashToast(`Usage refreshed: ${name}`)
      } catch (e) {
        flashToast(String(e), 'error')
      } finally {
        setRefreshingProviders((prev) => ({ ...prev, [name]: false }))
      }
    },
    [flashToast, refreshStatus, setRefreshingProviders],
  )

  const refreshQuotaAll = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (isDevPreview) return
      try {
        await invoke('refresh_quota_all')
        await refreshStatus()
        if (!opts?.silent) {
          flashToast('Usage refreshed')
        }
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [flashToast, isDevPreview, refreshStatus],
  )

  const saveUsageBaseUrl = useCallback(async () => {
    const provider = usageBaseModal.provider
    const url = usageBaseModal.value.trim()
    if (!provider || !url) return
    try {
      await invoke('set_usage_base_url', { provider, url })
      setUsageBaseModal({
        open: false,
        provider: '',
        value: '',
        auto: false,
        explicitValue: '',
        effectiveValue: '',
      })
      flashToast(`Usage base saved: ${provider}`)
      await refreshConfig()
      await refreshStatus()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [
    flashToast,
    refreshConfig,
    refreshStatus,
    setUsageBaseModal,
    usageBaseModal.provider,
    usageBaseModal.value,
  ])

  const clearUsageBaseUrl = useCallback(
    async (name: string) => {
      try {
        await invoke('clear_usage_base_url', { provider: name })
        flashToast(`Usage base cleared: ${name}`)
        await refreshConfig()
        await refreshStatus()
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  )

  const openUsageBaseModal = useCallback(
    async (provider: string, current: string | null | undefined) => {
      const explicit = (current ?? '').trim()
      const fallbackEffective = status?.quota?.[provider]?.effective_usage_base ?? ''
      setUsageBaseModal({
        open: true,
        provider,
        value: explicit || fallbackEffective,
        auto: !explicit,
        explicitValue: explicit,
        effectiveValue: fallbackEffective,
      })
      if (isDevPreview) return
      try {
        const effective = await invoke<string | null>('get_effective_usage_base', { provider })
        if (!effective) return
        setUsageBaseModal((m) => {
          if (!m.open || m.provider !== provider) return m
          const nextEffective = effective
          const nextValue = m.explicitValue ? m.explicitValue : nextEffective
          return { ...m, value: nextValue, auto: !m.explicitValue, effectiveValue: nextEffective }
        })
      } catch (e) {
        console.warn('Failed to load usage base', e)
      }
    },
    [isDevPreview, setUsageBaseModal, status?.quota],
  )

  return {
    refreshQuota,
    refreshQuotaAll,
    saveUsageBaseUrl,
    clearUsageBaseUrl,
    openUsageBaseModal,
  }
}
