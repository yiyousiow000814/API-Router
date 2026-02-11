import { useCallback } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'

import type { Config, Status } from '../types'

type KeyModalState = { open: boolean; provider: string; value: string }
type UsageBaseModalState = {
  open: boolean
  provider: string
  value: string
  auto: boolean
  explicitValue: string
  effectiveValue: string
}

type Args = {
  isDevPreview: boolean
  status: Status | null
  config: Config | null
  keyModal: KeyModalState
  usageBaseModal: UsageBaseModalState
  newProviderName: string
  newProviderBaseUrl: string
  overrideDirtyRef: MutableRefObject<boolean>
  setKeyModal: Dispatch<SetStateAction<KeyModalState>>
  setUsageBaseModal: Dispatch<SetStateAction<UsageBaseModalState>>
  setConfig: Dispatch<SetStateAction<Config | null>>
  setRefreshingProviders: Dispatch<SetStateAction<Record<string, boolean>>>
  setNewProviderName: Dispatch<SetStateAction<string>>
  setNewProviderBaseUrl: Dispatch<SetStateAction<string>>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  refreshStatus: () => Promise<void>
  refreshConfig: () => Promise<void>
}

export function useGatewayActions({
  isDevPreview,
  status,
  config,
  keyModal,
  usageBaseModal,
  newProviderName,
  newProviderBaseUrl,
  overrideDirtyRef,
  setKeyModal,
  setUsageBaseModal,
  setConfig,
  setRefreshingProviders,
  setNewProviderName,
  setNewProviderBaseUrl,
  flashToast,
  refreshStatus,
  refreshConfig,
}: Args) {
  const applyOverride = useCallback(
    async (next: string) => {
      try {
        await invoke('set_manual_override', { provider: next === '' ? null : next })
        overrideDirtyRef.current = false
        flashToast(next === '' ? 'Routing: auto' : 'Routing locked')
        await refreshStatus()
      } catch (error) {
        flashToast(String(error), 'error')
      }
    },
    [flashToast, overrideDirtyRef, refreshStatus],
  )

  const setPreferred = useCallback(
    async (next: string) => {
      await invoke('set_preferred_provider', { provider: next })
      await refreshStatus()
      await refreshConfig()
    },
    [refreshConfig, refreshStatus],
  )

  const saveProvider = useCallback(
    async (name: string) => {
      if (!config) return
      const provider = config.providers[name]
      try {
        await invoke('upsert_provider', {
          name,
          displayName: provider.display_name,
          baseUrl: provider.base_url,
        })
        flashToast(`Saved: ${name}`)
        try {
          await invoke('probe_provider', { provider: name })
        } catch (error) {
          flashToast(String(error), 'error')
        }
        try {
          await invoke('refresh_quota', { provider: name })
        } catch (error) {
          flashToast(String(error), 'error')
        }
        await refreshStatus()
        await refreshConfig()
      } catch (error) {
        flashToast(String(error), 'error')
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
      } catch (error) {
        flashToast(String(error), 'error')
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  )

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
      } catch (error) {
        flashToast(String(error), 'error')
      }
      try {
        await invoke('refresh_quota', { provider })
      } catch (error) {
        flashToast(String(error), 'error')
      }
      await refreshStatus()
      await refreshConfig()
    } catch (error) {
      flashToast(String(error), 'error')
    }
  }, [flashToast, keyModal, refreshConfig, refreshStatus, setKeyModal])

  const clearKey = useCallback(
    async (name: string) => {
      try {
        await invoke('clear_provider_key', { provider: name })
        flashToast(`Key cleared: ${name}`)
        await refreshStatus()
        await refreshConfig()
      } catch (error) {
        flashToast(String(error), 'error')
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  )

  const refreshQuota = useCallback(
    async (name: string) => {
      setRefreshingProviders((previous) => ({ ...previous, [name]: true }))
      try {
        await invoke('refresh_quota_shared', { provider: name })
        await refreshStatus()
        flashToast(`Usage refreshed: ${name}`)
      } catch (error) {
        flashToast(String(error), 'error')
      } finally {
        setRefreshingProviders((previous) => ({ ...previous, [name]: false }))
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
        if (!opts?.silent) flashToast('Usage refreshed')
      } catch (error) {
        flashToast(String(error), 'error')
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
    } catch (error) {
      flashToast(String(error), 'error')
    }
  }, [flashToast, refreshConfig, refreshStatus, setUsageBaseModal, usageBaseModal.provider, usageBaseModal.value])

  const clearUsageBaseUrl = useCallback(
    async (name: string) => {
      try {
        await invoke('clear_usage_base_url', { provider: name })
        flashToast(`Usage base cleared: ${name}`)
        await refreshConfig()
        await refreshStatus()
      } catch (error) {
        flashToast(String(error), 'error')
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
        setKeyModal((modal) => (modal.open && modal.provider === provider ? { ...modal, value: existing ?? '' } : modal))
      } catch (error) {
        console.warn('Failed to load provider key', error)
      }
    },
    [isDevPreview, setKeyModal],
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
        setUsageBaseModal((modal) => {
          if (!modal.open || modal.provider !== provider) return modal
          const nextValue = modal.explicitValue ? modal.explicitValue : effective
          return { ...modal, value: nextValue, auto: !modal.explicitValue, effectiveValue: effective }
        })
      } catch (error) {
        console.warn('Failed to load usage base', error)
      }
    },
    [isDevPreview, setUsageBaseModal, status?.quota],
  )

  const applyProviderOrder = useCallback(
    async (next: string[]) => {
      if (!config) return
      setConfig((current) => (current ? { ...current, provider_order: next } : current))
      try {
        await invoke('set_provider_order', { order: next })
        await refreshConfig()
        await refreshStatus()
      } catch (error) {
        flashToast(String(error), 'error')
      }
    },
    [config, flashToast, refreshConfig, refreshStatus, setConfig],
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
    } catch (error) {
      flashToast(String(error), 'error')
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
    applyOverride,
    setPreferred,
    saveProvider,
    deleteProvider,
    saveKey,
    clearKey,
    refreshQuota,
    refreshQuotaAll,
    saveUsageBaseUrl,
    clearUsageBaseUrl,
    openKeyModal,
    openUsageBaseModal,
    applyProviderOrder,
    addProvider,
  }
}
