import { useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { UseProviderActionsParams } from './types'

type ProviderKeyActions = Pick<
  UseProviderActionsParams,
  'keyModal' | 'isDevPreview' | 'setKeyModal' | 'refreshStatus' | 'refreshConfig' | 'flashToast'
>

export function useProviderKeyActions({
  keyModal,
  isDevPreview,
  setKeyModal,
  refreshStatus,
  refreshConfig,
  flashToast,
}: ProviderKeyActions) {
  const saveKey = useCallback(async () => {
    const provider = keyModal.provider
    const key = keyModal.value
    if (!provider || !key) return
    try {
      await invoke('set_provider_key', { provider, key })
      setKeyModal({ open: false, provider: '', value: '' })
      flashToast(`Key set: ${provider}`)
      try {
        await invoke('probe_provider', { provider })
      } catch (e) {
        flashToast(String(e), 'error')
      }
      try {
        await invoke('refresh_quota', { provider })
      } catch (e) {
        flashToast(String(e), 'error')
      }
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [flashToast, keyModal.provider, keyModal.value, refreshConfig, refreshStatus, setKeyModal])

  const clearKey = useCallback(
    async (name: string) => {
      try {
        await invoke('clear_provider_key', { provider: name })
        flashToast(`Key cleared: ${name}`)
        await refreshStatus()
        await refreshConfig()
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  )

  const openKeyModal = useCallback(
    async (provider: string) => {
      setKeyModal({ open: true, provider, value: '' })
      if (isDevPreview) return
      try {
        const existing = await invoke<string | null>('get_provider_key', { provider })
        setKeyModal((m) => (m.open && m.provider === provider ? { ...m, value: existing ?? '' } : m))
      } catch (e) {
        console.warn('Failed to load provider key', e)
      }
    },
    [isDevPreview, setKeyModal],
  )

  return {
    saveKey,
    clearKey,
    openKeyModal,
  }
}
