import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'
import type { Config, Status } from './types'
import type { CodexSwapStatus } from './types'
import { fmtWhen } from './utils/format'
import { computeActiveRefreshDelayMs, computeIdleRefreshDelayMs } from './utils/usageRefresh'
import { ProvidersTable } from './components/ProvidersTable'
import { SessionsTable } from './components/SessionsTable'
import { EventsTable } from './components/EventsTable'
import { KeyModal } from './components/KeyModal'
import { UsageBaseModal } from './components/UsageBaseModal'
import { InstructionModal } from './components/InstructionModal'
import { GatewayTokenModal } from './components/GatewayTokenModal'
import { ConfigModal } from './components/ConfigModal'
import { CodexSwapModal } from './components/CodexSwapModal'
import { HeroCodexCard, HeroRoutingCard, HeroStatusCard } from './components/HeroCards'
import { useReorderDrag } from './hooks/useReorderDrag'

const devStatus: Status = {
  listen: { host: '127.0.0.1', port: 4000 },
  preferred_provider: 'provider_1',
  manual_override: null,
  providers: {
    provider_1: {
      status: 'healthy',
      consecutive_failures: 0,
      cooldown_until_unix_ms: 0,
      last_error: '',
      last_ok_at_unix_ms: Date.now() - 120000,
      last_fail_at_unix_ms: 0,
    },
    provider_2: {
      status: 'unknown',
      consecutive_failures: 1,
      cooldown_until_unix_ms: Date.now() + 300000,
      last_error: 'endpoint not found',
      last_ok_at_unix_ms: Date.now() - 3600000,
      last_fail_at_unix_ms: Date.now() - 240000,
    },
  },
  metrics: {
    provider_1: { ok_requests: 210, error_requests: 3, total_tokens: 128400 },
    provider_2: { ok_requests: 12, error_requests: 2, total_tokens: 3400 },
  },
  recent_events: [],
  active_provider: null,
  active_reason: null,
  quota: {
    provider_1: {
      kind: 'token_stats',
      updated_at_unix_ms: Date.now() - 90000,
      remaining: 8320,
      today_used: 2680,
      today_added: 11000,
      daily_spent_usd: null,
      daily_budget_usd: null,
      weekly_spent_usd: null,
      weekly_budget_usd: null,
      monthly_spent_usd: null,
      monthly_budget_usd: null,
      last_error: '',
      effective_usage_base: null,
    },
    provider_2: {
      kind: 'budget_info',
      updated_at_unix_ms: Date.now() - 420000,
      remaining: null,
      today_used: null,
      today_added: null,
      daily_spent_usd: 1.4,
      daily_budget_usd: 5,
      weekly_spent_usd: null,
      weekly_budget_usd: null,
      monthly_spent_usd: 12.3,
      monthly_budget_usd: 40,
      last_error: '',
      effective_usage_base: null,
    },
  },
  ledgers: {},
  last_activity_unix_ms: Date.now() - 30000,
  codex_account: {
    ok: true,
    checked_at_unix_ms: Date.now() - 90000,
    signed_in: true,
    remaining: '13%',
    limit_5h_remaining: '87%',
    limit_weekly_remaining: '13%',
    limit_weekly_reset_at: String(Date.now() + 3 * 24 * 60 * 60 * 1000),
    code_review_remaining: '92%',
    code_review_reset_at: String(Date.now() + 24 * 60 * 60 * 1000),
    unlimited: false,
  },
}

const devConfig: Config = {
  listen: { host: '127.0.0.1', port: 4000 },
  routing: {
    preferred_provider: 'provider_1',
    auto_return_to_preferred: true,
    preferred_stable_seconds: 120,
    failure_threshold: 2,
    cooldown_seconds: 120,
    request_timeout_seconds: 120,
  },
  providers: {
    provider_1: {
      display_name: 'provider_1',
      base_url: 'https://code.ppchat.vip/v1',
      usage_adapter: 'ppchat',
      usage_base_url: 'https://code.ppchat.vip',
      has_key: true,
      key_preview: 'sk-pp********c61',
      has_usage_token: false,
    },
    provider_2: {
      display_name: 'provider_2',
      base_url: 'https://codex-api.packycode.com/v1',
      usage_adapter: 'packycode',
      usage_base_url: 'https://codex-api.packycode.com',
      has_key: true,
      key_preview: 'sk-pk********mN5',
      has_usage_token: true,
    },
  },
  provider_order: ['provider_1', 'provider_2'],
}

export default function App() {
  const isDevPreview = useMemo(() => {
    if (!import.meta.env.DEV) return false
    if (typeof window === 'undefined') return false
    const w = window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }
    return !Boolean(w.__TAURI__?.core?.invoke)
  }, [])
  const [status, setStatus] = useState<Status | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [baselineBaseUrls, setBaselineBaseUrls] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<string>('')
  const [clearErrorsBeforeMs, setClearErrorsBeforeMs] = useState<number>(0)
  const [override, setOverride] = useState<string>('') // '' => auto
  const [newProviderName, setNewProviderName] = useState<string>('')
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState<string>('')
  const [providerPanelsOpen, setProviderPanelsOpen] = useState<Record<string, boolean>>({})
  const [keyModal, setKeyModal] = useState<{ open: boolean; provider: string; value: string }>({
    open: false,
    provider: '',
    value: '',
  })
  const [usageBaseModal, setUsageBaseModal] = useState<{
    open: boolean
    provider: string
    value: string
    auto: boolean
    explicitValue: string
    effectiveValue: string
  }>({
    open: false,
    provider: '',
    value: '',
    auto: false,
    explicitValue: '',
    effectiveValue: '',
  })
  const overrideDirtyRef = useRef<boolean>(false)
  const [gatewayTokenPreview, setGatewayTokenPreview] = useState<string>('')
  const [gatewayTokenReveal, setGatewayTokenReveal] = useState<string>('')
  const [gatewayModalOpen, setGatewayModalOpen] = useState<boolean>(false)
  const [configModalOpen, setConfigModalOpen] = useState<boolean>(false)
  const [instructionModalOpen, setInstructionModalOpen] = useState<boolean>(false)
  const [codexSwapModalOpen, setCodexSwapModalOpen] = useState<boolean>(false)
  const [codexSwapDir1, setCodexSwapDir1] = useState<string>('')
  const [codexSwapDir2, setCodexSwapDir2] = useState<string>('')
  const [codexSwapApplyBoth, setCodexSwapApplyBoth] = useState<boolean>(false)
  const [codexSwapStatus, setCodexSwapStatus] = useState<CodexSwapStatus | null>(null)
  const [editingProviderName, setEditingProviderName] = useState<string | null>(null)
  const [providerNameDrafts, setProviderNameDrafts] = useState<Record<string, string>>({})
  const [refreshingProviders, setRefreshingProviders] = useState<Record<string, boolean>>({})
  const [updatingSessionPref, setUpdatingSessionPref] = useState<Record<string, boolean>>({})
  const instructionBackdropMouseDownRef = useRef<boolean>(false)
  const configBackdropMouseDownRef = useRef<boolean>(false)
  const usageRefreshTimerRef = useRef<number | null>(null)
  const idleUsageSchedulerRef = useRef<(() => void) | null>(null)
  const usageActiveRef = useRef<boolean>(false)
  const activeUsageTimerRef = useRef<number | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const savedProviderPanels = window.localStorage.getItem('ao.providerPanelsOpen')
      if (savedProviderPanels) {
        const parsed = JSON.parse(savedProviderPanels) as Record<string, boolean>
        if (parsed && typeof parsed === 'object') setProviderPanelsOpen(parsed)
      }
    } catch (e) {
      console.warn('Failed to load UI prefs', e)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const d1 = window.localStorage.getItem('ao.codexSwap.dir1') ?? ''
      const d2 = window.localStorage.getItem('ao.codexSwap.dir2') ?? ''
      const both = (window.localStorage.getItem('ao.codexSwap.applyBoth') ?? '') === '1'
      setCodexSwapDir1(d1)
      setCodexSwapDir2(d2)
      setCodexSwapApplyBoth(both)
      if (!d1.trim()) {
        invoke<string>('codex_cli_default_home')
          .then((p) => setCodexSwapDir1((prev) => (prev.trim() ? prev : p)))
          .catch(() => {})
      }
    } catch (e) {
      console.warn('Failed to load Codex swap prefs', e)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const saved = window.localStorage.getItem('ao.clearErrorsBeforeMs')
      if (!saved) return
      const n = Number(saved)
      if (Number.isFinite(n) && n > 0) setClearErrorsBeforeMs(n)
    } catch (e) {
      console.warn('Failed to load UI prefs', e)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem('ao.providerPanelsOpen', JSON.stringify(providerPanelsOpen))
    } catch (e) {
      console.warn('Failed to save provider panels', e)
    }
  }, [providerPanelsOpen])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (!clearErrorsBeforeMs) {
        window.localStorage.removeItem('ao.clearErrorsBeforeMs')
        return
      }
      window.localStorage.setItem('ao.clearErrorsBeforeMs', String(clearErrorsBeforeMs))
    } catch (e) {
      console.warn('Failed to save UI prefs', e)
    }
  }, [clearErrorsBeforeMs])

  const providers = useMemo(() => {
    const statusProviders = Object.keys(status?.providers ?? {})
    if (!config) return statusProviders
    const order = config.provider_order ?? []
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const name of order) {
      if (statusProviders.includes(name) && !seen.has(name)) {
        ordered.push(name)
        seen.add(name)
      }
    }
    for (const name of statusProviders) {
      if (!seen.has(name)) ordered.push(name)
    }
    return ordered
  }, [status, config])

  const visibleEvents = useMemo(() => {
    const events = status?.recent_events ?? []
    if (!clearErrorsBeforeMs) return events
    // UI-only clear: hide errors at or before the last cleared timestamp.
    return events.filter((e) => e.level !== 'error' || e.unix_ms > clearErrorsBeforeMs)
  }, [status, clearErrorsBeforeMs])

  const canClearErrors = useMemo(() => visibleEvents.some((e) => e.level === 'error'), [visibleEvents])

  const clearErrors = useCallback(() => {
    const events = status?.recent_events ?? []
    let maxErrorUnixMs = 0
    for (const e of events) {
      if (e.level !== 'error') continue
      if (e.unix_ms > maxErrorUnixMs) maxErrorUnixMs = e.unix_ms
    }
    if (!maxErrorUnixMs) return
    setClearErrorsBeforeMs((prev) => Math.max(prev, maxErrorUnixMs))
  }, [status])

  // Keep a stable UI ordering for sessions across status polls so rows don't "jump" just because
  // a discovery timestamp updated.
  const sessionOrderRef = useRef<Record<string, number>>({})
  const sessionOrderNextRef = useRef(1)

  const clientSessions = useMemo(() => {
    const sessions = status?.client_sessions ?? []
    const order = sessionOrderRef.current
    for (const s of sessions) {
      if (order[s.id] == null) {
        order[s.id] = sessionOrderNextRef.current++
      }
    }
    return [...sessions].sort((a, b) => {
      return (order[a.id] ?? 0) - (order[b.id] ?? 0)
    })
  }, [status])

  async function setSessionPreferred(sessionId: string, provider: string | null) {
    setUpdatingSessionPref((m) => ({ ...m, [sessionId]: true }))
    try {
      // Session preferences are keyed by Codex session id (not WT_SESSION).
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
    for (const k of keys) {
      const m = /^provider_(\d+)$/.exec(k)
      if (!m) continue
      const n = Number(m[1])
      if (Number.isFinite(n) && n > maxN) maxN = n
    }
    return `provider_${maxN > 0 ? maxN + 1 : 1}`
  }, [config])

  const codexSwapBadge = useMemo(() => {
    const overall = codexSwapStatus?.overall ?? 'error'
    const badgeText =
      overall === 'swapped'
        ? 'App'
        : overall === 'original'
          ? 'User'
          : overall === 'mixed'
            ? 'Mixed'
            : 'Error'
    const parts =
      codexSwapStatus?.dirs?.length
        ? codexSwapStatus.dirs.map((d) => `${d.cli_home}: ${d.state}`)
        : []
    const badgeTitle = parts.length
      ? `Codex CLI swap status: ${badgeText}. ${parts.join(' | ')}`
      : `Codex CLI swap status: ${badgeText}`
    return { badgeText, badgeTitle }
  }, [codexSwapStatus])

  const providerDrag = useReorderDrag<string>({
    items: orderedConfigProviders,
    onReorder: (next) => void applyProviderOrder(next),
    enabled: configModalOpen,
  })
  const providerListRef = providerDrag.listRef
  const registerProviderCardRef = providerDrag.registerItemRef
  const onProviderHandlePointerDown = providerDrag.onHandlePointerDown
  const draggingProvider = providerDrag.draggingId
  const dragOverProvider = providerDrag.dragOverId
  const dragPreviewOrder = providerDrag.dragPreviewOrder
  const dragOffsetY = providerDrag.dragOffsetY
  const dragBaseTop = providerDrag.dragBaseTop
  const dragCardHeight = providerDrag.dragCardHeight

  function flashToast(msg: string, kind: 'info' | 'error' = 'info') {
    setToast(msg)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    const ms = kind === 'error' ? 5200 : 2400
    toastTimerRef.current = window.setTimeout(() => setToast(''), ms)
  }

  async function toggleCodexSwap(cliHomes: string[]) {
    const homes = cliHomes.map((s) => s.trim()).filter(Boolean)
    const res = await invoke<{ ok: boolean; mode: 'swapped' | 'restored'; cli_homes: string[] }>(
      'codex_cli_toggle_auth_config_swap',
      { cli_homes: homes },
    )
    flashToast(res.mode === 'swapped' ? 'Swapped Codex auth/config' : 'Restored Codex auth/config')
    await refreshStatus()
    await refreshCodexSwapStatus()
  }

  async function refreshCodexSwapStatus() {
    if (isDevPreview) return
    try {
      const homes = [codexSwapDir1]
      if (codexSwapApplyBoth && codexSwapDir2.trim()) homes.push(codexSwapDir2)
      const res = await invoke<CodexSwapStatus>('codex_cli_swap_status', {
        cli_homes: homes.map((s) => s.trim()).filter(Boolean),
      })
      setCodexSwapStatus(res)
    } catch {
      setCodexSwapStatus({ ok: true, overall: 'error', dirs: [] })
    }
  }

  async function refreshStatus() {
    if (isDevPreview) {
      setStatus(devStatus)
      return
    }
    try {
      const s = await invoke<Status>('get_status')
      setStatus(s)
      if (!overrideDirtyRef.current) setOverride(s.manual_override ?? '')
      // Best-effort: keep swap badge fresh on the normal status poll cadence.
      void refreshCodexSwapStatus()
    } catch (e) {
      console.error(e)
    }
  }

  async function refreshConfig() {
    if (isDevPreview) {
      setConfig(devConfig)
      setBaselineBaseUrls(
        Object.fromEntries(Object.entries(devConfig.providers).map(([name, p]) => [name, p.base_url])),
      )
      setGatewayTokenPreview('ao_dev********7f2a')
      return
    }
    try {
      const c = await invoke<Config>('get_config')
      setConfig(c)
      setBaselineBaseUrls(
        Object.fromEntries(Object.entries(c.providers).map(([name, p]) => [name, p.base_url])),
      )
      const p = await invoke<string>('get_gateway_token_preview')
      setGatewayTokenPreview(p)
    } catch (e) {
      console.error(e)
    }
  }

  async function applyOverride(next: string) {
    try {
      await invoke('set_manual_override', { provider: next === '' ? null : next })
      overrideDirtyRef.current = false
      flashToast(next === '' ? 'Routing: auto' : `Routing locked`)
      await refreshStatus()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function setPreferred(next: string) {
    await invoke('set_preferred_provider', { provider: next })
    await refreshStatus()
    await refreshConfig()
  }

  async function saveProvider(name: string) {
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
  }

  async function deleteProvider(name: string) {
    try {
      await invoke('delete_provider', { name })
      flashToast(`Deleted: ${name}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function saveKey() {
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
  }

  async function clearKey(name: string) {
    try {
      await invoke('clear_provider_key', { provider: name })
      flashToast(`Key cleared: ${name}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function refreshQuota(name: string) {
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
  }

  async function refreshQuotaAll(opts?: { silent?: boolean }) {
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
  }

  async function saveUsageBaseUrl() {
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
  }

  async function clearUsageBaseUrl(name: string) {
    try {
      await invoke('clear_usage_base_url', { provider: name })
      flashToast(`Usage base cleared: ${name}`)
      await refreshConfig()
      await refreshStatus()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function openKeyModal(provider: string) {
    setKeyModal({ open: true, provider, value: '' })
    if (isDevPreview) return
    try {
      const existing = await invoke<string | null>('get_provider_key', { provider })
      setKeyModal((m) => (m.open && m.provider === provider ? { ...m, value: existing ?? '' } : m))
    } catch (e) {
      console.warn('Failed to load provider key', e)
    }
  }

  async function openUsageBaseModal(provider: string, current: string | null | undefined) {
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

  async function addProvider() {
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
  }

  useEffect(() => {
    if (isDevPreview) {
      setStatus(devStatus)
      setConfig(devConfig)
      setBaselineBaseUrls(
        Object.fromEntries(Object.entries(devConfig.providers).map(([name, p]) => [name, p.base_url])),
      )
      setGatewayTokenPreview('ao_dev********7f2a')
      return
    }
    void refreshStatus()
    void refreshConfig()
    // Fetch usage once when opening the app, then refresh on a half-hour cadence (00/30 +/- 5 min) while idle.
    const once = window.setTimeout(() => void refreshQuotaAll({ silent: true }), 850)
    const scheduleUsageRefresh = () => {
      if (usageActiveRef.current) return
      if (usageRefreshTimerRef.current) {
        window.clearTimeout(usageRefreshTimerRef.current)
      }
      const nowMs = Date.now()
      const jitterMs = (Math.random() * 10 - 5) * 60 * 1000
      const delayMs = computeIdleRefreshDelayMs(nowMs, jitterMs)
      usageRefreshTimerRef.current = window.setTimeout(() => {
        if (usageActiveRef.current) {
          if (usageRefreshTimerRef.current) {
            window.clearTimeout(usageRefreshTimerRef.current)
            usageRefreshTimerRef.current = null
          }
          return
        }
        void refreshQuotaAll({ silent: true }).finally(() => {
          if (!usageActiveRef.current) scheduleUsageRefresh()
        })
      }, delayMs)
    }
    idleUsageSchedulerRef.current = scheduleUsageRefresh
    scheduleUsageRefresh()
    const t = setInterval(() => void refreshStatus(), 1500)
    const codexRefresh = window.setInterval(() => {
      invoke('codex_account_refresh').catch((e) => {
        console.warn('Codex refresh failed', e)
      })
    }, 5 * 60 * 1000)
    return () => {
      clearInterval(t)
      window.clearInterval(codexRefresh)
      window.clearTimeout(once)
      if (usageRefreshTimerRef.current) {
        window.clearTimeout(usageRefreshTimerRef.current)
      }
      idleUsageSchedulerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (isDevPreview) return
    // While actively used, refresh usage every 5 minutes.
    const lastActivity = status?.last_activity_unix_ms ?? 0
    const isActive = lastActivity > 0 && Date.now() - lastActivity <= 5 * 60 * 1000
    usageActiveRef.current = isActive
    if (isActive && usageRefreshTimerRef.current) {
      window.clearTimeout(usageRefreshTimerRef.current)
      usageRefreshTimerRef.current = null
    }
    const clearActiveTimer = () => {
      if (activeUsageTimerRef.current) {
        window.clearTimeout(activeUsageTimerRef.current)
        activeUsageTimerRef.current = null
      }
    }
    if (!isActive) {
      clearActiveTimer()
      if (!usageRefreshTimerRef.current && idleUsageSchedulerRef.current) idleUsageSchedulerRef.current()
      return
    }
    if (!activeUsageTimerRef.current) {
      const schedule = () => {
        const jitterMs = (Math.random() * 2 - 1) * 60 * 1000
        const delayMs = computeActiveRefreshDelayMs(jitterMs)
        activeUsageTimerRef.current = window.setTimeout(() => {
          if (!usageActiveRef.current) {
            if (idleUsageSchedulerRef.current) idleUsageSchedulerRef.current()
            return
          }
          void refreshQuotaAll({ silent: true }).finally(() => {
            if (usageActiveRef.current) schedule()
          })
        }, delayMs)
      }
      schedule()
    }
    return () => {
      clearActiveTimer()
    }
  }, [isDevPreview, status?.last_activity_unix_ms])

  const isProviderOpen = useCallback(
    (name: string) => providerPanelsOpen[name] ?? true,
    [providerPanelsOpen],
  )

  const toggleProviderOpen = useCallback((name: string) => {
    setProviderPanelsOpen((prev) => ({ ...prev, [name]: !(prev[name] ?? true) }))
  }, [])

  const setAllProviderPanels = useCallback((open: boolean) => {
    setProviderPanelsOpen((prev) => {
      const next: Record<string, boolean> = { ...prev }
      for (const name of orderedConfigProviders) {
        next[name] = open
      }
      return next
    })
  }, [config, orderedConfigProviders])

  const allProviderPanelsOpen = useMemo(
    () => orderedConfigProviders.every((name) => providerPanelsOpen[name] ?? true),
    [orderedConfigProviders, providerPanelsOpen],
  )
  const beginRenameProvider = useCallback((name: string) => {
    setEditingProviderName(name)
    setProviderNameDrafts((prev) => ({ ...prev, [name]: prev[name] ?? name }))
  }, [])

  const commitRenameProvider = useCallback(
    async (name: string) => {
      const next = (providerNameDrafts[name] ?? '').trim()
      setEditingProviderName(null)
      if (!next || next === name) {
        setProviderNameDrafts((prev) => ({ ...prev, [name]: name }))
        return
      }
      try {
        await invoke('rename_provider', { oldName: name, newName: next })
        setProviderPanelsOpen((prev) => {
          if (!(name in prev)) return prev
          const { [name]: value, ...rest } = prev
          return { ...rest, [next]: value }
        })
        flashToast(`Renamed: ${name} -> ${next}`)
      } catch (e) {
        flashToast(String(e), 'error')
      }
      await refreshStatus()
      await refreshConfig()
    },
    [providerNameDrafts, refreshConfig, refreshStatus],
  )

  const renderProviderCard = useCallback(
    (name: string, overlay = false) => {
      const p = config?.providers?.[name]
      if (!p) return null
      const isDragOver = dragOverProvider === name
      const dragStyle = overlay
        ? {
            position: 'absolute' as const,
            left: 0,
            right: 0,
            top: dragBaseTop,
            transform: `translateY(${dragOffsetY}px)`,
          }
        : undefined
      return (
        <div
          className={`aoProviderConfigCard${overlay ? ' aoProviderConfigDragging' : ''}${isDragOver && !overlay ? ' aoProviderConfigDragOver' : ''}${!isProviderOpen(name) ? ' aoProviderConfigCollapsed' : ''}`}
          key={overlay ? `${name}-drag` : name}
          data-provider={overlay ? undefined : name}
          ref={overlay ? undefined : registerProviderCardRef(name)}
          style={dragStyle}
        >
          <div className="aoProviderConfigBody">
            <div className="aoProviderField aoProviderLeft">
              <div className="aoProviderHeadRow">
                <div className="aoProviderNameRow">
                  <button
                    className="aoDragHandle"
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                    type="button"
                    draggable={false}
                    onPointerDown={(e) => onProviderHandlePointerDown(name, e)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 7h16" />
                      <path d="M4 12h16" />
                      <path d="M4 17h16" />
                    </svg>
                  </button>
                  {editingProviderName === name ? (
                    <input
                      className="aoNameInput"
                      value={providerNameDrafts[name] ?? name}
                      onChange={(e) =>
                        setProviderNameDrafts((prev) => ({
                          ...prev,
                          [name]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          void commitRenameProvider(name)
                        } else if (e.key === 'Escape') {
                          setEditingProviderName(null)
                          setProviderNameDrafts((prev) => ({ ...prev, [name]: name }))
                        }
                      }}
                      onBlur={() => void commitRenameProvider(name)}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="aoProviderName">{name}</span>
                      <button
                        className="aoIconGhost"
                        title="Rename"
                        aria-label="Rename"
                        onClick={() => beginRenameProvider(name)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
                <div className="aoProviderHeadActions">
                  {p.base_url !== (baselineBaseUrls[name] ?? '') ? (
                    <button className="aoActionBtn" title="Save" onClick={() => void saveProvider(name)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
                        <path d="M17 21v-8H7v8" />
                        <path d="M7 3v5h8" />
                      </svg>
                      <span>Save</span>
                    </button>
                  ) : null}
                  <button className="aoActionBtn" title="Set key" onClick={() => void openKeyModal(name)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <g transform="rotate(-28 12 12)">
                        <circle cx="7.2" cy="12" r="3.2" />
                        <circle cx="7.2" cy="12" r="1.15" />
                        <path d="M10.8 12H21" />
                        <path d="M17.2 12v2.4" />
                        <path d="M19.2 12v3.4" />
                      </g>
                    </svg>
                    <span>Key</span>
                  </button>
                  <button className="aoActionBtn" title="Clear key" onClick={() => void clearKey(name)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m7 21-4-4a2 2 0 0 1 0-3l10-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8" />
                      <path d="M6 18h8" />
                    </svg>
                    <span>Clear</span>
                  </button>
                  <button
                    className="aoActionBtn aoActionBtnDanger"
                    title="Delete provider"
                    aria-label="Delete provider"
                    onClick={() => void deleteProvider(name)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M19 6 18 20H6L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                  </button>
                </div>
              </div>
              {isProviderOpen(name) ? (
                <>
                  <div className="aoMiniLabel">Base URL</div>
                  <input
                    className="aoInput aoUrlInput"
                    value={p.base_url}
                    onChange={(e) =>
                      setConfig((c) =>
                        c
                          ? {
                              ...c,
                              providers: {
                                ...c.providers,
                                [name]: { ...c.providers[name], base_url: e.target.value },
                              },
                            }
                          : c,
                      )
                    }
                  />
                  <div className="aoMiniLabel">Key</div>
                  <div className="aoKeyValue">
                    {p.has_key ? (p.key_preview ? p.key_preview : 'set') : 'empty'}
                  </div>
                </>
              ) : null}
            </div>
            <div className="aoProviderField aoProviderRight">
              <div className="aoUsageControlsHeader">
                <div className="aoMiniLabel">Usage controls</div>
                <button className="aoTinyBtn aoToggleBtn" onClick={() => toggleProviderOpen(name)}>
                  {isProviderOpen(name) ? 'Hide' : 'Show'}
                </button>
              </div>
              {isProviderOpen(name) ? (
                <>
                  <div className="aoUsageBtns">
                    <button
                      className="aoTinyBtn"
                      onClick={() => void openUsageBaseModal(name, p.usage_base_url)}
                    >
                      Usage Base
                    </button>
                    {p.usage_base_url ? (
                      <button className="aoTinyBtn" onClick={() => void clearUsageBaseUrl(name)}>
                        Clear
                      </button>
                    ) : null}
                  </div>
                  <div className="aoHint">
                    Usage base sets the usage endpoint. If empty, we use the provider base URL.
                  </div>
                  <div className="aoHint">
                    updated:{' '}
                    {status?.quota?.[name]?.updated_at_unix_ms
                      ? fmtWhen(status.quota[name].updated_at_unix_ms)
                      : 'never'}
                  </div>
                  {status?.quota?.[name]?.last_error ? (
                    <div className="aoUsageErr">{status.quota[name].last_error}</div>
                  ) : null}
                </>
              ) : (
                <div className="aoHint">Details hidden</div>
              )}
            </div>
          </div>
        </div>
      )
    },
    [
      baselineBaseUrls,
      beginRenameProvider,
      clearKey,
      clearUsageBaseUrl,
      commitRenameProvider,
      config,
      deleteProvider,
      dragBaseTop,
      dragOffsetY,
      dragOverProvider,
      isProviderOpen,
      onProviderHandlePointerDown,
      openKeyModal,
      openUsageBaseModal,
      registerProviderCardRef,
      providerNameDrafts,
      setConfig,
      toggleProviderOpen,
      status,
    ],
  )
  return (
    <div className="aoRoot" ref={containerRef}>
      <div className="aoScale">
        <div className="aoShell" ref={contentRef}>
          {toast ? (
            <div className="aoToast" role="status" aria-live="polite">
              {toast}
            </div>
          ) : null}
          <div className="aoBrand">
            <div className="aoBrandLeft">
              <img className="aoMark" src="/ao-icon.png" alt="API Router icon" />
              <div>
                <div className="aoTitle">API Router</div>
                <div className="aoSubtitle">Local gateway + smart failover for Codex</div>
              </div>
            </div>
            <div className="aoBrandRight">
              <button className="aoTinyBtn" onClick={() => setInstructionModalOpen(true)}>
                Getting Started
              </button>
            </div>
          </div>

          {/* Surface errors via toast to avoid layout shifts. */}

          {!status ? (
            <div className="aoHint">Loading...</div>
          ) : (
            <>
              <div className="aoHero">
                <HeroStatusCard
                  status={status}
                  gatewayTokenPreview={gatewayTokenPreview}
                  onCopyToken={() => {
                    void (async () => {
                      try {
                        const tok = await invoke<string>('get_gateway_token')
                        await navigator.clipboard.writeText(tok)
                        flashToast('Gateway token copied')
                      } catch (e) {
                        flashToast(String(e), 'error')
                      }
                    })()
                  }}
                  onShowRotate={() => {
                    setGatewayModalOpen(true)
                    setGatewayTokenReveal('')
                  }}
                />
                <HeroCodexCard
                  status={status}
                  onLoginLogout={() => {
                    void (async () => {
                      try {
                        if (status.codex_account?.signed_in) {
                          await invoke('codex_account_logout')
                          flashToast('Codex logged out')
                        } else {
                          await invoke('codex_account_login')
                          flashToast('Codex login opened in browser')
                        }
                      } catch (e) {
                        flashToast(String(e), 'error')
                      }
                    })()
                  }}
                  onRefresh={() => {
                    flashToast('Checking...')
                    invoke('codex_account_refresh')
                      .then(() => refreshStatus())
                      .catch((e) => {
                        flashToast(String(e), 'error')
                      })
                  }}
                  onSwapAuthConfig={() => {
                    void (async () => {
                      try {
                        const homes = [codexSwapDir1]
                        if (codexSwapApplyBoth && codexSwapDir2.trim()) homes.push(codexSwapDir2)
                        await toggleCodexSwap(homes)
                      } catch (e) {
                        flashToast(String(e), 'error')
                      }
                    })()
                  }}
                  onSwapOptions={() => setCodexSwapModalOpen(true)}
                  swapBadgeText={codexSwapBadge.badgeText}
                  swapBadgeTitle={codexSwapBadge.badgeTitle}
                />
                <HeroRoutingCard
                  config={config}
                  providers={providers}
                  override={override}
                  onOverrideChange={(next) => {
                    setOverride(next)
                    overrideDirtyRef.current = true
                    void applyOverride(next)
                  }}
                  onPreferredChange={(next) => void setPreferred(next)}
                />
              </div>

              <div className="aoSection">
                <div className="aoSectionHeader aoSectionHeaderStack">
                  <div className="aoRow">
                    <h3 className="aoH3">Providers</h3>
                    <button
                      className="aoIconGhost"
                      title="Config"
                      aria-label="Config"
                      onClick={() => setConfigModalOpen(true)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                      </svg>
                    </button>
                  </div>
                </div>
                <ProvidersTable providers={providers} status={status} refreshingProviders={refreshingProviders} onRefreshQuota={(name) => void refreshQuota(name)} />
              </div>

              <div className="aoSection">
                <div className="aoSectionHeader">
                  <div className="aoRow">
                    <h3 className="aoH3">Sessions</h3>
                  </div>
                </div>
                <SessionsTable
                  sessions={clientSessions ?? []}
                  providers={providers}
                  globalPreferred={status.preferred_provider}
                  updating={updatingSessionPref}
                  onSetPreferred={(sessionId, provider) => void setSessionPreferred(sessionId, provider)}
                />
              </div>

              <div className="aoSection">
                <div className="aoSectionHeader">
                  <div className="aoRow">
                    <h3 className="aoH3">Events</h3>
                  </div>
                </div>
                <EventsTable events={visibleEvents} canClearErrors={canClearErrors} onClearErrors={clearErrors} />
              </div>

            </>
          )}
        </div>
      </div>

      <KeyModal
        open={keyModal.open}
        provider={keyModal.provider}
        value={keyModal.value}
        onChange={(value) => setKeyModal((m) => ({ ...m, value }))}
        onCancel={() => setKeyModal({ open: false, provider: '', value: '' })}
        onSave={() => void saveKey()}
      />

      <UsageBaseModal
        open={usageBaseModal.open}
        provider={usageBaseModal.provider}
        value={usageBaseModal.value}
        explicitValue={usageBaseModal.explicitValue}
        onChange={(value) =>
          setUsageBaseModal((m) => ({
            ...m,
            value,
            auto: false,
            explicitValue: value,
          }))
        }
        onCancel={() =>
          setUsageBaseModal({
            open: false,
            provider: '',
            value: '',
            auto: false,
            explicitValue: '',
            effectiveValue: '',
          })
        }
        onClear={() => void clearUsageBaseUrl(usageBaseModal.provider)}
        onSave={() => void saveUsageBaseUrl()}
      />

      <InstructionModal
        open={instructionModalOpen}
        onClose={() => setInstructionModalOpen(false)}
        onBackdropMouseDown={(e) => {
          instructionBackdropMouseDownRef.current = e.target === e.currentTarget
        }}
        onBackdropMouseUp={(e) => {
          const shouldClose = instructionBackdropMouseDownRef.current && e.target === e.currentTarget
          instructionBackdropMouseDownRef.current = false
          if (shouldClose) setInstructionModalOpen(false)
        }}
        codeText={`model_provider = "api_router"

[model_providers.api_router]
name = "API Router"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true`}
      />

      <ConfigModal
        open={configModalOpen}
        config={config}
        allProviderPanelsOpen={allProviderPanelsOpen}
        setAllProviderPanels={setAllProviderPanels}
        newProviderName={newProviderName}
        newProviderBaseUrl={newProviderBaseUrl}
        nextProviderPlaceholder={nextProviderPlaceholder}
        setNewProviderName={setNewProviderName}
        setNewProviderBaseUrl={setNewProviderBaseUrl}
        onAddProvider={() => void addProvider()}
        onClose={() => setConfigModalOpen(false)}
        providerListRef={providerListRef}
        orderedConfigProviders={orderedConfigProviders}
        dragPreviewOrder={dragPreviewOrder}
        draggingProvider={draggingProvider}
        dragCardHeight={dragCardHeight}
        renderProviderCard={renderProviderCard}
        onBackdropMouseDown={(e) => {
          configBackdropMouseDownRef.current = e.target === e.currentTarget
        }}
        onBackdropMouseUp={(e) => {
          const shouldClose = configBackdropMouseDownRef.current && e.target === e.currentTarget
          configBackdropMouseDownRef.current = false
          if (shouldClose) setConfigModalOpen(false)
        }}
      />

      <GatewayTokenModal
        open={gatewayModalOpen}
        tokenPreview={gatewayTokenPreview}
        tokenReveal={gatewayTokenReveal}
        onClose={() => {
          setGatewayModalOpen(false)
          setGatewayTokenReveal('')
        }}
        onReveal={async () => {
          const t = await invoke<string>('get_gateway_token')
          setGatewayTokenReveal(t)
        }}
        onRotate={async () => {
          const t = await invoke<string>('rotate_gateway_token')
          setGatewayTokenReveal(t)
          const p = await invoke<string>('get_gateway_token_preview')
          setGatewayTokenPreview(p)
          flashToast('Gateway token rotated')
        }}
      />

      <CodexSwapModal
        open={codexSwapModalOpen}
        dir1={codexSwapDir1}
        dir2={codexSwapDir2}
        applyBoth={codexSwapApplyBoth}
        onChangeDir1={(v) => setCodexSwapDir1(v)}
        onChangeDir2={(v) => {
          setCodexSwapDir2(v)
          if (!v.trim()) setCodexSwapApplyBoth(false)
        }}
        onChangeApplyBoth={(v) => setCodexSwapApplyBoth(v)}
        onCancel={() => setCodexSwapModalOpen(false)}
        onApply={() => {
          void (async () => {
            try {
              const dir1 = codexSwapDir1.trim()
              const dir2 = codexSwapDir2.trim()
              if (!dir1) throw new Error('Dir 1 is required')
              if (codexSwapApplyBoth && !dir2) throw new Error('Dir 2 is empty')

              window.localStorage.setItem('ao.codexSwap.dir1', dir1)
              window.localStorage.setItem('ao.codexSwap.dir2', dir2)
              window.localStorage.setItem('ao.codexSwap.applyBoth', codexSwapApplyBoth ? '1' : '0')

              const homes = [dir1]
              if (codexSwapApplyBoth) homes.push(dir2)
              await toggleCodexSwap(homes)
              setCodexSwapModalOpen(false)
            } catch (e) {
              flashToast(String(e), 'error')
            }
          })()
        }}
      />
    </div>
  )
}
