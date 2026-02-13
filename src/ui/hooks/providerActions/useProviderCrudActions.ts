import { useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { UseProviderActionsParams } from './types'

type ProviderCrudActions = Pick<
  UseProviderActionsParams,
  | 'config'
  | 'newProviderName'
  | 'newProviderBaseUrl'
  | 'setNewProviderName'
  | 'setNewProviderBaseUrl'
  | 'refreshStatus'
  | 'refreshConfig'
  | 'flashToast'
>

export function useProviderCrudActions({
  config,
  newProviderName,
  newProviderBaseUrl,
  setNewProviderName,
  setNewProviderBaseUrl,
  refreshStatus,
  refreshConfig,
  flashToast,
}: ProviderCrudActions) {
  const saveProvider = useCallback(
    async (name: string) => {
      if (!config) return
      const p = config.providers[name]
      try {
        await invoke('upsert_provider', {
          name,
          displayName: p.display_name,
          baseUrl: p.base_url,
        })
        flashToast(`Saved: ${name}`)
        try {
          await invoke('probe_provider', { provider: name })
        } catch (e) {
          flashToast(String(e), 'error')
        }
        try {
          await invoke('refresh_quota', { provider: name })
        } catch (e) {
          flashToast(String(e), 'error')
        }
        await refreshStatus()
        await refreshConfig()
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [config, flashToast, refreshConfig, refreshStatus],
  )

  const deleteProvider = useCallback(
    async (name: string) => {
      try {
        await invoke('delete_provider', { name })
        flashToast(`Deleted: ${name}`)
        await refreshStatus()
        await refreshConfig()
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  )

  const addProvider = useCallback(async () => {
    const name = newProviderName.trim()
    const baseUrl = newProviderBaseUrl.trim()
    if (!name || !baseUrl) return

    try {
      await invoke('upsert_provider', {
        name,
        displayName: name,
        baseUrl,
      })
      setNewProviderName('')
      setNewProviderBaseUrl('')
      flashToast(`Added: ${name}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [
    flashToast,
    newProviderBaseUrl,
    newProviderName,
    refreshConfig,
    refreshStatus,
    setNewProviderBaseUrl,
    setNewProviderName,
  ])

  return {
    saveProvider,
    deleteProvider,
    addProvider,
  }
}
