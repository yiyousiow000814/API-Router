import { useCallback, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Config, Status } from '../types'

type Params = {
  isDevPreview: boolean
  status: Status | null
  config: Config | null
  setConfig: Dispatch<SetStateAction<Config | null>>
  setUpdatingSessionPref: Dispatch<SetStateAction<Record<string, boolean>>>
  refreshStatus: () => Promise<void>
  refreshConfig: () => Promise<void>
  overrideDirtyRef: MutableRefObject<boolean>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  setStatus: Dispatch<SetStateAction<Status | null>>
  setOverride?: Dispatch<SetStateAction<string>>
  setBaselineBaseUrls: Dispatch<SetStateAction<Record<string, string>>>
  setGatewayTokenPreview: Dispatch<SetStateAction<string>>
  devStatus: Status
  devConfig: Config
}

export function applyDevPreviewRouteMode(
  config: Config | null,
  next: 'follow_preferred_auto' | 'balanced_auto',
): Config | null {
  if (!config) return config
  return {
    ...config,
    routing: {
      ...config.routing,
      route_mode: next,
    },
  }
}

export function applyDevPreviewPreferredProvider(
  config: Config | null,
  status: Status | null,
  next: string,
): { config: Config | null; status: Status | null } {
  const nextConfig = !config
    ? config
    : {
        ...config,
        routing: {
          ...config.routing,
          preferred_provider: next,
        },
      }
  const nextStatus = !status
    ? status
    : {
        ...status,
        preferred_provider: next,
      }
  return { config: nextConfig, status: nextStatus }
}

export function applyDevPreviewSessionPreferred(
  status: Status | null,
  sessionId: string,
  provider: string | null,
): Status | null {
  if (!status?.client_sessions) return status
  return {
    ...status,
    client_sessions: status.client_sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            preferred_provider: provider,
          }
        : session,
    ),
  }
}

export function applyDevPreviewManualOverride(
  status: Status | null,
  provider: string | null,
): Status | null {
  if (!status) return status
  return {
    ...status,
    manual_override: provider,
  }
}

export function useAppActions(params: Params) {
  const {
    isDevPreview,
    status,
    config,
    setConfig,
    setUpdatingSessionPref,
    refreshStatus,
    refreshConfig,
    overrideDirtyRef,
    flashToast,
    setStatus,
    setBaselineBaseUrls,
    setGatewayTokenPreview,
    devStatus,
    devConfig,
    setOverride,
  } = params

  async function setSessionPreferred(sessionId: string, provider: string | null) {
    setUpdatingSessionPref((m) => ({ ...m, [sessionId]: true }))
    try {
      if (isDevPreview) {
        setStatus((prev) => applyDevPreviewSessionPreferred(prev, sessionId, provider))
        return
      }
      const row = (status?.client_sessions ?? []).find((s) => s.id === sessionId)
      const codexSessionId = row?.codex_session_id ?? null
      if (!codexSessionId) {
        throw new Error('This session has no Codex session id yet. Send one request through the gateway first.')
      }
      if (provider) {
        await invoke('set_session_preferred_provider', { sessionId: codexSessionId, provider })
      } else {
        await invoke('clear_session_preferred_provider', { sessionId: codexSessionId })
      }
      await refreshStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to set session preference'
      flashToast(msg, 'error')
    } finally {
      setUpdatingSessionPref((m) => ({ ...m, [sessionId]: false }))
    }
  }

  const orderedConfigProviders = useMemo(() => {
    if (!config) return []
    const names = Object.keys(config.providers ?? {})
    const order = config.provider_order ?? []
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const name of order) {
      if (names.includes(name) && !seen.has(name)) {
        ordered.push(name)
        seen.add(name)
      }
    }
    for (const name of names) {
      if (!seen.has(name)) ordered.push(name)
    }
    return ordered
  }, [config])

  const nextProviderPlaceholder = useMemo(() => {
    const keys = Object.keys(config?.providers ?? {})
    let maxN = 0
    keys.forEach((k) => {
      const m = /^provider(\d+)$/.exec(k)
      if (m) maxN = Math.max(maxN, Number(m[1] || 0))
    })
    return `provider${maxN + 1}`
  }, [config])

  async function applyOverride(next: string): Promise<boolean> {
    if (isDevPreview) {
      setOverride?.(next)
      setStatus((prev) => applyDevPreviewManualOverride(prev, next === '' ? null : next))
      overrideDirtyRef.current = false
      flashToast(next === '' ? 'Routing: auto [TEST]' : 'Routing locked [TEST]')
      return true
    }
    try {
      await invoke('set_manual_override', { provider: next === '' ? null : next })
      overrideDirtyRef.current = false
      flashToast(next === '' ? 'Routing: auto' : 'Routing locked')
      await refreshStatus()
      return true
    } catch (e) {
      flashToast(String(e), 'error')
      return false
    }
  }

  async function setPreferred(next: string): Promise<boolean> {
    if (isDevPreview) {
      const patched = applyDevPreviewPreferredProvider(config, status, next)
      setConfig(patched.config)
      setStatus(patched.status)
      flashToast(`Preferred updated [TEST]: ${next}`)
      return true
    }
    try {
      await invoke('set_preferred_provider', { provider: next })
      await refreshStatus()
      await refreshConfig()
      return true
    } catch (e) {
      flashToast(String(e), 'error')
      return false
    }
  }

  async function setRouteMode(next: 'follow_preferred_auto' | 'balanced_auto'): Promise<boolean> {
    if (isDevPreview) {
      setConfig((prev) => applyDevPreviewRouteMode(prev, next))
      flashToast(`Route mode updated [TEST]: ${next}`)
      return true
    }
    try {
      await invoke('set_route_mode', { mode: next })
      await refreshStatus()
      await refreshConfig()
      return true
    } catch (e) {
      flashToast(String(e), 'error')
      return false
    }
  }

  async function applyProviderOrder(next: string[]) {
    if (!config) return
    setConfig((c) => (c ? { ...c, provider_order: next } : c))
    try {
      await invoke('set_provider_order', { order: next })
      await refreshConfig()
      await refreshStatus()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  const onDevPreviewBootstrap = useCallback(() => {
    setStatus(devStatus)
    setConfig(devConfig)
    setBaselineBaseUrls(
      Object.fromEntries(Object.entries(devConfig.providers).map(([name, provider]) => [name, provider.base_url])),
    )
    setGatewayTokenPreview('ao_dev********7f2a')
  }, [devConfig, devStatus, setBaselineBaseUrls, setConfig, setGatewayTokenPreview, setStatus])

  return {
    setSessionPreferred,
    orderedConfigProviders,
    nextProviderPlaceholder,
    applyOverride,
    setPreferred,
    setRouteMode,
    applyProviderOrder,
    onDevPreviewBootstrap,
  }
}
