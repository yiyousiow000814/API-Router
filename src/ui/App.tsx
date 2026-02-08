import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import './App.css'
import type { CodexSwapStatus, Config, ProviderSwitchboardStatus, Status, UsageStatistics } from './types'
import { fmtAmount, fmtPct, fmtUsd, fmtWhen, pctOf } from './utils/format'
import { normalizePathForCompare } from './utils/path'
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
import { ModalBackdrop } from './components/ModalBackdrop'
import { HeroCodexCard, HeroRoutingCard, HeroStatusCard } from './components/HeroCards'
import { useReorderDrag } from './hooks/useReorderDrag'

type TopPage = 'dashboard' | 'usage_statistics' | 'provider_switchboard'

type UsagePricingMode = 'none' | 'per_request' | 'package_total'
type UsagePricingDraft = {
  mode: UsagePricingMode
  amountText: string
  currency: string
}

type SpendHistoryRow = {
  provider: string
  day_key: string
  req_count: number
  total_tokens: number
  tracked_total_usd?: number | null
  manual_total_usd?: number | null
  manual_usd_per_req?: number | null
  effective_total_usd?: number | null
  effective_usd_per_req?: number | null
  source?: string | null
  updated_at_unix_ms?: number
}

type FxUsdPayload = {
  date?: string
  usd?: Record<string, number>
}

const FX_RATES_CACHE_KEY = 'ao.fx.usd.daily.v1'
const FX_CURRENCY_PREF_KEY_PREFIX = 'ao.usagePricing.currency.'

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
  const [codexRefreshing, setCodexRefreshing] = useState<boolean>(false)
  const [activePage, setActivePage] = useState<TopPage>('dashboard')
  const [providerSwitchStatus, setProviderSwitchStatus] = useState<ProviderSwitchboardStatus | null>(null)
  const [providerSwitchBusy, setProviderSwitchBusy] = useState<boolean>(false)
  const [usageStatistics, setUsageStatistics] = useState<UsageStatistics | null>(null)
  const [usageWindowHours, setUsageWindowHours] = useState<number>(24)
  const [usageFilterProviders, setUsageFilterProviders] = useState<string[]>([])
  const [usageFilterModels, setUsageFilterModels] = useState<string[]>([])
  const [usageStatisticsLoading, setUsageStatisticsLoading] = useState<boolean>(false)
  const [usagePricingModalOpen, setUsagePricingModalOpen] = useState<boolean>(false)
  const [usagePricingDrafts, setUsagePricingDrafts] = useState<Record<string, UsagePricingDraft>>({})
  const [usageHistoryModalOpen, setUsageHistoryModalOpen] = useState<boolean>(false)
  const [usageHistoryRows, setUsageHistoryRows] = useState<SpendHistoryRow[]>([])
  const [usageHistoryDrafts, setUsageHistoryDrafts] = useState<
    Record<string, { totalText: string; reqText: string }>
  >({})
  const [usageHistoryLoading, setUsageHistoryLoading] = useState<boolean>(false)
  const [usagePricingCurrencyMenu, setUsagePricingCurrencyMenu] = useState<{
    provider: string
    left: number
    top: number
    width: number
  } | null>(null)
  const [usagePricingCurrencyQuery, setUsagePricingCurrencyQuery] = useState<string>('')
  const [fxRatesByCurrency, setFxRatesByCurrency] = useState<Record<string, number>>({ USD: 1 })
  const [fxRatesDate, setFxRatesDate] = useState<string>('')
  const [usageChartHover, setUsageChartHover] = useState<{
    x: number
    y: number
    title: string
    subtitle: string
  } | null>(null)
  const [updatingSessionPref, setUpdatingSessionPref] = useState<Record<string, boolean>>({})
  const usageRefreshTimerRef = useRef<number | null>(null)
  const idleUsageSchedulerRef = useRef<(() => void) | null>(null)
  const usageActiveRef = useRef<boolean>(false)
  const activeUsageTimerRef = useRef<number | null>(null)
  const providerSwitchRefreshTimerRef = useRef<number | null>(null)
  const providerSwitchDirWatcherPrimedRef = useRef<boolean>(false)
  const usagePricingDraftsPrimedRef = useRef<boolean>(false)
  const codexSwapDir1Ref = useRef<string>('')
  const codexSwapDir2Ref = useRef<string>('')
  const codexSwapApplyBothRef = useRef<boolean>(false)
  const swapPrefsLoadedRef = useRef<boolean>(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const mainAreaRef = useRef<HTMLDivElement | null>(null)
  const usagePricingCurrencyMenuRef = useRef<HTMLDivElement | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const scrollToTop = useCallback(() => {
    const root = containerRef.current
    if (root) root.scrollTop = 0
    const main = mainAreaRef.current
    if (main) main.scrollTop = 0
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    }
  }, [])

  const switchPage = useCallback(
    (next: TopPage) => {
      setActivePage(next)
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          scrollToTop()
        })
      }
    },
    [scrollToTop],
  )

  useEffect(() => {
    scrollToTop()
  }, [scrollToTop])

  useEffect(() => {
    scrollToTop()
  }, [activePage, scrollToTop])

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
      swapPrefsLoadedRef.current = true
    } catch (e) {
      console.warn('Failed to load Codex swap prefs', e)
      swapPrefsLoadedRef.current = true
    }
  }, [])

  // Keep refs in sync so background refresh (interval) never uses stale closures.
  useEffect(() => {
    codexSwapDir1Ref.current = codexSwapDir1
  }, [codexSwapDir1])
  useEffect(() => {
    codexSwapDir2Ref.current = codexSwapDir2
  }, [codexSwapDir2])
  useEffect(() => {
    codexSwapApplyBothRef.current = codexSwapApplyBoth
  }, [codexSwapApplyBoth])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!swapPrefsLoadedRef.current) return
    try {
      window.localStorage.setItem('ao.codexSwap.dir1', codexSwapDir1)
      window.localStorage.setItem('ao.codexSwap.dir2', codexSwapDir2)
      window.localStorage.setItem('ao.codexSwap.applyBoth', codexSwapApplyBoth ? '1' : '0')
    } catch (e) {
      console.warn('Failed to save Codex swap prefs', e)
    }
  }, [codexSwapDir1, codexSwapDir2, codexSwapApplyBoth])

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
    if (!codexSwapStatus) {
      return { badgeText: '', badgeTitle: 'Codex CLI swap status: loading' }
    }
    const overall = codexSwapStatus.overall
    const badgeText =
      overall === 'swapped'
        ? 'Auth'
        : overall === 'original'
          ? 'API'
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

  function resolveCliHomes(dir1: string, dir2: string, applyBoth: boolean): string[] {
    const first = dir1.trim()
    const second = dir2.trim()
    if (!first) return []
    if (!applyBoth || !second) return [first]
    if (normalizePathForCompare(first) === normalizePathForCompare(second)) return [first]
    return [first, second]
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
      const homes = resolveCliHomes(
        codexSwapDir1Ref.current,
        codexSwapDir2Ref.current,
        codexSwapApplyBothRef.current,
      )
      const res = await invoke<CodexSwapStatus>('codex_cli_swap_status', {
        cli_homes: homes,
      })
      setCodexSwapStatus(res)
    } catch {
      setCodexSwapStatus({ ok: true, overall: 'error', dirs: [] })
    }
  }

  async function refreshProviderSwitchStatus() {
    const homes = resolveCliHomes(
      codexSwapDir1Ref.current,
      codexSwapDir2Ref.current,
      codexSwapApplyBothRef.current,
    )
    if (isDevPreview) {
      setProviderSwitchStatus({
        ok: true,
        mode: 'gateway',
        model_provider: 'api_router',
        dirs: homes.map((h) => ({ cli_home: h, mode: 'gateway', model_provider: null })),
        provider_options: (devConfig.provider_order ?? []).filter((n) => n !== 'official'),
      })
      return
    }
    try {
      const res = await invoke<ProviderSwitchboardStatus>('provider_switchboard_status', {
        cli_homes: homes,
      })
      setProviderSwitchStatus(res)
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function refreshUsageStatistics(options?: { silent?: boolean }) {
    const silent = options?.silent === true
    if (isDevPreview) {
      const now = Date.now()
      setUsageStatistics({
        ok: true,
        generated_at_unix_ms: now,
        window_hours: usageWindowHours,
        filter: {
          providers: usageFilterProviders,
          models: usageFilterModels,
        },
        catalog: {
          providers: ['provider_1', 'provider_2'],
          models: ['gpt-5.x', 'gpt-4.1'],
        },
        bucket_seconds: usageWindowHours <= 48 ? 3600 : 86400,
        summary: {
          total_requests: 222,
          total_tokens: 131800,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          unique_models: 2,
          estimated_total_cost_usd: 9.24,
          estimated_daily_cost_usd: 9.24,
          by_model: [
            {
              model: 'gpt-5.x',
              requests: 180,
              input_tokens: 70000,
              output_tokens: 40000,
              total_tokens: 110000,
              share_pct: 81.08,
              estimated_total_cost_usd: 7.42,
              estimated_avg_request_cost_usd: 0.041,
              estimated_cost_request_count: 180,
            },
            {
              model: 'gpt-4.1',
              requests: 42,
              input_tokens: 14000,
              output_tokens: 7800,
              total_tokens: 21800,
              share_pct: 18.92,
              estimated_total_cost_usd: 1.82,
              estimated_avg_request_cost_usd: 0.043,
              estimated_cost_request_count: 42,
            },
          ],
          by_provider: [
            {
              provider: 'provider_1',
              requests: 210,
              total_tokens: 128400,
              estimated_total_cost_usd: 8.51,
              estimated_avg_request_cost_usd: 0.041,
              estimated_cost_request_count: 210,
            },
            {
              provider: 'provider_2',
              requests: 12,
              total_tokens: 3400,
              estimated_total_cost_usd: 0.73,
              estimated_avg_request_cost_usd: 0.061,
              estimated_cost_request_count: 12,
            },
          ],
          timeline: Array.from({ length: usageWindowHours <= 48 ? 24 : 7 }).map((_, index) => ({
            bucket_unix_ms:
              now -
              (usageWindowHours <= 48
                ? (23 - index) * 60 * 60 * 1000
                : (6 - index) * 24 * 60 * 60 * 1000),
            requests: Math.max(1, Math.round(6 + Math.sin(index / 2) * 4)),
            total_tokens: Math.max(100, Math.round(3200 + Math.cos(index / 2.2) * 1600)),
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
          })),
        },
      })
      return
    }
    if (!silent) setUsageStatisticsLoading(true)
    try {
      const res = await invoke<UsageStatistics>('get_usage_statistics', {
        hours: usageWindowHours,
        providers: usageFilterProviders.length ? usageFilterProviders : null,
        models: usageFilterModels.length ? usageFilterModels : null,
      })
      setUsageStatistics(res)
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      if (!silent) setUsageStatisticsLoading(false)
    }
  }

  const usageCurrencyOptions = useMemo(() => {
    const all = Object.keys(fxRatesByCurrency)
      .map((code) => code.toUpperCase())
      .filter((code) => /^[A-Z]{3}$/.test(code))
    const unique = Array.from(new Set(all))
    const preferred = ['USD', 'CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD', 'MYR']
    const sorted = unique.sort((a, b) => a.localeCompare(b))
    const head = preferred.filter((code) => sorted.includes(code))
    const tail = sorted.filter((code) => !head.includes(code))
    return [...head, ...tail]
  }, [fxRatesByCurrency])

  function normalizeCurrencyCode(code: string): string {
    const raw = code.trim().toUpperCase()
    const next = raw === 'RMB' ? 'CNY' : raw
    return /^[A-Z]{3}$/.test(next) ? next : 'USD'
  }

  function currencyLabel(code: string): string {
    return code === 'CNY' ? 'RMB' : code
  }

  function updateUsagePricingCurrency(providerName: string, draft: UsagePricingDraft, nextCurrency: string) {
    const raw = normalizeCurrencyCode(nextCurrency)
    setUsagePricingDrafts((prev) => ({
      ...prev,
      [providerName]: (() => {
        const cur = prev[providerName] ?? draft
        const oldCurrency = normalizeCurrencyCode(cur.currency)
        const amountRaw = Number(cur.amountText)
        const nextAmount =
          Number.isFinite(amountRaw) && amountRaw > 0
            ? formatDraftAmount(convertUsdToCurrency(convertCurrencyToUsd(amountRaw, oldCurrency), raw))
            : cur.amountText
        return {
          ...cur,
          currency: raw,
          amountText: nextAmount,
        }
      })(),
    }))
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`${FX_CURRENCY_PREF_KEY_PREFIX}${providerName}`, raw)
    }
  }

  function currencyRate(code: string): number {
    const norm = normalizeCurrencyCode(code)
    const rate = fxRatesByCurrency[norm]
    if (!Number.isFinite(rate) || rate <= 0) return 1
    return rate
  }

  function convertUsdToCurrency(usdAmount: number, currency: string): number {
    return usdAmount * currencyRate(currency)
  }

  function convertCurrencyToUsd(amount: number, currency: string): number {
    return amount / currencyRate(currency)
  }

  function formatDraftAmount(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return ''
    const fixed = value.toFixed(4)
    return fixed.replace(/\.?0+$/, '')
  }

  const closeUsagePricingCurrencyMenu = useCallback(() => {
    setUsagePricingCurrencyMenu(null)
    setUsagePricingCurrencyQuery('')
  }, [])

  async function refreshFxRatesDaily(force = false) {
    const today = new Date().toISOString().slice(0, 10)
    if (!force && typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(FX_RATES_CACHE_KEY)
        if (raw) {
          const cached = JSON.parse(raw) as { date?: string; rates?: Record<string, number> }
          if (cached?.date === today && cached.rates && Number.isFinite(cached.rates.USD)) {
            setFxRatesByCurrency(cached.rates)
            setFxRatesDate(cached.date)
            return
          }
        }
      } catch (e) {
        console.warn('Failed to read FX cache', e)
      }
    }
    const endpoints = [
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    ]
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, { cache: 'no-store' })
        if (!res.ok) continue
        const payload = (await res.json()) as FxUsdPayload
        const usdMap = payload?.usd ?? {}
        const rates: Record<string, number> = { USD: 1 }
        Object.entries(usdMap).forEach(([code, value]) => {
          const norm = code.trim().toUpperCase()
          if (!/^[A-Z]{3}$/.test(norm)) return
          if (!Number.isFinite(value) || value <= 0) return
          rates[norm] = value
        })
        if (!Object.keys(rates).length) continue
        const date = (payload?.date ?? today).slice(0, 10)
        setFxRatesByCurrency(rates)
        setFxRatesDate(date)
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(FX_RATES_CACHE_KEY, JSON.stringify({ date, rates }))
        }
        return
      } catch (e) {
        console.warn('FX fetch failed', endpoint, e)
      }
    }
  }

  async function saveUsagePricingRow(providerName: string) {
    const draft = usagePricingDrafts[providerName]
    if (!draft) return
    const mode = draft.mode
    try {
      if (mode === 'none') {
        await invoke('set_provider_manual_pricing', {
          provider: providerName,
          mode: 'none',
          amountUsd: null,
        })
      } else {
        const amountRaw = Number(draft.amountText)
        if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
          flashToast('Pricing amount must be > 0', 'error')
          return
        }
        const amountUsd = convertCurrencyToUsd(amountRaw, draft.currency)
        await invoke('set_provider_manual_pricing', {
          provider: providerName,
          mode,
          amountUsd,
        })
      }
      await invoke('set_provider_gap_fill', {
        provider: providerName,
        mode: 'none',
        amountUsd: null,
      })
      flashToast(`Pricing saved: ${providerName}`)
      await refreshConfig()
      await refreshUsageStatistics()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function refreshUsageHistory(options?: { silent?: boolean }) {
    const silent = options?.silent === true
    if (!silent) setUsageHistoryLoading(true)
    try {
      const res = await invoke<{ ok: boolean; rows: SpendHistoryRow[] }>('get_spend_history', {
        provider: null,
        days: 180,
      })
      const rows = Array.isArray(res?.rows) ? res.rows : []
      setUsageHistoryRows(rows)
      setUsageHistoryDrafts((prev) => {
        const next: Record<string, { totalText: string; reqText: string }> = { ...prev }
        for (const row of rows) {
          const key = `${row.provider}|${row.day_key}`
          if (next[key]) continue
          next[key] = {
            totalText:
              row.manual_total_usd != null && Number.isFinite(row.manual_total_usd)
                ? formatDraftAmount(row.manual_total_usd)
                : '',
            reqText:
              row.manual_usd_per_req != null && Number.isFinite(row.manual_usd_per_req)
                ? formatDraftAmount(row.manual_usd_per_req)
                : '',
          }
        }
        return next
      })
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      if (!silent) setUsageHistoryLoading(false)
    }
  }

  async function saveUsageHistoryRow(row: SpendHistoryRow) {
    const key = `${row.provider}|${row.day_key}`
    const draft = usageHistoryDrafts[key] ?? { totalText: '', reqText: '' }
    const totalRaw = Number(draft.totalText)
    const reqRaw = Number(draft.reqText)
    const totalUsedUsd = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : null
    const usdPerReq = Number.isFinite(reqRaw) && reqRaw > 0 ? reqRaw : null
    try {
      await invoke('set_spend_history_entry', {
        provider: row.provider,
        dayKey: row.day_key,
        totalUsedUsd,
        usdPerReq,
      })
      flashToast(`History saved: ${row.provider} ${row.day_key}`)
      await refreshUsageHistory({ silent: true })
      await refreshUsageStatistics({ silent: true })
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function setProviderSwitchTarget(target: 'gateway' | 'official' | 'provider', provider?: string) {
    const homes = resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapApplyBoth)
    setProviderSwitchBusy(true)
    try {
      const res = await invoke<ProviderSwitchboardStatus>('provider_switchboard_set_target', {
        cli_homes: homes,
        target,
        provider: provider ?? null,
      })
      setProviderSwitchStatus(res)
      const msg =
        target === 'provider'
          ? `Switched to provider: ${provider}`
          : target === 'gateway'
            ? 'Switched to gateway'
            : 'Switched to official'
      flashToast(msg)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      setProviderSwitchBusy(false)
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
      void refreshProviderSwitchStatus()
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
      const homes = resolveCliHomes(
        codexSwapDir1Ref.current,
        codexSwapDir2Ref.current,
        codexSwapApplyBothRef.current,
      )
      if (homes.length > 0) {
        void refreshProviderSwitchStatus()
      }
    } catch (e) {
      console.error(e)
    }
  }

  const switchboardProviders = useMemo(() => {
    const fromStatus = providerSwitchStatus?.provider_options ?? []
    const base = fromStatus.length ? fromStatus : orderedConfigProviders
    return base.filter((name) => name !== 'official')
  }, [providerSwitchStatus, orderedConfigProviders])

  const switchboardProviderCards = useMemo(() => {
    return switchboardProviders.map((name) => {
      const providerCfg = config?.providers?.[name]
      const quota = status?.quota?.[name]
      const kind = (quota?.kind ?? 'none') as 'none' | 'token_stats' | 'budget_info'
      let usageHeadline = 'No usage data'
      let usageDetail = 'Refresh after first request'
      let usageSub: string | null = null
      let usagePct: number | null = null

      if (kind === 'token_stats') {
        const total = quota?.today_added ?? null
        const remaining = quota?.remaining ?? null
        const used = quota?.today_used ?? (total != null && remaining != null ? total - remaining : null)
        const remainingPct = pctOf(remaining ?? null, total)
        const usedPct = pctOf(used ?? null, total)
        usageHeadline = `Remaining ${fmtPct(remainingPct)}`
        usageDetail = `Today ${fmtAmount(used)} / ${fmtAmount(total)}`
        usageSub = usedPct == null ? null : `Used ${fmtPct(usedPct)}`
        usagePct = remainingPct
      } else if (kind === 'budget_info') {
        const dailySpent = quota?.daily_spent_usd ?? null
        const dailyBudget = quota?.daily_budget_usd ?? null
        const dailyLeft =
          dailySpent != null && dailyBudget != null ? Math.max(0, dailyBudget - dailySpent) : null
        const dailyLeftPct = pctOf(dailyLeft, dailyBudget)
        usageHeadline = `Remaining ${fmtPct(dailyLeftPct)} (Daily)`
        usageDetail = `Daily $${fmtUsd(dailySpent)} / $${fmtUsd(dailyBudget)}`
        const hasWeekly = quota?.weekly_spent_usd != null && quota?.weekly_budget_usd != null
        const hasMonthly = quota?.monthly_spent_usd != null || quota?.monthly_budget_usd != null
        if (hasWeekly) {
          usageSub = `Weekly $${fmtUsd(quota?.weekly_spent_usd)} / $${fmtUsd(quota?.weekly_budget_usd)}`
        } else if (hasMonthly) {
          usageSub = `Monthly $${fmtUsd(quota?.monthly_spent_usd)} / $${fmtUsd(quota?.monthly_budget_usd)}`
        }
        usagePct = dailyLeftPct
      }

      return {
        name,
        baseUrl: providerCfg?.base_url ?? '',
        hasKey: Boolean(providerCfg?.has_key),
        usageHeadline,
        usageDetail,
        usageSub,
        usagePct,
      }
    })
  }, [config, status, switchboardProviders])

  const switchboardModeLabel = providerSwitchStatus?.mode ?? '-'
  const switchboardModelProviderLabel = useMemo(() => {
    const mode = providerSwitchStatus?.mode
    const raw = (providerSwitchStatus?.model_provider ?? '').trim()
    if (mode === 'gateway') return 'api_router'
    if (mode === 'official') return 'official default'
    if (mode === 'provider') return raw || '-'
    if (mode === 'mixed') return raw ? `mixed (${raw})` : 'mixed'
    return '-'
  }, [providerSwitchStatus])
  const switchboardTargetDirsLabel =
    providerSwitchStatus?.dirs?.map((d) => d.cli_home).join(' | ') || '-'
  const usageSummary = usageStatistics?.summary ?? null
  const usageTimelineRaw = usageSummary?.timeline ?? []
  const usageTimeline = useMemo(
    () => [...usageTimelineRaw].sort((a, b) => a.bucket_unix_ms - b.bucket_unix_ms),
    [usageTimelineRaw],
  )
  const usageByModel = usageSummary?.by_model ?? []
  const usageByProvider = usageSummary?.by_provider ?? []
  const usageMaxTimelineRequests = Math.max(1, ...usageTimeline.map((x) => x.requests ?? 0))
  const usageMaxTimelineTokens = Math.max(1, ...usageTimeline.map((x) => x.total_tokens ?? 0))
  const usageTotalInputTokens = usageByModel.reduce((sum, x) => sum + (x.input_tokens ?? 0), 0)
  const usageTotalOutputTokens = usageByModel.reduce((sum, x) => sum + (x.output_tokens ?? 0), 0)
  const usageAvgTokensPerRequest =
    (usageSummary?.total_requests ?? 0) > 0
      ? Math.round((usageSummary?.total_tokens ?? 0) / (usageSummary?.total_requests ?? 1))
      : 0
  const usageTopModel = usageByModel[0] ?? null
  const usageCatalogProviders = usageStatistics?.catalog?.providers ?? []
  const usageCatalogModels = usageStatistics?.catalog?.models ?? []
  const usageProviderFilterOptions = useMemo(() => {
    return [...usageCatalogProviders].sort((a, b) => a.localeCompare(b))
  }, [usageCatalogProviders])
  const usageModelFilterOptions = useMemo(
    () => [...usageCatalogModels].sort((a, b) => a.localeCompare(b)),
    [usageCatalogModels],
  )
  const usagePricedRequestCount = usageByProvider.reduce((sum, row) => {
    if (row.total_used_cost_usd == null || !Number.isFinite(row.total_used_cost_usd) || row.total_used_cost_usd <= 0) {
      return sum
    }
    return sum + (row.requests ?? 0)
  }, 0)
  const usagePricedCoveragePct =
    (usageSummary?.total_requests ?? 0) > 0
      ? Math.round((usagePricedRequestCount / (usageSummary?.total_requests ?? 1)) * 100)
      : 0
  const usageActiveWindowHours = useMemo(() => {
    const bucketSeconds = usageStatistics?.bucket_seconds ?? 0
    if (bucketSeconds <= 0) return 0
    const activeBucketCount = usageTimeline.reduce(
      (sum, point) => sum + ((point.requests ?? 0) > 0 ? 1 : 0),
      0,
    )
    if (activeBucketCount <= 0) return 0
    return (activeBucketCount * bucketSeconds) / 3600
  }, [usageTimeline, usageStatistics?.bucket_seconds])
  const usageAvgRequestsPerHour =
    (usageSummary?.total_requests ?? 0) > 0 && usageActiveWindowHours > 0
      ? (usageSummary?.total_requests ?? 0) / usageActiveWindowHours
      : 0
  const usageAvgTokensPerHour =
    (usageSummary?.total_tokens ?? 0) > 0 && usageActiveWindowHours > 0
      ? (usageSummary?.total_tokens ?? 0) / usageActiveWindowHours
      : 0
  const usageWindowLabel = useMemo(() => {
    if (usageWindowHours === 24) return '24 hours'
    if (usageWindowHours === 7 * 24) return '7 days'
    if (usageWindowHours === 30 * 24) return '1 month'
    return `${usageWindowHours} hours`
  }, [usageWindowHours])
  const usageProviderTotalsAndAverages = useMemo(() => {
    if (!usageByProvider.length) return null
    const totalReq = usageByProvider.reduce((sum, row) => sum + (row.requests ?? 0), 0)
    const totalTok = usageByProvider.reduce((sum, row) => sum + (row.total_tokens ?? 0), 0)
    const totalTokPerReq = totalReq > 0 ? totalTok / totalReq : null
    const mean = (values: Array<number | null | undefined>) => {
      const valid = values.filter((v): v is number => Number.isFinite(v as number))
      if (!valid.length) return null
      return valid.reduce((sum, value) => sum + value, 0) / valid.length
    }
    return {
      totalReq,
      totalTok,
      totalTokPerReq,
      avgUsdPerReq: mean(usageByProvider.map((row) => row.estimated_avg_request_cost_usd)),
      avgUsdPerMillion: mean(usageByProvider.map((row) => row.usd_per_million_tokens)),
      avgEstDaily: mean(usageByProvider.map((row) => row.estimated_daily_cost_usd)),
      avgTotalUsed: mean(usageByProvider.map((row) => row.total_used_cost_usd)),
    }
  }, [usageByProvider])
  const usageAnomalies = useMemo(() => {
    const messages: string[] = []
    const highCostProviders = new Set<string>()
    const formatBucket = (unixMs: number) => {
      const d = new Date(unixMs)
      const pad = (n: number) => String(n).padStart(2, '0')
      if ((usageStatistics?.window_hours ?? 24) <= 48) {
        return `${pad(d.getHours())}:00`
      }
      return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}`
    }

    const reqValues = usageTimeline
      .map((point) => point.requests ?? 0)
      .filter((value) => value > 0)
      .sort((a, b) => a - b)
    if (reqValues.length >= 4) {
      const mid = Math.floor(reqValues.length / 2)
      const reqMedian =
        reqValues.length % 2 === 0
          ? (reqValues[mid - 1] + reqValues[mid]) / 2
          : reqValues[mid]
      const peakPoint = usageTimeline.reduce(
        (best, point) => ((point.requests ?? 0) > (best?.requests ?? 0) ? point : best),
        usageTimeline[0],
      )
      const peakReq = peakPoint?.requests ?? 0
      if (reqMedian > 0 && peakReq >= reqMedian * 2.5 && peakReq - reqMedian >= 5) {
        messages.push(
          `Request spike around ${formatBucket(peakPoint.bucket_unix_ms)}: ${peakReq} vs median ${Math.round(reqMedian)}`,
        )
      }
    }

    const priced = usageByProvider.filter(
      (row) =>
        row.estimated_avg_request_cost_usd != null &&
        Number.isFinite(row.estimated_avg_request_cost_usd) &&
        (row.estimated_avg_request_cost_usd ?? 0) > 0 &&
        (row.requests ?? 0) >= 3,
    )
    const priceValues = priced
      .map((row) => row.estimated_avg_request_cost_usd as number)
      .sort((a, b) => a - b)
    if (priceValues.length >= 2) {
      const mid = Math.floor(priceValues.length / 2)
      const priceMedian =
        priceValues.length % 2 === 0
          ? (priceValues[mid - 1] + priceValues[mid]) / 2
          : priceValues[mid]
      priced.forEach((row) => {
        const value = row.estimated_avg_request_cost_usd as number
        if (priceMedian > 0 && value >= priceMedian * 2 && value - priceMedian >= 0.05) {
          highCostProviders.add(row.provider)
          messages.push(
            `High $/req: ${row.provider} at ${fmtUsdMaybe(value)} vs median ${fmtUsdMaybe(priceMedian)}`,
          )
        }
      })
    }

    return { messages, highCostProviders }
  }, [usageTimeline, usageByProvider, usageStatistics?.window_hours])

  useEffect(() => {
    setUsageFilterProviders((prev) => {
      const next = prev.filter((name) => usageProviderFilterOptions.includes(name))
      if (next.length === prev.length && next.every((value, index) => value === prev[index])) {
        return prev
      }
      return next
    })
  }, [usageProviderFilterOptions])

  useEffect(() => {
    setUsageFilterModels((prev) => {
      const next = prev.filter((name) => usageModelFilterOptions.includes(name))
      if (next.length === prev.length && next.every((value, index) => value === prev[index])) {
        return prev
      }
      return next
    })
  }, [usageModelFilterOptions])

  const toggleUsageProviderFilter = useCallback((name: string) => {
    setUsageFilterProviders((prev) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name],
    )
  }, [])

  const toggleUsageModelFilter = useCallback((name: string) => {
    setUsageFilterModels((prev) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name],
    )
  }, [])

  function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
    if (points.length === 0) return ''
    if (points.length === 1) return `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
    let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[Math.max(0, i - 1)]
      const p1 = points[i]
      const p2 = points[i + 1]
      const p3 = points[Math.min(points.length - 1, i + 2)]
      const c1x = p1.x + (p2.x - p0.x) / 6
      const yMin = Math.min(p1.y, p2.y)
      const yMax = Math.max(p1.y, p2.y)
      const c1y = clamp(p1.y + (p2.y - p0.y) / 6, yMin, yMax)
      const c2x = p2.x - (p3.x - p1.x) / 6
      const c2y = clamp(p2.y - (p3.y - p1.y) / 6, yMin, yMax)
      path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`
    }
    return path
  }

  const usageChart = useMemo(() => {
    if (!usageTimeline.length) return null
    const w = 1000
    const h = 220
    const padL = 26
    const padR = 14
    const padT = 16
    const padB = 34
    const plotW = w - padL - padR
    const plotH = h - padT - padB
    const n = usageTimeline.length
    const step = n > 1 ? plotW / (n - 1) : 0
    const barW = Math.max(8, Math.min(24, Math.floor((plotW / Math.max(n, 1)) * 0.55)))
    const hoverW = n > 1 ? Math.max(12, step) : Math.max(24, barW * 2)
    const yBase = padT + plotH
    const points = usageTimeline.map((point, index) => {
      const x = padL + (n === 1 ? plotW / 2 : index * step)
      const reqH = Math.max(2, Math.round((point.requests / usageMaxTimelineRequests) * plotH))
      const barY = yBase - reqH
      const tokenY = yBase - Math.round((point.total_tokens / usageMaxTimelineTokens) * plotH)
      return { point, x, barY, reqH, tokenY }
    })
    const linePath = buildSmoothPath(points.map((p) => ({ x: p.x, y: p.tokenY })))
    const tickIndexes = Array.from(new Set([0, Math.floor((n - 1) / 2), n - 1]))
    return {
      w,
      h,
      yBase,
      points,
      linePath,
      tickIndexes,
      barW,
      hoverW,
    }
  }, [usageTimeline, usageMaxTimelineRequests, usageMaxTimelineTokens])
  function fmtUsdMaybe(value?: number | null): string {
    if (value == null || !Number.isFinite(value) || value <= 0) return '-'
    return `$${value >= 10 ? value.toFixed(2) : value.toFixed(3)}`
  }

  function fmtPricingSource(source?: string | null): string {
    if (!source || source === 'none') return 'unconfigured'
    if (source === 'token_rate') return 'provider budget api'
    if (source === 'provider_budget_api') return 'provider budget api'
    if (source === 'provider_budget_api+manual_history') return 'provider budget + history'
    if (source === 'provider_budget_api_latest_day') return 'provider daily snapshot'
    if (source === 'provider_token_rate') return 'provider token-rate'
    if (source === 'manual_per_request') return 'manual $/req'
    if (source === 'manual_package_total') return 'manual package total'
    if (source === 'manual_history') return 'history manual'
    if (source === 'gap_fill_per_request') return 'gap fill $/req'
    if (source === 'gap_fill_total') return 'gap fill total'
    if (source === 'gap_fill_per_day_average') return 'gap fill $/day'
    return source
  }

  function fmtUsageBucketLabel(unixMs: number): string {
    const d = new Date(unixMs)
    const pad = (n: number) => String(n).padStart(2, '0')
    if ((usageStatistics?.window_hours ?? 24) <= 48) {
      return `${pad(d.getHours())}:00`
    }
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}`
  }

  function showUsageChartHover(
    event: {
      clientX: number
      clientY: number
      currentTarget: { ownerSVGElement?: SVGSVGElement | null }
    },
    bucketUnixMs: number,
    requests: number,
    totalTokens: number,
  ) {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect) return
    const rawX = event.clientX - rect.left
    const rawY = event.clientY - rect.top
    const maxX = Math.max(8, rect.width - 176)
    const maxY = Math.max(8, rect.height - 54)
    setUsageChartHover({
      x: Math.min(Math.max(rawX + 10, 8), maxX),
      y: Math.min(Math.max(rawY - 42, 8), maxY),
      title: fmtUsageBucketLabel(bucketUnixMs),
      subtitle: `Requests ${requests} | Tokens ${totalTokens.toLocaleString()}`,
    })
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

  async function saveProviderPricing(name: string) {
    const provider = config?.providers?.[name]
    if (!provider) return
    const mode = provider.manual_pricing_mode ?? null
    const amount = provider.manual_pricing_amount_usd ?? null
    try {
      if (!mode) {
        await invoke('set_provider_manual_pricing', {
          provider: name,
          mode: 'none',
          amountUsd: null,
        })
      } else {
        await invoke('set_provider_manual_pricing', {
          provider: name,
          mode,
          amountUsd: amount,
        })
      }
      flashToast(`Pricing saved: ${name}`)
      await refreshConfig()
      await refreshUsageStatistics()
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
      void refreshProviderSwitchStatus()
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

  useEffect(() => {
    if (!providerSwitchDirWatcherPrimedRef.current) {
      providerSwitchDirWatcherPrimedRef.current = true
      return
    }
    if (providerSwitchRefreshTimerRef.current) {
      window.clearTimeout(providerSwitchRefreshTimerRef.current)
      providerSwitchRefreshTimerRef.current = null
    }
    providerSwitchRefreshTimerRef.current = window.setTimeout(() => {
      void refreshProviderSwitchStatus()
      providerSwitchRefreshTimerRef.current = null
    }, 220)
    return () => {
      if (providerSwitchRefreshTimerRef.current) {
        window.clearTimeout(providerSwitchRefreshTimerRef.current)
        providerSwitchRefreshTimerRef.current = null
      }
    }
  }, [codexSwapDir1, codexSwapDir2, codexSwapApplyBoth])

  useEffect(() => {
    if (activePage !== 'usage_statistics') return
    void refreshUsageStatistics()
    const t = window.setInterval(() => void refreshUsageStatistics({ silent: true }), 15_000)
    return () => window.clearInterval(t)
  }, [activePage, usageWindowHours, usageFilterProviders, usageFilterModels])

  useEffect(() => {
    if (isDevPreview) return
    void refreshFxRatesDaily(false)
  }, [isDevPreview])

  useEffect(() => {
    if (!usagePricingModalOpen) {
      usagePricingDraftsPrimedRef.current = false
      closeUsagePricingCurrencyMenu()
      return
    }
    if (!config) return
    void refreshFxRatesDaily(false)
    if (usagePricingDraftsPrimedRef.current) return
    setUsagePricingDrafts(() => {
      const next: Record<string, UsagePricingDraft> = {}
      usageByProvider.forEach((row) => {
        const providerCfg = config?.providers?.[row.provider]
        const mode = (providerCfg?.manual_pricing_mode ?? 'none') as UsagePricingMode
        let cachedCurrency = 'USD'
        if (typeof window !== 'undefined') {
          cachedCurrency =
            window.localStorage.getItem(`${FX_CURRENCY_PREF_KEY_PREFIX}${row.provider}`) ?? 'USD'
        }
        const currency = normalizeCurrencyCode(cachedCurrency)
        const amountUsd = providerCfg?.manual_pricing_amount_usd
        const amountText =
          amountUsd != null && Number.isFinite(amountUsd) && amountUsd > 0
            ? formatDraftAmount(convertUsdToCurrency(amountUsd, currency))
            : ''
        next[row.provider] = {
          mode,
          amountText,
          currency,
        }
      })
      return next
    })
    usagePricingDraftsPrimedRef.current = true
  }, [usagePricingModalOpen, usageByProvider, config, fxRatesByCurrency, closeUsagePricingCurrencyMenu])

  useEffect(() => {
    if (!usageHistoryModalOpen) return
    void refreshUsageHistory()
  }, [usageHistoryModalOpen])

  useEffect(() => {
    if (!usagePricingCurrencyMenu) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        closeUsagePricingCurrencyMenu()
        return
      }
      if (usagePricingCurrencyMenuRef.current?.contains(target)) return
      if (target.closest('.aoUsagePricingCurrencyWrap')) return
      closeUsagePricingCurrencyMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeUsagePricingCurrencyMenu()
    }
    const onViewportChange = () => {
      closeUsagePricingCurrencyMenu()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [usagePricingCurrencyMenu, closeUsagePricingCurrencyMenu])

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
  }, [orderedConfigProviders])

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
                  <div className="aoMiniLabel">Manual Pricing (Usage Statistics)</div>
                  <div className="aoPricingRow">
                    <select
                      className="aoSelect aoPricingModeSelect"
                      value={p.manual_pricing_mode ?? 'none'}
                      onChange={(e) =>
                        setConfig((c) =>
                          c
                            ? {
                                ...c,
                                providers: {
                                  ...c.providers,
                                  [name]: {
                                    ...c.providers[name],
                                    manual_pricing_mode:
                                      e.target.value === 'none'
                                        ? null
                                        : (e.target.value as 'per_request' | 'package_total'),
                                    manual_pricing_amount_usd:
                                      e.target.value === 'none'
                                        ? null
                                        : c.providers[name].manual_pricing_amount_usd ?? null,
                                  },
                                },
                              }
                            : c,
                        )
                      }
                    >
                      <option value="none">Provider API</option>
                      <option value="per_request">Manual $ / request</option>
                      <option value="package_total">Manual package total $</option>
                    </select>
                    <input
                      className="aoInput aoPricingInput"
                      type="number"
                      step="0.001"
                      min="0"
                      disabled={!p.manual_pricing_mode}
                      placeholder={
                        p.manual_pricing_mode === 'package_total'
                          ? 'Package total USD'
                          : p.manual_pricing_mode === 'per_request'
                            ? 'USD per request'
                            : 'Amount USD'
                      }
                      value={p.manual_pricing_amount_usd == null ? '' : String(p.manual_pricing_amount_usd)}
                      onChange={(e) =>
                        setConfig((c) =>
                          c
                            ? {
                                ...c,
                                providers: {
                                  ...c.providers,
                                  [name]: {
                                    ...c.providers[name],
                                    manual_pricing_amount_usd:
                                      e.target.value.trim() === '' ? null : Number(e.target.value),
                                  },
                                },
                              }
                            : c,
                        )
                      }
                    />
                    <button className="aoTinyBtn" onClick={() => void saveProviderPricing(name)}>
                      Save Pricing
                    </button>
                  </div>
                  <div className="aoHint">
                    Provider API uses budget-based estimate. Package total follows the selected time window.
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
      editingProviderName,
      isProviderOpen,
      onProviderHandlePointerDown,
      openKeyModal,
      openUsageBaseModal,
      registerProviderCardRef,
      providerNameDrafts,
      saveProvider,
      saveProviderPricing,
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
              <div className="aoTopNav" role="tablist" aria-label="Main pages">
                <button
                  className={`aoTopNavBtn${activePage === 'dashboard' ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={activePage === 'dashboard'}
                  onClick={() => switchPage('dashboard')}
                >
                  <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" />
                    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" />
                    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" />
                    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" />
                  </svg>
                  <span>Dashboard</span>
                </button>
                <button
                  className={`aoTopNavBtn${activePage === 'usage_statistics' ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={activePage === 'usage_statistics'}
                  onClick={() => switchPage('usage_statistics')}
                >
                  <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 19.5h16" />
                    <path d="M7 17.5V9.5" />
                    <path d="M12 17.5V5.5" />
                    <path d="M17 17.5V12.5" />
                    <path d="M5.5 6.5 9 9l4-3.5 4 2.5" />
                  </svg>
                  <span>Usage Statistics</span>
                </button>
                <button
                  className={`aoTopNavBtn${activePage === 'provider_switchboard' ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={activePage === 'provider_switchboard'}
                  onClick={() => switchPage('provider_switchboard')}
                >
                  <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h11" />
                    <path d="M4 17h16" />
                    <circle cx="17" cy="7" r="3" />
                    <circle cx="9" cy="17" r="3" />
                  </svg>
                  <span>Provider Switchboard</span>
                </button>
              </div>
              <button className="aoTinyBtn" onClick={() => setInstructionModalOpen(true)}>
                Getting Started
              </button>
            </div>
          </div>

          {/* Surface errors via toast to avoid layout shifts. */}

          <div className={`aoMainArea${activePage === 'dashboard' ? '' : ' aoMainAreaFill'}`} ref={mainAreaRef}>
          {activePage === 'usage_statistics' ? (
            <div className="aoCard aoUsageStatsPage">
              <div className="aoUsageStatsHeader">
                <div>
                  <div className="aoPagePlaceholderTitle">Usage Statistics</div>
                  <div className="aoHint">Requests, tokens, model mix, and provider-aware estimated request pricing.</div>
                </div>
                <div className="aoUsageStatsActions">
                  <button
                    className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 24 ? ' aoUsageWindowBtnActive' : ''}`}
                    onClick={() => setUsageWindowHours(24)}
                    disabled={usageStatisticsLoading}
                    aria-pressed={usageWindowHours === 24}
                  >
                    24h
                  </button>
                  <button
                    className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 7 * 24 ? ' aoUsageWindowBtnActive' : ''}`}
                    onClick={() => setUsageWindowHours(7 * 24)}
                    disabled={usageStatisticsLoading}
                    aria-pressed={usageWindowHours === 7 * 24}
                  >
                    7d
                  </button>
                  <button
                    className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 30 * 24 ? ' aoUsageWindowBtnActive' : ''}`}
                    onClick={() => setUsageWindowHours(30 * 24)}
                    disabled={usageStatisticsLoading}
                    aria-pressed={usageWindowHours === 30 * 24}
                  >
                    1M
                  </button>
                </div>
              </div>
              <div className="aoUsageFilterCard">
                <div className="aoUsageFilterSection aoUsageFilterSectionCompact">
                  <div className="aoUsageFilterSectionHead">
                    <span className="aoMiniLabel">Providers</span>
                  </div>
                  <div className="aoUsageFilterChips">
                    <button
                      className={`aoUsageFilterChip${usageFilterProviders.length === 0 ? ' is-active' : ''}`}
                      disabled={usageStatisticsLoading}
                      onClick={() => setUsageFilterProviders([])}
                    >
                      All providers
                    </button>
                    {usageProviderFilterOptions.map((providerName) => (
                      <button
                        key={providerName}
                        className={`aoUsageFilterChip${usageFilterProviders.includes(providerName) ? ' is-active' : ''}`}
                        disabled={usageStatisticsLoading}
                        onClick={() => toggleUsageProviderFilter(providerName)}
                      >
                        {providerName}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="aoUsageFilterSection aoUsageFilterSectionCompact">
                  <div className="aoUsageFilterSectionHead">
                    <span className="aoMiniLabel">Models</span>
                  </div>
                  <div className="aoUsageFilterChips">
                    <button
                      className={`aoUsageFilterChip${usageFilterModels.length === 0 ? ' is-active' : ''}`}
                      disabled={usageStatisticsLoading}
                      onClick={() => setUsageFilterModels([])}
                    >
                      All models
                    </button>
                    {usageModelFilterOptions.map((modelName) => (
                      <button
                        key={modelName}
                        className={`aoUsageFilterChip${usageFilterModels.includes(modelName) ? ' is-active' : ''}`}
                        disabled={usageStatisticsLoading}
                        onClick={() => toggleUsageModelFilter(modelName)}
                      >
                        {modelName}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {usageAnomalies.messages.length ? (
                <div className="aoUsageAnomalyBanner" role="status" aria-live="polite">
                  <div className="aoMiniLabel">Anomaly Watch</div>
                  {usageAnomalies.messages.map((message, index) => (
                    <div key={`usage-anomaly-${index}`} className="aoUsageAnomalyText">
                      {message}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="aoUsageKpiGrid">
                <div className="aoUsageKpiCard">
                  <div className="aoMiniLabel">Total Requests</div>
                  <div className="aoUsageKpiValue">{usageSummary?.total_requests?.toLocaleString() ?? '-'}</div>
                </div>
                <div className="aoUsageKpiCard">
                  <div className="aoMiniLabel">Total Tokens</div>
                  <div className="aoUsageKpiValue">{usageSummary?.total_tokens?.toLocaleString() ?? '-'}</div>
                </div>
                <div className="aoUsageKpiCard">
                  <div className="aoMiniLabel">Top Model</div>
                  <div className="aoUsageKpiValue aoUsageKpiValueSmall">
                    {usageTopModel ? usageTopModel.model : '-'}
                  </div>
                </div>
                <div className="aoUsageKpiCard">
                  <div className="aoMiniLabel">Total $ Used</div>
                  <div className="aoUsageKpiValue">{fmtUsdMaybe(usageSummary?.estimated_total_cost_usd)}</div>
                </div>
              </div>
              <div className="aoUsageFactsCard">
                <div className="aoSwitchboardSectionHead">
                  <div className="aoMiniLabel">Window Details</div>
                  <div className="aoHint">Top model share is request share. Priced coverage means calculable-cost requests.</div>
                </div>
                <table className="aoUsageFactsTable">
                  <tbody>
                    <tr>
                      <th>Top Model Share</th>
                      <td>{usageTopModel ? `${Math.round(usageTopModel.share_pct ?? 0)}% of requests` : '-'}</td>
                      <th>Unique Models</th>
                      <td>{usageSummary?.unique_models?.toLocaleString() ?? '-'}</td>
                    </tr>
                    <tr>
                      <th>Input / Output Tokens</th>
                      <td>{usageTotalInputTokens.toLocaleString()} / {usageTotalOutputTokens.toLocaleString()}</td>
                      <th>Avg Tokens / Request</th>
                      <td>{usageSummary?.total_requests ? usageAvgTokensPerRequest.toLocaleString() : '-'}</td>
                    </tr>
                    <tr>
                      <th>Window Data</th>
                      <td>
                        {(usageSummary?.total_requests ?? 0).toLocaleString()} captured requests
                        {usageActiveWindowHours > 0 ? ` · ${usageActiveWindowHours.toFixed(1)} active h` : ''}
                      </td>
                      <th>Priced Coverage</th>
                      <td>
                        {usagePricedRequestCount.toLocaleString()} / {(usageSummary?.total_requests ?? 0).toLocaleString()} req ({usagePricedCoveragePct}%)
                      </td>
                    </tr>
                    <tr>
                      <th>Window Pace</th>
                      <td>
                        {usageAvgRequestsPerHour.toFixed(2)} req/h · {Math.round(usageAvgTokensPerHour).toLocaleString()} tok/h
                      </td>
                      <th>Selected Window</th>
                      <td>{usageWindowLabel}</td>
                    </tr>
                    <tr>
                      <th>Data Freshness</th>
                      <td>{usageStatistics?.generated_at_unix_ms ? fmtWhen(usageStatistics.generated_at_unix_ms) : '-'}</td>
                      <th>Sample Coverage</th>
                      <td>
                        {(usageSummary?.total_requests ?? 0).toLocaleString()} req · {usageActiveWindowHours.toFixed(1)} active h
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="aoUsageChartsGrid">
                <div className="aoUsageChartCard">
                  <div className="aoSwitchboardSectionHead">
                    <div className="aoMiniLabel">Requests Timeline</div>
                    <div className="aoHint">
                      {usageSummary?.total_requests ? `${usageSummary.total_requests.toLocaleString()} requests in window` : 'No request data yet'}
                    </div>
                  </div>
                  {usageChart ? (
                    <div className="aoUsageTimelineChartWrap" onMouseLeave={() => setUsageChartHover(null)}>
                      <svg className="aoUsageTimelineSvg" viewBox={`0 0 ${usageChart.w} ${usageChart.h}`} preserveAspectRatio="none">
                        <line
                          className="aoUsageTimelineAxis"
                          x1={26}
                          y1={usageChart.yBase}
                          x2={usageChart.w - 14}
                          y2={usageChart.yBase}
                        />
                        {usageChart.points.map((p) => (
                          <rect
                            key={`bar-${p.point.bucket_unix_ms}`}
                            className="aoUsageTimelineBarRect"
                            x={p.x - usageChart.barW / 2}
                            y={p.barY}
                            width={usageChart.barW}
                            height={p.reqH}
                            rx={4}
                            ry={4}
                          >
                            <title>{`${fmtUsageBucketLabel(p.point.bucket_unix_ms)} | requests ${p.point.requests}`}</title>
                          </rect>
                        ))}
                        <path className="aoUsageTimelineLine" d={usageChart.linePath} />
                        {usageChart.points.map((p) => (
                          <circle
                            key={`dot-${p.point.bucket_unix_ms}`}
                            className="aoUsageTimelineDot"
                            cx={p.x}
                            cy={p.tokenY}
                            r={3}
                          >
                            <title>{`${fmtUsageBucketLabel(p.point.bucket_unix_ms)} | tokens ${p.point.total_tokens.toLocaleString()}`}</title>
                          </circle>
                        ))}
                        {usageChart.points.map((p) => (
                          <rect
                            key={`hover-${p.point.bucket_unix_ms}`}
                            className="aoUsageTimelineHoverBand"
                            x={p.x - usageChart.hoverW / 2}
                            y={16}
                            width={usageChart.hoverW}
                            height={usageChart.yBase - 16}
                            onMouseMove={(event) =>
                              showUsageChartHover(
                                event,
                                p.point.bucket_unix_ms,
                                p.point.requests,
                                p.point.total_tokens,
                              )
                            }
                          />
                        ))}
                      </svg>
                      {usageChartHover ? (
                        <div
                          className="aoUsageTooltip"
                          style={{ left: `${usageChartHover.x}px`, top: `${usageChartHover.y}px` }}
                        >
                          <div className="aoUsageTooltipTitle">{usageChartHover.title}</div>
                          <div className="aoUsageTooltipSub">{usageChartHover.subtitle}</div>
                        </div>
                      ) : null}
                      <div className="aoUsageTimelineLegend">
                        <span className="aoUsageLegendItem aoUsageLegendBars">Bars: Requests</span>
                        <span className="aoUsageLegendItem aoUsageLegendLine">Line: Tokens</span>
                      </div>
                      <div className="aoUsageTimelineTicks">
                        {usageChart.tickIndexes.map((index) => {
                          const p = usageChart.points[index]
                          return (
                            <span key={`tick-${p.point.bucket_unix_ms}`}>{fmtUsageBucketLabel(p.point.bucket_unix_ms)}</span>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="aoHint">No requests have gone through the gateway in this time window.</div>
                  )}
                </div>

              </div>

              <div className="aoUsageProviderCard">
                <div className="aoSwitchboardSectionHead">
                  <div className="aoMiniLabel">Provider Statistics</div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                      <div className="aoHint">
                      Includes tok/req, $/M tokens, est/day, and selected-window total used cost.
                      </div>
                    <button className="aoTinyBtn" onClick={() => setUsageHistoryModalOpen(true)}>
                      Daily History
                    </button>
                    <button className="aoTinyBtn" onClick={() => setUsagePricingModalOpen(true)}>
                      Pricing Setup
                    </button>
                  </div>
                </div>
                {usageByProvider.length ? (
                  <table className="aoUsageProviderTable">
                    <thead>
                      <tr>
                        <th>Provider</th>
                        <th>Req</th>
                        <th>Tokens</th>
                        <th>tok/req</th>
                        <th>$ / req</th>
                        <th>$ / M tok</th>
                        <th>Est $ / day</th>
                        <th>Total $ Used</th>
                        <th>Pricing Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usageByProvider.map((p) => (
                        <tr
                          key={p.provider}
                          className={usageAnomalies.highCostProviders.has(p.provider) ? 'aoUsageProviderRowAnomaly' : ''}
                        >
                          <td className="aoUsageProviderName">{p.provider}</td>
                          <td>{p.requests.toLocaleString()}</td>
                          <td>{p.total_tokens.toLocaleString()}</td>
                          <td>
                            {p.tokens_per_request == null || !Number.isFinite(p.tokens_per_request)
                              ? '-'
                              : Math.round(p.tokens_per_request).toLocaleString()}
                          </td>
                          <td>{fmtUsdMaybe(p.estimated_avg_request_cost_usd)}</td>
                          <td>{fmtUsdMaybe(p.usd_per_million_tokens)}</td>
                          <td>{fmtUsdMaybe(p.estimated_daily_cost_usd)}</td>
                          <td>{fmtUsdMaybe(p.total_used_cost_usd)}</td>
                          <td>{fmtPricingSource(p.pricing_source)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {usageProviderTotalsAndAverages ? (
                      <tfoot>
                        <tr className="aoUsageProviderAvgRow">
                          <td className="aoUsageProviderName">Average</td>
                          <td>-</td>
                          <td>-</td>
                          <td>
                            {usageProviderTotalsAndAverages.totalTokPerReq == null
                              ? '-'
                              : Math.round(usageProviderTotalsAndAverages.totalTokPerReq).toLocaleString()}
                          </td>
                          <td>{fmtUsdMaybe(usageProviderTotalsAndAverages.avgUsdPerReq)}</td>
                          <td>{fmtUsdMaybe(usageProviderTotalsAndAverages.avgUsdPerMillion)}</td>
                          <td>{fmtUsdMaybe(usageProviderTotalsAndAverages.avgEstDaily)}</td>
                          <td>{fmtUsdMaybe(usageProviderTotalsAndAverages.avgTotalUsed)}</td>
                          <td>-</td>
                        </tr>
                      </tfoot>
                    ) : null}
                  </table>
                ) : (
                  <div className="aoHint">No provider usage data yet.</div>
                )}
                <div className="aoHint">
                  Open Pricing Setup for base pricing. Open History to edit daily missing-cost corrections.
                </div>
              </div>
            </div>
          ) : activePage === 'provider_switchboard' ? (
            <div className="aoCard aoProviderSwitchboardCard">
              <div className="aoProviderSwitchboardHeader">
                <div>
                  <div className="aoPagePlaceholderTitle">Provider Switchboard</div>
                  <div className="aoHint">
                    One-click switch for Codex auth/config target (gateway, official, or direct provider).
                  </div>
                  <div className="aoHint">
                    Runtime failover routing stays in Dashboard Routing. This page does not do seamless live routing.
                  </div>
                </div>
                <div className="aoPill">
                  <span className="aoDot" />
                  <span className="aoPillText">{switchboardModeLabel}</span>
                </div>
              </div>
              <div className="aoSwitchThemeBand">
                <div className="aoSwitchThemeBandHead">
                  <div className="aoMiniLabel">Current Target</div>
                </div>
                <div className="aoSwitchThemeSummary">
                  <div className="aoSwitchThemeRow">
                    <span className="aoSwitchThemeKey">Current Mode</span>
                    <span className="aoSwitchThemeVal">{switchboardModeLabel}</span>
                    <span className="aoSwitchThemeSep">|</span>
                    <span className="aoSwitchThemeKey">Model Provider</span>
                    <span className="aoSwitchThemeVal">{switchboardModelProviderLabel}</span>
                  </div>
                  <div className="aoSwitchThemeRow">
                    <span className="aoSwitchThemeKey">Target Dirs</span>
                    <span className="aoSwitchThemeVal aoSwitchMetaDirs">{switchboardTargetDirsLabel}</span>
                  </div>
                </div>
              </div>
              <div className="aoSwitchboardBlock">
                <div className="aoSwitchboardSectionHead">
                  <div className="aoMiniLabel">Quick Switch</div>
                </div>
                <div className="aoSwitchQuickGrid">
                  <button
                    className={`aoSwitchQuickBtn${providerSwitchStatus?.mode === 'gateway' ? ' is-active' : ''}`}
                    disabled={providerSwitchBusy}
                    onClick={() => void setProviderSwitchTarget('gateway')}
                  >
                    <span className="aoSwitchQuickTitle">Gateway</span>
                    <span className="aoSwitchQuickSub">Use local API Router</span>
                  </button>
                  <button
                    className={`aoSwitchQuickBtn${providerSwitchStatus?.mode === 'official' ? ' is-active' : ''}`}
                    disabled={providerSwitchBusy}
                    onClick={() => void setProviderSwitchTarget('official')}
                  >
                    <span className="aoSwitchQuickTitle">Official</span>
                    <span className="aoSwitchQuickSub">Use official Codex auth</span>
                  </button>
                  <button className="aoSwitchQuickBtn aoSwitchQuickBtnHint" disabled>
                    <span className="aoSwitchQuickTitle">Direct Provider</span>
                    <span className="aoSwitchQuickSub">Use selected provider below</span>
                  </button>
                </div>
                <div className="aoSwitchSubOptions">
                  <div className="aoSwitchboardSectionHead">
                    <div className="aoMiniLabel">Switch Options</div>
                    <button type="button" className="aoTinyBtn" onClick={() => setCodexSwapModalOpen(true)}>
                      Configure Dirs
                    </button>
                  </div>
                  <div className="aoHint">
                    Shared with Dashboard Swap settings. Gateway, Official, and Direct Provider switches all use
                    the same directory targets.
                  </div>
                </div>
              </div>
              <div className="aoSwitchboardBlock">
                <div className="aoSwitchboardSectionHead">
                  <div className="aoMiniLabel">Direct Providers</div>
                  <div className="aoHint">Includes remaining quota and progress view.</div>
                </div>
                <div className="aoSwitchProviderGrid">
                  {switchboardProviderCards.length ? (
                    switchboardProviderCards.map((providerItem) => (
                      <button
                        key={providerItem.name}
                        className={`aoSwitchProviderBtn${providerSwitchStatus?.mode === 'provider' && providerSwitchStatus?.model_provider === providerItem.name ? ' is-active' : ''}`}
                        disabled={providerSwitchBusy || !providerItem.hasKey}
                        onClick={() => void setProviderSwitchTarget('provider', providerItem.name)}
                      >
                        <span className="aoSwitchProviderHead">
                          <span>{providerItem.name}</span>
                          <span className={`aoSwitchProviderKey${providerItem.hasKey ? ' is-ready' : ' is-missing'}`}>
                            {providerItem.hasKey ? 'key ready' : 'missing key'}
                          </span>
                        </span>
                        <span className="aoSwitchProviderBase">{providerItem.baseUrl || 'base_url missing'}</span>
                        <span className="aoSwitchProviderUsageBody">
                          <span className="aoSwitchProviderUsageHeadline">{providerItem.usageHeadline}</span>
                          <span className="aoSwitchProviderUsageDetail">{providerItem.usageDetail}</span>
                          {providerItem.usageSub ? (
                            <span className="aoSwitchProviderUsageSub">{providerItem.usageSub}</span>
                          ) : (
                            <span className="aoSwitchProviderUsageSub aoSwitchProviderUsageSubMuted">No extra usage info</span>
                          )}
                        </span>
                        <span className="aoSwitchProviderProgress">
                          <span
                            className={`aoSwitchProviderProgressFill${providerItem.usagePct == null ? ' is-empty' : ''}`}
                            style={
                              providerItem.usagePct == null
                                ? undefined
                                : { width: `${Math.max(4, Math.min(100, providerItem.usagePct))}%` }
                            }
                          />
                        </span>
                      </button>
                    ))
                  ) : (
                    <span className="aoHint">No configured providers.</span>
                  )}
                </div>
              </div>
            </div>
          ) : !status ? (
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
                    void (async () => {
                      flashToast('Checking...')
                      setCodexRefreshing(true)
                      try {
                        await invoke('codex_account_refresh')
                        await refreshStatus()
                      } catch (e) {
                        flashToast(String(e), 'error')
                      } finally {
                        setCodexRefreshing(false)
                      }
                    })()
                  }}
                  refreshing={codexRefreshing}
                  onSwapAuthConfig={() => {
                    void (async () => {
                      try {
                        const homes = resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapApplyBoth)
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

      {usageHistoryModalOpen ? (
        <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={() => setUsageHistoryModalOpen(false)}>
          <div className="aoModal aoModalWide aoUsageHistoryModal" onClick={(e) => e.stopPropagation()}>
            <div className="aoModalHeader">
              <div>
                <div className="aoModalTitle">Daily Spend History</div>
                <div className="aoModalSub">
                  Edit per-day manual fixes. Use this when provider daily spend resets to zero and leaves cost gaps.
                  Showing latest 180 days.
                </div>
              </div>
              <button className="aoBtn" onClick={() => setUsageHistoryModalOpen(false)}>
                Close
              </button>
            </div>
            <div className="aoModalBody">
              {usageHistoryLoading ? (
                <div className="aoHint">Loading...</div>
              ) : usageHistoryRows.length ? (
                <table className="aoUsageHistoryTable">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Provider</th>
                      <th>Req</th>
                      <th>Tokens</th>
                      <th>Tracked $</th>
                      <th>Manual Total $</th>
                      <th>Manual $/Req</th>
                      <th>Effective $</th>
                      <th>Source</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageHistoryRows.map((row) => {
                      const key = `${row.provider}|${row.day_key}`
                      const draft = usageHistoryDrafts[key] ?? { totalText: '', reqText: '' }
                      return (
                        <tr key={key}>
                          <td>{row.day_key}</td>
                          <td className="aoUsageProviderName">{row.provider}</td>
                          <td>{(row.req_count ?? 0).toLocaleString()}</td>
                          <td>{(row.total_tokens ?? 0).toLocaleString()}</td>
                          <td>{fmtUsdMaybe(row.tracked_total_usd ?? null)}</td>
                          <td>
                            <input
                              className="aoInput aoUsageHistoryInput"
                              type="number"
                              min="0"
                              step="0.001"
                              placeholder="0"
                              value={draft.totalText}
                              onChange={(e) =>
                                setUsageHistoryDrafts((prev) => ({
                                  ...prev,
                                  [key]: { ...draft, totalText: e.target.value },
                                }))
                              }
                            />
                          </td>
                          <td>
                            <input
                              className="aoInput aoUsageHistoryInput"
                              type="number"
                              min="0"
                              step="0.0001"
                              placeholder="0"
                              value={draft.reqText}
                              onChange={(e) =>
                                setUsageHistoryDrafts((prev) => ({
                                  ...prev,
                                  [key]: { ...draft, reqText: e.target.value },
                                }))
                              }
                            />
                          </td>
                          <td>{fmtUsdMaybe(row.effective_total_usd ?? null)}</td>
                          <td>{row.source ?? '-'}</td>
                          <td>
                            <div className="aoUsageHistoryActions">
                              <button className="aoTinyBtn" onClick={() => void saveUsageHistoryRow(row)}>
                                Save
                              </button>
                              <button
                                className="aoTinyBtn"
                                onClick={() => {
                                  void (async () => {
                                    try {
                                      await invoke('set_spend_history_entry', {
                                        provider: row.provider,
                                        dayKey: row.day_key,
                                        totalUsedUsd: null,
                                        usdPerReq: null,
                                      })
                                      setUsageHistoryDrafts((prev) => ({
                                        ...prev,
                                        [key]: { totalText: '', reqText: '' },
                                      }))
                                      await refreshUsageHistory({ silent: true })
                                      await refreshUsageStatistics({ silent: true })
                                      flashToast(`History cleared: ${row.provider} ${row.day_key}`)
                                    } catch (e) {
                                      flashToast(String(e), 'error')
                                    }
                                  })()
                                }}
                              >
                                Clear
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="aoHint">No history yet.</div>
              )}
            </div>
          </div>
        </ModalBackdrop>
      ) : null}

      {usagePricingModalOpen ? (
        <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={() => setUsagePricingModalOpen(false)}>
          <div className="aoModal aoModalWide aoUsagePricingModal" onClick={(e) => e.stopPropagation()}>
            <div className="aoModalHeader">
              <div>
                <div className="aoModalTitle">Pricing Setup</div>
                <div className="aoModalSub">
                  Configure base pricing only. Values auto-convert to USD.
                </div>
              </div>
              <button className="aoBtn" onClick={() => setUsagePricingModalOpen(false)}>
                Close
              </button>
            </div>
            <div className="aoModalBody">
              <div className="aoHint" style={{ marginBottom: 8 }}>
                FX rates date: {fxRatesDate || 'loading'} (daily update)
              </div>
              <div className="aoUsagePricingGrid">
                {usageByProvider.map((row) => {
                  const providerCfg = config?.providers?.[row.provider]
                  const draft = usagePricingDrafts[row.provider] ?? {
                    mode: (providerCfg?.manual_pricing_mode ?? 'none') as UsagePricingMode,
                    amountText:
                      providerCfg?.manual_pricing_amount_usd != null
                        ? formatDraftAmount(providerCfg.manual_pricing_amount_usd)
                        : '',
                    currency: 'USD',
                  }
                  const mode = draft.mode
                  const amountDisabled = !providerCfg || mode === 'none'
                  return (
                    <div key={`pricing-${row.provider}`} className="aoUsagePricingRow">
                      <div className="aoUsagePricingProvider">{row.provider}</div>
                      <select
                        className="aoSelect aoUsagePricingSelect aoUsagePricingMode"
                        value={mode}
                        disabled={!providerCfg}
                        onChange={(e) => {
                          const nextMode = (e.target.value as UsagePricingMode) ?? 'none'
                          setUsagePricingDrafts((prev) => ({
                            ...prev,
                            [row.provider]: {
                              ...draft,
                              mode: nextMode,
                              amountText: nextMode === 'none' ? '' : draft.amountText,
                            },
                          }))
                        }}
                      >
                        <option value="none">Monthly credit</option>
                        <option value="package_total">Monthly fee</option>
                        <option value="per_request">$ / request</option>
                      </select>
                      <input
                        className="aoInput aoUsagePricingInput aoUsagePricingAmount"
                        type="number"
                        step="0.001"
                        min="0"
                        disabled={amountDisabled}
                        placeholder="Amount"
                        value={draft.amountText}
                        onChange={(e) =>
                          setUsagePricingDrafts((prev) => ({
                            ...prev,
                            [row.provider]: {
                              ...draft,
                              amountText: e.target.value,
                            },
                          }))
                        }
                      />
                      <div className="aoUsagePricingCurrencyWrap">
                        <button
                          type="button"
                          className="aoSelect aoUsagePricingCurrencyBtn"
                          disabled={!providerCfg || amountDisabled}
                          aria-haspopup="listbox"
                          aria-expanded={usagePricingCurrencyMenu?.provider === row.provider}
                          onClick={(e) => {
                            const button = e.currentTarget
                            const rect = button.getBoundingClientRect()
                            setUsagePricingCurrencyMenu((prev) => {
                              if (prev?.provider === row.provider) {
                                setUsagePricingCurrencyQuery('')
                                return null
                              }
                              setUsagePricingCurrencyQuery('')
                              return {
                                provider: row.provider,
                                left: Math.max(8, Math.round(rect.left)),
                                top: Math.round(rect.bottom + 4),
                                width: Math.round(rect.width),
                              }
                            })
                          }}
                        >
                          <span>{currencyLabel(normalizeCurrencyCode(draft.currency))}</span>
                          <span className="aoUsagePricingCurrencyChevron" aria-hidden="true">
                            ▼
                          </span>
                        </button>
                      </div>
                      <button
                        className="aoTinyBtn"
                        disabled={!providerCfg}
                        onClick={() => void saveUsagePricingRow(row.provider)}
                      >
                        Save
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="aoHint">
                Use History to adjust per-day missing costs or corrections.
              </div>
            </div>
          </div>
          {usagePricingCurrencyMenu
            ? createPortal(
                (() => {
                  const row = usageByProvider.find((item) => item.provider === usagePricingCurrencyMenu.provider)
                  if (!row) return null
                  const providerCfg = config?.providers?.[row.provider]
                  const draft = usagePricingDrafts[row.provider] ?? {
                    mode: (providerCfg?.manual_pricing_mode ?? 'none') as UsagePricingMode,
                    amountText:
                      providerCfg?.manual_pricing_amount_usd != null
                        ? formatDraftAmount(providerCfg.manual_pricing_amount_usd)
                        : '',
                    currency: 'USD',
                  }
                  const amountDisabled = !providerCfg
                  if (amountDisabled) return null

                  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
                  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800
                  const width = Math.max(74, Math.min(130, usagePricingCurrencyMenu.width))
                  const left = Math.max(8, Math.min(usagePricingCurrencyMenu.left, viewportWidth - width - 8))
                  const top = usagePricingCurrencyMenu.top
                  const maxHeight = Math.max(140, Math.min(260, viewportHeight - top - 8))
                  const query = usagePricingCurrencyQuery.trim().toUpperCase()
                  const filteredOptions = usageCurrencyOptions.filter((currencyCode) => {
                    const normalized = normalizeCurrencyCode(currencyCode)
                    const label = currencyLabel(normalized).toUpperCase()
                    return query.length === 0 || normalized.includes(query) || label.includes(query)
                  })

                  return (
                    <div
                      ref={usagePricingCurrencyMenuRef}
                      className="aoUsagePricingCurrencyMenu aoUsagePricingCurrencyMenuPortal"
                      role="listbox"
                      style={{ left, top, width, maxHeight }}
                    >
                      <div className="aoUsagePricingCurrencySearchWrap">
                        <input
                          className="aoInput aoUsagePricingCurrencySearch"
                          placeholder="Search"
                          value={usagePricingCurrencyQuery}
                          onChange={(e) => setUsagePricingCurrencyQuery(e.target.value)}
                        />
                      </div>
                      {filteredOptions.map((currencyCode) => {
                        const normalized = normalizeCurrencyCode(currencyCode)
                        const isActive = normalizeCurrencyCode(draft.currency) === normalized
                        return (
                          <button
                            type="button"
                            key={currencyCode}
                            className={`aoUsagePricingCurrencyItem${isActive ? ' is-active' : ''}`}
                            onClick={() => {
                              updateUsagePricingCurrency(row.provider, draft, normalized)
                              closeUsagePricingCurrencyMenu()
                            }}
                          >
                            {currencyLabel(normalized)}
                          </button>
                        )
                      })}
                      {filteredOptions.length === 0 ? (
                        <div className="aoHint" style={{ padding: '6px 10px 8px' }}>
                          No currency
                        </div>
                      ) : null}
                    </div>
                  )
                })(),
                document.body,
              )
            : null}
        </ModalBackdrop>
      ) : null}

      <CodexSwapModal
        open={codexSwapModalOpen}
        dir1={codexSwapDir1}
        dir2={codexSwapDir2}
        applyBoth={codexSwapApplyBoth}
        onChangeDir1={(v) => {
          setCodexSwapDir1(v)
          const d1 = v.trim()
          const d2 = codexSwapDir2.trim()
          if (d1 && d2 && normalizePathForCompare(d1) === normalizePathForCompare(d2)) {
            setCodexSwapApplyBoth(false)
          }
        }}
        onChangeDir2={(v) => {
          setCodexSwapDir2(v)
          if (!v.trim()) setCodexSwapApplyBoth(false)
          const d1 = codexSwapDir1.trim()
          const d2 = v.trim()
          if (d1 && d2 && normalizePathForCompare(d1) === normalizePathForCompare(d2)) {
            setCodexSwapApplyBoth(false)
          }
        }}
        onChangeApplyBoth={(v) => {
          const d1 = codexSwapDir1.trim()
          const d2 = codexSwapDir2.trim()
          if (v && d1 && d2 && normalizePathForCompare(d1) === normalizePathForCompare(d2)) {
            flashToast('Dir 2 must be different from Dir 1', 'error')
            setCodexSwapApplyBoth(false)
            return
          }
          setCodexSwapApplyBoth(v)
        }}
        onCancel={() => setCodexSwapModalOpen(false)}
        onApply={() => {
          void (async () => {
            try {
              const dir1 = codexSwapDir1.trim()
              const dir2 = codexSwapDir2.trim()
              if (!dir1) throw new Error('Dir 1 is required')
              if (codexSwapApplyBoth && !dir2) throw new Error('Dir 2 is empty')
              if (
                codexSwapApplyBoth &&
                dir2 &&
                normalizePathForCompare(dir1) === normalizePathForCompare(dir2)
              ) {
                throw new Error('Dir 2 must be different from Dir 1')
              }

              const homes = resolveCliHomes(dir1, dir2, codexSwapApplyBoth)
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
