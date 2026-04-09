import { useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { UseProviderActionsParams } from './types'

type ProviderKeyActions = Pick<
  UseProviderActionsParams,
  'config' | 'keyModal' | 'isDevPreview' | 'setKeyModal' | 'refreshStatus' | 'refreshConfig' | 'flashToast'
>

export function useProviderKeyActions({
  config,
  keyModal,
  isDevPreview,
  setKeyModal,
  refreshStatus,
  refreshConfig,
  flashToast,
}: ProviderKeyActions) {
  const saveKey = useCallback(async () => {
    const provider = keyModal.provider
    const key = keyModal.value.trim()
    if (!provider || keyModal.loading) return
    if (keyModal.loadFailed && !key) {
      flashToast('Failed to load existing key. Retry opening the modal before clearing.', 'error')
      return
    }
    try {
      if (key) {
        await invoke('set_provider_key', { provider, key, storageMode: keyModal.storage })
      } else {
        await invoke('clear_provider_key', { provider })
      }
      setKeyModal({
        open: false,
        provider: '',
        value: '',
        storage: 'auth_json',
        loading: false,
        loadFailed: false,
      })
      if (key) {
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
      } else {
        flashToast(`Key cleared: ${provider}`)
      }
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [
    flashToast,
    keyModal.loadFailed,
    keyModal.loading,
    keyModal.provider,
    keyModal.value,
    refreshConfig,
    refreshStatus,
    setKeyModal,
  ])

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
      const currentStorage = config?.providers?.[provider]?.key_storage ?? 'auth_json'
      setKeyModal({
        open: true,
        provider,
        value: '',
        storage: currentStorage,
        loading: !isDevPreview,
        loadFailed: false,
      })
      if (isDevPreview) return
      try {
        const existing = await invoke<string | null>('get_provider_key', { provider })
        setKeyModal((m) =>
          m.open && m.provider === provider ? { ...m, value: existing ?? '', loading: false, loadFailed: false } : m,
        )
      } catch (e) {
        console.warn('Failed to load provider key', e)
        flashToast('Failed to load existing key. Enter a new key to save.', 'error')
        setKeyModal((m) => (m.open && m.provider === provider ? { ...m, loading: false, loadFailed: true } : m))
      }
    },
    [config?.providers, flashToast, isDevPreview, setKeyModal],
  )

  return {
    saveKey,
    clearKey,
    openKeyModal,
  }
}
