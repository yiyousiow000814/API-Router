import { useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { UseProviderActionsParams } from './types'

type ProviderCrudActions = Pick<
  UseProviderActionsParams,
  | 'config'
  | 'isDevPreview'
  | 'setConfig'
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
  isDevPreview,
  setConfig,
  newProviderName,
  newProviderBaseUrl,
  setNewProviderName,
  setNewProviderBaseUrl,
  refreshStatus,
  refreshConfig,
  flashToast,
}: ProviderCrudActions) {
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
              usage_base_url: null,
              quota_hard_cap: {
                daily: true,
                weekly: true,
                monthly: true,
              },
              disabled: false,
              has_key: false,
              key_preview: null,
            },
          },
        }
      })
      setNewProviderName('')
      setNewProviderBaseUrl('')
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
      setNewProviderName('')
      setNewProviderBaseUrl('')
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
    newProviderName,
    refreshConfig,
    refreshStatus,
    setConfig,
    setNewProviderBaseUrl,
    setNewProviderName,
  ])

  return {
    saveProvider,
    setProviderGroup,
    setProvidersGroup,
    setProviderDisabled,
    deleteProvider,
    addProvider,
  }
}
