import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { UseProviderActionsParams } from './types'
import type { Config } from '../../types'
import { buildProviderGroupMaps, resolveProviderDisplayName } from '../../utils/providerGroups'

type ProviderUsageActions = Pick<
  UseProviderActionsParams,
  | 'config'
  | 'status'
  | 'setConfig'
  | 'isDevPreview'
  | 'usageBaseModal'
  | 'setUsageBaseModal'
  | 'setRefreshingProviders'
  | 'refreshStatus'
  | 'refreshConfig'
  | 'flashToast'
>

export type QuotaHardCapField = 'daily' | 'weekly' | 'monthly'

export function applyProviderQuotaHardCapLocalPatch(
  prev: Config | null,
  provider: string,
  field: QuotaHardCapField,
  enabled: boolean,
): Config | null {
  if (!prev) return prev
  const current = prev.providers?.[provider]
  if (!current) return prev
  const currentHardCap = current.quota_hard_cap ?? {
    daily: true,
    weekly: true,
    monthly: true,
  }
  return {
    ...prev,
    providers: {
      ...prev.providers,
      [provider]: {
        ...current,
        quota_hard_cap: {
          ...currentHardCap,
          [field]: enabled,
        },
      },
    },
  }
}

type SetProviderQuotaHardCapParams = {
  provider: string
  field: QuotaHardCapField
  enabled: boolean
  invokeFn: (cmd: string, args: Record<string, unknown>) => Promise<unknown>
  setConfig: Dispatch<SetStateAction<Config | null>>
  refreshConfig: () => Promise<void>
  refreshStatus: () => Promise<void>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  isLocalOnly?: boolean
}

export async function setProviderQuotaHardCapFieldWithRefresh({
  provider,
  field,
  enabled,
  invokeFn,
  setConfig,
  refreshConfig,
  refreshStatus,
  flashToast,
  isLocalOnly,
}: SetProviderQuotaHardCapParams): Promise<void> {
  setConfig((prev) => applyProviderQuotaHardCapLocalPatch(prev, provider, field, enabled))
  if (isLocalOnly) {
    flashToast(`Hard cap updated [TEST]: ${provider}.${field}`)
    return
  }
  try {
    await invokeFn('set_provider_quota_hard_cap_field', {
      provider,
      field,
      enabled,
    })
    flashToast(`Hard cap updated: ${provider}.${field}`)
  } catch (e) {
    flashToast(String(e), 'error')
  }
  await refreshConfig()
  await refreshStatus()
}

export function useProviderUsageActions({
  config,
  status,
  setConfig,
  isDevPreview,
  usageBaseModal,
  setUsageBaseModal,
  setRefreshingProviders,
  refreshStatus,
  refreshConfig,
  flashToast,
}: ProviderUsageActions) {
  const providerGroupMaps = buildProviderGroupMaps(config)
  const providersForTarget = useCallback(
    (provider: string): string[] => providerGroupMaps.membersByProvider[provider] ?? [provider],
    [providerGroupMaps.membersByProvider],
  )
  const providerScopeLabel = useCallback(
    (provider: string): string => resolveProviderDisplayName(providerGroupMaps.displayNameByProvider, provider),
    [providerGroupMaps.displayNameByProvider],
  )

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

  const applyUsageBaseUrl = useCallback(
    async (provider: string, rawUrl: string) => {
      const url = rawUrl.trim()
      if (!provider) return
      const targetProviders = providersForTarget(provider)
      const shouldSetUsageBase = Boolean(url)
      for (const target of targetProviders) {
        if (shouldSetUsageBase) {
          await invoke('set_usage_base_url', { provider: target, url })
        } else {
          await invoke('clear_usage_base_url', { provider: target })
        }
      }
      const scopeLabel = providerScopeLabel(provider)
      flashToast(
        shouldSetUsageBase
          ? targetProviders.length > 1
            ? `Usage base saved: ${scopeLabel} (${targetProviders.length} providers)`
            : `Usage base saved: ${scopeLabel}`
          : targetProviders.length > 1
            ? `Usage base cleared: ${scopeLabel} (${targetProviders.length} providers)`
            : `Usage base cleared: ${scopeLabel}`,
      )
      await refreshConfig()
      await refreshStatus()
    },
    [flashToast, providerScopeLabel, providersForTarget, refreshConfig, refreshStatus],
  )

  const setUsageBaseUrl = useCallback(
    async (provider: string, url: string) => {
      try {
        await applyUsageBaseUrl(provider, url)
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [applyUsageBaseUrl, flashToast],
  )

  const saveUsageBaseUrl = useCallback(async () => {
    const provider = usageBaseModal.provider
    if (!provider) return
    try {
      await applyUsageBaseUrl(provider, usageBaseModal.value)
      setUsageBaseModal({
        open: false,
        provider: '',
        value: '',
        auto: false,
        explicitValue: '',
        effectiveValue: '',
      })
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [
    applyUsageBaseUrl,
    flashToast,
    setUsageBaseModal,
    usageBaseModal.provider,
    usageBaseModal.value,
  ])

  const clearUsageBaseUrl = useCallback(
    async (name: string) => {
      const targetProviders = providersForTarget(name)
      try {
        for (const provider of targetProviders) {
          await invoke('clear_usage_base_url', { provider })
        }
        const scopeLabel = providerScopeLabel(name)
        flashToast(
          targetProviders.length > 1
            ? `Usage base cleared: ${scopeLabel} (${targetProviders.length} providers)`
            : `Usage base cleared: ${scopeLabel}`,
        )
        await refreshConfig()
        await refreshStatus()
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [flashToast, providerScopeLabel, providersForTarget, refreshConfig, refreshStatus],
  )

  const setProviderQuotaHardCap = useCallback(
    async (provider: string, field: QuotaHardCapField, enabled: boolean) => {
      const targets = providersForTarget(provider)
      const scopeLabel = providerScopeLabel(provider)
      if (targets.length === 1) {
        await setProviderQuotaHardCapFieldWithRefresh({
          provider,
          field,
          enabled,
          invokeFn: (cmd, args) => invoke(cmd, args),
          setConfig,
          refreshConfig,
          refreshStatus,
          flashToast,
          isLocalOnly: isDevPreview,
        })
        return
      }

      targets.forEach((target) => {
        setConfig((prev) => applyProviderQuotaHardCapLocalPatch(prev, target, field, enabled))
      })
      if (isDevPreview) {
        flashToast(`Hard cap updated [TEST]: ${scopeLabel}.${field} (${targets.length} providers)`)
        return
      }
      try {
        for (const target of targets) {
          await invoke('set_provider_quota_hard_cap_field', {
            provider: target,
            field,
            enabled,
          })
        }
        flashToast(`Hard cap updated: ${scopeLabel}.${field} (${targets.length} providers)`)
      } catch (e) {
        flashToast(String(e), 'error')
      }
      await refreshConfig()
      await refreshStatus()
    },
    [flashToast, isDevPreview, providerScopeLabel, providersForTarget, refreshConfig, refreshStatus, setConfig],
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
    setUsageBaseUrl,
    clearUsageBaseUrl,
    setProviderQuotaHardCap,
    openUsageBaseModal,
  }
}
