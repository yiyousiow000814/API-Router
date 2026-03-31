import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { UseProviderActionsParams } from './types'
import type { Config } from '../../types'
import { buildProviderGroupMaps, resolveProviderDisplayName } from '../../utils/providerGroups'

const PACKYCODE_LOGIN_SYNC_POLL_MS = 2000
const PACKYCODE_LOGIN_SYNC_TIMEOUT_MS = 10 * 60 * 1000

type UsageAuthPayload = {
  token: string
  username: string
  password: string
}

type ProviderUsageActions = Pick<
  UseProviderActionsParams,
  | 'config'
  | 'status'
  | 'setConfig'
  | 'isDevPreview'
  | 'providerEmailModal'
  | 'usageBaseModal'
  | 'usageAuthModal'
  | 'setProviderEmailModal'
  | 'setUsageBaseModal'
  | 'setUsageAuthModal'
  | 'setRefreshingProviders'
  | 'refreshStatus'
  | 'refreshConfig'
  | 'flashToast'
>

export type QuotaHardCapField = 'daily' | 'weekly' | 'monthly'

export function applyProviderUsageLoginLocalPatch(
  prev: Config | null,
  providers: string[],
  enabled: boolean,
): Config | null {
  if (!prev) return prev
  if (providers.length === 0) return prev
  const nextProviders = { ...prev.providers }
  let changed = false
  for (const provider of providers) {
    const current = nextProviders[provider]
    if (!current) continue
    if (Boolean(current.has_usage_token) === enabled) continue
    nextProviders[provider] = {
      ...current,
      has_usage_token: enabled,
    }
    changed = true
  }
  return changed ? { ...prev, providers: nextProviders } : prev
}

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

export function buildUsageBaseModalDraft(
  provider: string,
  baseUrl: string | null | undefined,
  explicitValue: string | null | undefined,
  effectiveValue: string | null | undefined,
  payload?: Partial<UsageAuthPayload> | null,
  options?: { showUrlInput?: boolean; showPackycodeLogin?: boolean; hasUsageLogin?: boolean },
) {
  const explicit = (explicitValue ?? '').trim()
  const effective = (effectiveValue ?? '').trim()
  return {
    open: true,
    provider,
    baseUrl: (baseUrl ?? '').trim(),
    showUrlInput: options?.showUrlInput ?? true,
    showPackycodeLogin: options?.showPackycodeLogin ?? false,
    hasUsageLogin: options?.hasUsageLogin ?? false,
    value: explicit,
    auto: !explicit,
    explicitValue: explicit,
    effectiveValue: effective,
    token: (payload?.token ?? '').trim(),
    username: (payload?.username ?? '').trim(),
    password: payload?.password ?? '',
    loading: false,
    loadFailed: false,
  }
}

export function buildUsageAuthModalDraft(
  provider: string,
  baseUrl: string,
  payload?: Partial<UsageAuthPayload> | null,
) {
  return {
    open: true,
    provider,
    baseUrl,
    token: (payload?.token ?? '').trim(),
    username: (payload?.username ?? '').trim(),
    password: payload?.password ?? '',
    loading: false,
    loadFailed: false,
  }
}

function supportsUsageAuthProvider(baseUrl?: string | null): boolean {
  const text = `${baseUrl ?? ''}`.trim().toLowerCase()
  return text.includes('codex-for')
}

export function supportsPackycodeLoginProvider(baseUrl?: string | null): boolean {
  const text = `${baseUrl ?? ''}`.trim().toLowerCase()
  return text.includes('packycode')
}

function providerHasUsageLogin(config: Config | null | undefined, provider: string): boolean {
  const providerConfig = config?.providers?.[provider]
  return Boolean(providerConfig?.has_usage_token || providerConfig?.has_usage_login)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForProviderUsageLogin(
  provider: string,
  getConfig: () => Promise<Config>,
  options?: { pollMs?: number; timeoutMs?: number },
): Promise<boolean> {
  const pollMs = options?.pollMs ?? PACKYCODE_LOGIN_SYNC_POLL_MS
  const timeoutMs = options?.timeoutMs ?? PACKYCODE_LOGIN_SYNC_TIMEOUT_MS
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const cfg = await getConfig()
    if (providerHasUsageLogin(cfg, provider)) {
      return true
    }
    await delay(pollMs)
  }
  return false
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
  setConfig,
  isDevPreview,
  providerEmailModal,
  usageBaseModal,
  usageAuthModal,
  setProviderEmailModal,
  setUsageBaseModal,
  setUsageAuthModal,
  setRefreshingProviders,
  refreshStatus,
  refreshConfig,
  flashToast,
}: ProviderUsageActions) {
  const providerGroupMaps = useMemo(() => buildProviderGroupMaps(config), [config])
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
        await invokeManualQuotaRefresh(name)
        await refreshStatus()
        flashToast(`Usage refreshed: ${name}`)
      } catch (e) {
        try {
          await refreshStatus()
        } catch {}
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
      let opError: unknown = null
      let rollbackError: unknown = null
      const appliedProviders: string[] = []
      const previousUsageBaseByProvider = new Map<string, string | null>(
        targetProviders.map((target) => [target, (config?.providers?.[target]?.usage_base_url ?? '').trim() || null]),
      )
      try {
        for (const target of targetProviders) {
          if (shouldSetUsageBase) {
            await invoke('set_usage_base_url', { provider: target, url })
          } else {
            await invoke('clear_usage_base_url', { provider: target })
          }
          appliedProviders.push(target)
        }
      } catch (e) {
        opError = e
        try {
          for (const target of appliedProviders) {
            const previousUsageBase = previousUsageBaseByProvider.get(target) ?? null
            if (previousUsageBase) {
              await invoke('set_usage_base_url', { provider: target, url: previousUsageBase })
            } else {
              await invoke('clear_usage_base_url', { provider: target })
            }
          }
        } catch (rollbackErr) {
          rollbackError = rollbackErr
        }
      } finally {
        await refreshConfig()
        await refreshStatus()
      }
      if (rollbackError) {
        throw new Error(`${String(opError)} | rollback failed: ${String(rollbackError)}`)
      }
      if (opError) throw opError
      const scopeLabel = providerScopeLabel(provider)
      flashToast(
        shouldSetUsageBase
          ? targetProviders.length > 1
            ? `Usage URL saved: ${scopeLabel} (${targetProviders.length} providers)`
            : `Usage URL saved: ${scopeLabel}`
          : targetProviders.length > 1
            ? `Usage URL cleared: ${scopeLabel} (${targetProviders.length} providers)`
            : `Usage URL cleared: ${scopeLabel}`,
      )
    },
    [config, flashToast, providerScopeLabel, providersForTarget, refreshConfig, refreshStatus],
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

  const applyUsageAuth = useCallback(
    async (provider: string, payload: UsageAuthPayload) => {
      if (!provider) return
      const token = payload.token.trim()
      const username = payload.username.trim()
      const password = payload.password
      const targetProviders = providersForTarget(provider)
      if (isDevPreview) {
        const scopeLabel = providerScopeLabel(provider)
        flashToast(
          targetProviders.length > 1
            ? `Usage auth saved [TEST]: ${scopeLabel} (${targetProviders.length} providers)`
            : `Usage auth saved [TEST]: ${scopeLabel}`,
        )
        return
      }
      let opError: unknown = null
      let rollbackError: unknown = null
      const appliedProviders: string[] = []
      const previousByProvider = new Map<string, UsageAuthPayload>()
      try {
        for (const target of targetProviders) {
          previousByProvider.set(
            target,
            await invoke<UsageAuthPayload>('get_usage_auth', { provider: target }),
          )
        }
        for (const target of targetProviders) {
          await invoke('set_usage_auth', {
            provider: target,
            token,
            username,
            password,
          })
          appliedProviders.push(target)
        }
      } catch (e) {
        opError = e
        try {
          for (const target of appliedProviders) {
            const previous = previousByProvider.get(target) ?? {
              token: '',
              username: '',
              password: '',
            }
            await invoke('set_usage_auth', {
              provider: target,
              token: previous.token,
              username: previous.username,
              password: previous.password,
            })
          }
        } catch (rollbackErr) {
          rollbackError = rollbackErr
        }
      } finally {
        await refreshConfig()
        await refreshStatus()
      }
      if (rollbackError) {
        throw new Error(`${String(opError)} | rollback failed: ${String(rollbackError)}`)
      }
      if (opError) throw opError
      const scopeLabel = providerScopeLabel(provider)
      flashToast(
        targetProviders.length > 1
          ? `Usage auth saved: ${scopeLabel} (${targetProviders.length} providers)`
          : `Usage auth saved: ${scopeLabel}`,
      )
    },
    [flashToast, isDevPreview, providerScopeLabel, providersForTarget, refreshConfig, refreshStatus, setConfig],
  )

  const saveUsageBaseUrl = useCallback(async () => {
    const provider = usageBaseModal.provider
    if (!provider) return
    try {
      await applyUsageBaseUrl(provider, usageBaseModal.value)
      if (!isDevPreview && usageBaseModal.value.trim()) {
        await refreshQuota(provider)
      }
      setUsageBaseModal({
        open: false,
        provider: '',
        baseUrl: '',
        showUrlInput: true,
        showPackycodeLogin: false,
        hasUsageLogin: false,
        value: '',
        auto: false,
        explicitValue: '',
        effectiveValue: '',
        token: '',
        username: '',
        password: '',
        loading: false,
        loadFailed: false,
      })
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [
    applyUsageBaseUrl,
    isDevPreview,
    flashToast,
    refreshQuota,
    setUsageBaseModal,
    usageBaseModal.provider,
    usageBaseModal.value,
  ])

  const openProviderEmailModal = useCallback(
    (provider: string, current: string | null | undefined) => {
      setProviderEmailModal({
        open: true,
        provider,
        value: (current ?? '').trim(),
      })
    },
    [setProviderEmailModal],
  )

  const saveProviderEmail = useCallback(async () => {
    const provider = providerEmailModal.provider
    if (!provider) return
    try {
      await invoke('set_provider_account_email', {
        provider,
        email: providerEmailModal.value,
      })
      await refreshConfig()
      await refreshStatus()
      flashToast(`Provider email saved: ${provider}`)
      setProviderEmailModal({ open: false, provider: '', value: '' })
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [
    flashToast,
    providerEmailModal.provider,
    providerEmailModal.value,
    refreshConfig,
    refreshStatus,
    setProviderEmailModal,
  ])

  const clearProviderEmail = useCallback(
    async (provider: string) => {
      if (!provider) return
      try {
        await invoke('clear_provider_account_email', { provider })
        await refreshConfig()
        await refreshStatus()
        flashToast(`Provider email cleared: ${provider}`)
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  )

  const clearUsageBaseUrl = useCallback(
    async (name: string) => {
      try {
        await applyUsageBaseUrl(name, '')
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [applyUsageBaseUrl, flashToast],
  )

  const saveUsageAuth = useCallback(async () => {
    const provider = usageAuthModal.provider
    if (!provider) return
    try {
      await applyUsageAuth(provider, {
        token: usageAuthModal.token,
        username: usageAuthModal.username,
        password: usageAuthModal.password,
      })
      if (!isDevPreview) {
        await refreshQuota(provider)
      }
      setUsageAuthModal({
        open: false,
        provider: '',
        baseUrl: '',
        token: '',
        username: '',
        password: '',
        loading: false,
        loadFailed: false,
      })
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }, [
    applyUsageAuth,
    isDevPreview,
    flashToast,
    refreshQuota,
    setUsageAuthModal,
    usageAuthModal.password,
    usageAuthModal.provider,
    usageAuthModal.token,
    usageAuthModal.username,
  ])

  const clearUsageAuth = useCallback(
    async (provider: string) => {
      if (!provider) return
      const targets = providersForTarget(provider)
      if (isDevPreview) {
        setConfig((prev) => applyProviderUsageLoginLocalPatch(prev, targets, false))
        const scopeLabel = providerScopeLabel(provider)
        flashToast(
          targets.length > 1
            ? `Usage auth cleared [TEST]: ${scopeLabel} (${targets.length} providers)`
            : `Usage auth cleared [TEST]: ${scopeLabel}`,
        )
        return
      }
      try {
        for (const target of targets) {
          await invoke('clear_usage_auth', { provider: target })
        }
        await refreshConfig()
        await refreshStatus()
        const scopeLabel = providerScopeLabel(provider)
        flashToast(
          targets.length > 1
            ? `Usage auth cleared: ${scopeLabel} (${targets.length} providers)`
            : `Usage auth cleared: ${scopeLabel}`,
        )
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [flashToast, isDevPreview, providerScopeLabel, providersForTarget, refreshConfig, refreshStatus],
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
      let opError: unknown = null
      let rollbackError: unknown = null
      const appliedTargets: string[] = []
      const previousEnabledByProvider = new Map<string, boolean>(
        targets.map((target) => [target, config?.providers?.[target]?.quota_hard_cap?.[field] ?? true]),
      )
      try {
        for (const target of targets) {
          await invoke('set_provider_quota_hard_cap_field', {
            provider: target,
            field,
            enabled,
          })
          appliedTargets.push(target)
        }
        flashToast(`Hard cap updated: ${scopeLabel}.${field} (${targets.length} providers)`)
      } catch (e) {
        opError = e
        setConfig((prev) => {
          let next = prev
          for (const target of targets) {
            next = applyProviderQuotaHardCapLocalPatch(
              next,
              target,
              field,
              previousEnabledByProvider.get(target) ?? true,
            )
          }
          return next
        })
        try {
          for (const target of appliedTargets) {
            await invoke('set_provider_quota_hard_cap_field', {
              provider: target,
              field,
              enabled: previousEnabledByProvider.get(target) ?? true,
            })
          }
        } catch (rollbackErr) {
          rollbackError = rollbackErr
        }
      }
      await refreshConfig()
      await refreshStatus()
      if (rollbackError) {
        flashToast(`${String(opError)} | rollback failed: ${String(rollbackError)}`, 'error')
        return
      }
      if (opError) {
        flashToast(String(opError), 'error')
      }
    },
    [
      config,
      flashToast,
      isDevPreview,
      providerScopeLabel,
      providersForTarget,
      refreshConfig,
      refreshStatus,
      setConfig,
    ],
  )

  const openUsageBaseModal = useCallback(
    async (
      provider: string,
      current: string | null | undefined,
      options?: { showUrlInput?: boolean },
    ) => {
      const explicit = (current ?? '').trim()
      const providerCfg = config?.providers?.[provider]
      const providerBaseUrl = providerCfg?.base_url ?? ''
      const showUrlInput = options?.showUrlInput ?? true
      setUsageBaseModal({
        ...buildUsageBaseModalDraft(provider, providerBaseUrl, explicit, '', undefined, {
          showUrlInput,
          showPackycodeLogin: supportsPackycodeLoginProvider(providerBaseUrl),
          hasUsageLogin: providerHasUsageLogin(config, provider),
        }),
      })
      if (isDevPreview) return
      const effectiveResult = await invoke<string | null>('get_effective_usage_base', { provider })
        .then((value) => ({ status: 'fulfilled' as const, value }))
        .catch((reason) => ({ status: 'rejected' as const, reason }))
      setUsageBaseModal((m) => {
        if (!m.open || m.provider !== provider) return m
        const nextEffective =
          effectiveResult.status === 'fulfilled' ? (effectiveResult.value ?? '').trim() : m.effectiveValue
        return {
          ...m,
          value: m.explicitValue,
          auto: !m.explicitValue,
          effectiveValue: nextEffective,
          loading: false,
        }
      })
      if (effectiveResult.status === 'rejected') {
        console.warn('Failed to load usage base', effectiveResult.reason)
      }
    },
    [config, isDevPreview, setUsageBaseModal],
  )

  const openUsageAuthModal = useCallback(
    async (provider: string) => {
      const providerCfg = config?.providers?.[provider]
      if (!supportsUsageAuthProvider(providerCfg?.base_url)) {
        flashToast('Usage auth only supports codex-for hosts', 'error')
        return
      }
      setUsageAuthModal({
        open: true,
        provider,
        baseUrl: providerCfg?.base_url ?? '',
        token: '',
        username: '',
        password: '',
        loading: !isDevPreview,
        loadFailed: false,
      })
      if (isDevPreview) return
      try {
        const payload = await invoke<UsageAuthPayload>('get_usage_auth', { provider })
        setUsageAuthModal((modal) => {
          if (!modal.open || modal.provider !== provider) return modal
          return buildUsageAuthModalDraft(provider, providerCfg?.base_url ?? '', payload)
        })
      } catch (e) {
        setUsageAuthModal((modal) => {
          if (!modal.open || modal.provider !== provider) return modal
          return { ...modal, loading: false, loadFailed: true }
        })
        console.warn('Failed to load usage auth', e)
      }
    },
    [config, flashToast, isDevPreview, setUsageAuthModal],
  )

  const openPackycodeLogin = useCallback(
    async (provider: string) => {
      const providerCfg = config?.providers?.[provider]
      if (!supportsPackycodeLoginProvider(providerCfg?.base_url)) {
        flashToast('Packycode login only supports packycode hosts', 'error')
        return
      }
      if (isDevPreview) {
        setConfig((prev) => applyProviderUsageLoginLocalPatch(prev, [provider], true))
        setUsageBaseModal((modal) =>
          modal.open && modal.provider === provider ? { ...modal, hasUsageLogin: true } : modal,
        )
        flashToast(`Packycode login opened [TEST]: ${provider}`)
        return
      }
      try {
        await invoke('open_packycode_login_window', { provider })
        flashToast(`Packycode login opened: ${provider}`)
        void waitForProviderUsageLogin(
          provider,
          () => invoke<Config>('get_config'),
          undefined,
        )
          .then(async (synced) => {
            if (!synced) return
            setUsageBaseModal((modal) =>
              modal.open && modal.provider === provider ? { ...modal, hasUsageLogin: true } : modal,
            )
            await refreshConfig()
            await refreshStatus()
            flashToast(`Packycode login imported: ${provider}`)
          })
          .catch((err) => {
            console.warn('Failed to sync Packycode login state', err)
          })
      } catch (e) {
        flashToast(String(e), 'error')
      }
    },
    [config, flashToast, isDevPreview, refreshConfig, refreshStatus, setUsageBaseModal],
  )

  return {
    refreshQuota,
    refreshQuotaAll,
    saveUsageBaseUrl,
    saveUsageAuth,
    clearUsageAuth,
    saveProviderEmail,
    clearProviderEmail,
    setUsageBaseUrl,
    clearUsageBaseUrl,
    setProviderQuotaHardCap,
    openUsageBaseModal,
    openUsageAuthModal,
    openPackycodeLogin,
    openProviderEmailModal,
  }
}

export function invokeManualQuotaRefresh(name: string) {
  return invoke('refresh_quota', { provider: name })
}
