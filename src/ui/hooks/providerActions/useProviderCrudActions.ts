import { useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { UseProviderActionsParams } from './types'

type ProviderCrudActions = Pick<
  UseProviderActionsParams,
  | 'config'
  | 'isDevPreview'
  | 'setConfig'
  | 'providerBaseUrlModal'
  | 'newProviderName'
  | 'newProviderBaseUrl'
  | 'newProviderKey'
  | 'newProviderKeyStorage'
  | 'setProviderBaseUrlModal'
  | 'setNewProviderName'
  | 'setNewProviderBaseUrl'
  | 'setNewProviderKey'
  | 'setNewProviderKeyStorage'
  | 'refreshStatus'
  | 'refreshConfig'
  | 'flashToast'
> & {
  refreshQuota: (name: string) => Promise<void>
}

export function useProviderCrudActions({
  config,
  isDevPreview,
  setConfig,
  providerBaseUrlModal,
  newProviderName,
  newProviderBaseUrl,
  newProviderKey,
  newProviderKeyStorage,
  setProviderBaseUrlModal,
  setNewProviderName,
  setNewProviderBaseUrl,
  setNewProviderKey,
  setNewProviderKeyStorage,
  refreshQuota,
  refreshStatus,
  refreshConfig,
  flashToast,
}: ProviderCrudActions) {
  const openProviderBaseUrlModal = useCallback(
    (provider: string, current: string) => {
      setProviderBaseUrlModal({
        open: true,
        provider,
        value: current,
      })
    },
    [setProviderBaseUrlModal],
  )

  const saveProviderBaseUrl = useCallback(async () => {
    const provider = providerBaseUrlModal.provider.trim()
    const baseUrl = providerBaseUrlModal.value.trim()
    if (!provider || !baseUrl || !config?.providers?.[provider]) return

    if (isDevPreview) {
      setConfig((prev) => {
        if (!prev?.providers?.[provider]) return prev
        return {
          ...prev,
          providers: {
            ...prev.providers,
            [provider]: {
              ...prev.providers[provider],
              base_url: baseUrl,
            },
          },
        }
      })
      setProviderBaseUrlModal({ open: false, provider: '', value: '' })
      flashToast(`[TEST] Base URL updated: ${provider}`)
      return
    }

    try {
      const current = config.providers[provider]
      await invoke('upsert_provider', {
        name: provider,
        displayName: current.display_name,
        baseUrl,
        group: (current.group ?? '').trim() || null,
      })
      setProviderBaseUrlModal({ open: false, provider: '', value: '' })
      flashToast(`Base URL updated: ${provider}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [
    config,
    flashToast,
    isDevPreview,
    providerBaseUrlModal.provider,
    providerBaseUrlModal.value,
    refreshConfig,
    refreshStatus,
    setConfig,
    setProviderBaseUrlModal,
  ])

  const setProviderSupportsWebsockets = useCallback(
    async (provider: string, supportsWebsockets: boolean) => {
      const normalizedProvider = provider.trim()
      if (!normalizedProvider || !config?.providers?.[normalizedProvider]) return

      if (isDevPreview) {
        setConfig((prev) => {
          if (!prev?.providers?.[normalizedProvider]) return prev
          return {
            ...prev,
            providers: {
              ...prev.providers,
              [normalizedProvider]: {
                ...prev.providers[normalizedProvider],
                supports_websockets: supportsWebsockets || undefined,
              },
            },
          }
        })
        flashToast(`[TEST] WebSocket ${supportsWebsockets ? 'enabled' : 'disabled'}: ${normalizedProvider}`)
        return
      }

      try {
        await invoke('set_provider_supports_websockets', {
          provider: normalizedProvider,
          enabled: supportsWebsockets,
        })
        flashToast(`WebSocket ${supportsWebsockets ? 'enabled' : 'disabled'}: ${normalizedProvider}`)
        await refreshStatus()
        await refreshConfig()
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [config?.providers, flashToast, isDevPreview, refreshConfig, refreshStatus, setConfig],
  )

  const setProviderGroup = useCallback(
    async (name: string, group: string | null) => {
      if (isDevPreview) {
        setConfig((prev) => {
          if (!prev?.providers?.[name]) return prev
          return {
            ...prev,
            providers: {
              ...prev.providers,
              [name]: {
                ...prev.providers[name],
                group: group && group.trim() ? group.trim() : null,
              },
            },
          }
        })
        flashToast(`[TEST] Group updated: ${name}`)
        return
      }
      try {
        await invoke('set_provider_group', { name, group: group && group.trim() ? group.trim() : null })
        flashToast(group && group.trim() ? `Group updated: ${name} -> ${group.trim()}` : `Group cleared: ${name}`)
        await refreshConfig()
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [flashToast, isDevPreview, refreshConfig, setConfig],
  )

  const setProvidersGroup = useCallback(
    async (providers: string[], group: string | null) => {
      const normalizedProviders = providers.map((name) => name.trim()).filter(Boolean)
      if (!normalizedProviders.length) return
      const normalizedGroup = group && group.trim() ? group.trim() : null
      if (isDevPreview) {
        setConfig((prev) => {
          if (!prev) return prev
          const nextProviders = { ...prev.providers }
          normalizedProviders.forEach((name) => {
            const current = nextProviders[name]
            if (!current) return
            nextProviders[name] = {
              ...current,
              group: normalizedGroup,
            }
          })
          return { ...prev, providers: nextProviders }
        })
        flashToast(`[TEST] Group updated (${normalizedProviders.length})`)
        return
      }
      try {
        await invoke('set_providers_group', { providers: normalizedProviders, group: normalizedGroup })
        flashToast(
          normalizedGroup
            ? `Group updated: ${normalizedGroup} (${normalizedProviders.length} providers)`
            : `Group cleared: ${normalizedProviders.length} providers`,
        )
        await refreshConfig()
      } catch (e) {
        flashToast(String(e), 'error')
        throw e
      }
    },
    [flashToast, isDevPreview, refreshConfig, setConfig],
  )

  const saveProvider = useCallback(
    async (name: string) => {
      if (!config) return
      const p = config.providers[name]
      try {
        await invoke('upsert_provider', {
          name,
          displayName: p.display_name,
          baseUrl: p.base_url,
          group: (p.group ?? '').trim() || null,
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

  const setProviderDisabled = useCallback(
    async (name: string, disabled: boolean) => {
      if (isDevPreview) {
        if (disabled) {
          const activeCount = Object.values(config?.providers ?? {}).filter((provider) => !provider.disabled).length
          if (activeCount <= 1) {
            flashToast('[TEST] At least one provider must remain active.', 'error')
            return
          }
        }
        setConfig((prev) => {
          if (!prev?.providers?.[name]) return prev
          return {
            ...prev,
            providers: {
              ...prev.providers,
              [name]: {
                ...prev.providers[name],
                disabled,
              },
            },
          }
        })
        flashToast(`[TEST] ${disabled ? 'Deactivated' : 'Activated'}: ${name}`)
        return
      }
      try {
        await invoke('set_provider_disabled', { name, disabled })
        flashToast(`${disabled ? 'Deactivated' : 'Activated'}: ${name}`)
        await refreshStatus()
        await refreshConfig()
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [config?.providers, flashToast, isDevPreview, refreshConfig, refreshStatus, setConfig],
  )

  const addProvider = useCallback(async () => {
    const name = newProviderName.trim()
    const baseUrl = newProviderBaseUrl.trim()
    const key = newProviderKey.trim()
    if (!name || !baseUrl) return

    if (isDevPreview) {
      if (config?.providers?.[name]) {
        flashToast(`Provider already exists: ${name}`, 'error')
        return
      }
      setConfig((prev) => {
        if (!prev) return prev
        const nextOrder = [...(prev.provider_order ?? Object.keys(prev.providers))]
        if (!nextOrder.includes(name)) nextOrder.push(name)
        return {
          ...prev,
          provider_order: nextOrder,
          providers: {
            ...prev.providers,
            [name]: {
              display_name: name,
              base_url: baseUrl,
              group: null,
              supports_websockets: undefined,
              usage_base_url: null,
              quota_hard_cap: {
                daily: true,
                weekly: true,
                monthly: true,
              },
              disabled: false,
              has_key: Boolean(key),
              key_preview: null,
            },
          },
        }
      })
      setNewProviderName('')
      setNewProviderBaseUrl('')
      setNewProviderKey('')
      setNewProviderKeyStorage('auth_json')
      flashToast(`[TEST] Added: ${name}`)
      return
    }

    try {
      await invoke('upsert_provider', {
        name,
        displayName: name,
        baseUrl,
        group: null,
      })
      if (key) {
        await invoke('set_provider_key', { provider: name, key, storageMode: newProviderKeyStorage })
        await refreshQuota(name)
      }
      setNewProviderName('')
      setNewProviderBaseUrl('')
      setNewProviderKey('')
      setNewProviderKeyStorage('auth_json')
      flashToast(`Added: ${name}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [
    config?.providers,
    flashToast,
    isDevPreview,
    newProviderBaseUrl,
    newProviderKey,
    newProviderKeyStorage,
    newProviderName,
    refreshQuota,
    refreshConfig,
    refreshStatus,
    setConfig,
    setNewProviderBaseUrl,
    setNewProviderKey,
    setNewProviderKeyStorage,
    setNewProviderName,
  ])

  return {
    saveProvider,
    saveProviderBaseUrl,
    setProviderSupportsWebsockets,
    setProviderGroup,
    setProvidersGroup,
    setProviderDisabled,
    deleteProvider,
    openProviderBaseUrlModal,
    addProvider,
  }
}
