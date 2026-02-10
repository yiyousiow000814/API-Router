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
import {
  FX_CURRENCY_PREF_KEY_PREFIX,
  FX_RATES_CACHE_KEY,
  type FxUsdPayload,
  type PricingTimelineMode,
  type ProviderScheduleDraft,
  type ProviderSchedulePeriod,
  type ProviderScheduleSaveInput,
  type SpendHistoryRow,
  type TopPage,
  type UsageHistoryDraft,
  type UsagePricingDraft,
  type UsagePricingGroup,
  type UsagePricingMode,
  type UsagePricingSaveState,
  type UsageScheduleSaveState,
  devConfig,
  devStatus,
} from './app/appTypes'

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
  const [usagePricingSaveState, setUsagePricingSaveState] = useState<Record<string, UsagePricingSaveState>>({})
  const [usageScheduleModalOpen, setUsageScheduleModalOpen] = useState<boolean>(false)
  const [usageScheduleProvider, setUsageScheduleProvider] = useState<string>('')
  const [usageScheduleRows, setUsageScheduleRows] = useState<ProviderScheduleDraft[]>([])
  const [usageScheduleLoading, setUsageScheduleLoading] = useState<boolean>(false)
  const [usageScheduleSaving, setUsageScheduleSaving] = useState<boolean>(false)
  const [usageScheduleSaveState, setUsageScheduleSaveState] = useState<UsageScheduleSaveState>('idle')
  const [usageScheduleSaveError, setUsageScheduleSaveError] = useState<string>('')
  const [usageHistoryModalOpen, setUsageHistoryModalOpen] = useState<boolean>(false)
  const [usageHistoryRows, setUsageHistoryRows] = useState<SpendHistoryRow[]>([])
  const [usageHistoryDrafts, setUsageHistoryDrafts] = useState<Record<string, UsageHistoryDraft>>({})
  const [usageHistoryEditCell, setUsageHistoryEditCell] = useState<string | null>(null)
  const [usageHistoryLoading, setUsageHistoryLoading] = useState<boolean>(false)
  const [usagePricingCurrencyMenu, setUsagePricingCurrencyMenu] = useState<{
    provider: string
    providers: string[]
    left: number
    top: number
    width: number
  } | null>(null)
  const [usagePricingCurrencyQuery, setUsagePricingCurrencyQuery] = useState<string>('')
  const [usageScheduleCurrencyMenu, setUsageScheduleCurrencyMenu] = useState<{
    rowIndex: number
    left: number
    top: number
    width: number
  } | null>(null)
  const [usageScheduleCurrencyQuery, setUsageScheduleCurrencyQuery] = useState<string>('')
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
  const usageScheduleCurrencyMenuRef = useRef<HTMLDivElement | null>(null)
  const autoSaveTimersRef = useRef<Record<string, number>>({})
  const usagePricingLastSavedSigRef = useRef<Record<string, string>>({})
  const usageScheduleLastSavedSigRef = useRef<string>('')
  const usageScheduleLastSavedByProviderRef = useRef<Record<string, string>>({})
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
    return () => {
      Object.keys(autoSaveTimersRef.current).forEach((key) => {
        window.clearTimeout(autoSaveTimersRef.current[key])
      })
      autoSaveTimersRef.current = {}
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
    if (!codexSwapStatus && !providerSwitchStatus) {
      return { badgeText: '', badgeTitle: 'Codex CLI swap status: loading' }
    }
    const mode = providerSwitchStatus?.mode
    const switchboardLabel =
      mode === 'provider'
        ? 'DP' + (providerSwitchStatus?.model_provider ? ':' + providerSwitchStatus.model_provider : '')
        : mode === 'official'
          ? 'Auth'
          : mode === 'gateway'
            ? 'API'
            : mode === 'mixed'
              ? 'Mixed'
              : null
    const overall = codexSwapStatus?.overall
    const swapFallbackLabel =
      overall === 'swapped'
        ? 'Auth'
        : overall === 'original'
          ? 'API'
          : overall === 'mixed'
            ? 'Mixed'
            : overall === 'error'
              ? 'Error'
              : 'Loading'
    const badgeText = switchboardLabel ?? swapFallbackLabel
    const parts =
      providerSwitchStatus?.dirs?.length
        ? providerSwitchStatus.dirs.map((d) => {
            const modeText = d.mode === 'provider' ? 'provider:' + (d.model_provider ?? '-') : d.mode
            return d.cli_home + ': ' + modeText
          })
        : codexSwapStatus?.dirs?.length
          ? codexSwapStatus.dirs.map((d) => d.cli_home + ': ' + d.state)
          : []
    const badgeTitle = parts.length
      ? 'Codex CLI swap status: ' + badgeText + '. ' + parts.join(' | ')
      : 'Codex CLI swap status: ' + badgeText
    return { badgeText, badgeTitle }
  }, [codexSwapStatus, providerSwitchStatus])

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

  function clearAutoSaveTimer(key: string) {
    const timer = autoSaveTimersRef.current[key]
    if (timer) {
      window.clearTimeout(timer)
      delete autoSaveTimersRef.current[key]
    }
  }

  function clearAutoSaveTimersByPrefix(prefix: string) {
    Object.keys(autoSaveTimersRef.current).forEach((key) => {
      if (key.startsWith(prefix)) {
        window.clearTimeout(autoSaveTimersRef.current[key])
        delete autoSaveTimersRef.current[key]
      }
    })
  }

  function queueAutoSaveTimer(key: string, callback: () => void, delayMs = 700) {
    clearAutoSaveTimer(key)
    autoSaveTimersRef.current[key] = window.setTimeout(() => {
      delete autoSaveTimersRef.current[key]
      callback()
    }, delayMs)
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
    await refreshStatus({ refreshSwapStatus: false })
    await Promise.all([
      refreshCodexSwapStatus(homes),
      refreshProviderSwitchStatus(homes),
      refreshConfig({ refreshProviderSwitchStatus: false }),
    ])
  }

  async function refreshCodexSwapStatus(cliHomes?: string[]) {
    if (isDevPreview) return
    try {
      const homes =
        cliHomes && cliHomes.length
          ? cliHomes
          : resolveCliHomes(
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

  async function refreshProviderSwitchStatus(cliHomes?: string[]) {
    const homes =
      cliHomes && cliHomes.length
        ? cliHomes
        : resolveCliHomes(
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

  function currencyPrefKeyByApiKey(apiKeyRef: string): string | null {
    const key = apiKeyRef.trim()
    if (!key || key === '-' || key === 'set') return null
    return `${FX_CURRENCY_PREF_KEY_PREFIX}key:${key}`
  }

  function currencyPrefKeyByProvider(providerName: string): string {
    const keyLabel = providerApiKeyLabel(providerName).trim()
    const byApiKey = currencyPrefKeyByApiKey(keyLabel)
    if (byApiKey) return byApiKey
    return `${FX_CURRENCY_PREF_KEY_PREFIX}${providerName}`
  }

  function readPreferredCurrency(providerName: string, apiKeyRef?: string): string {
    if (typeof window === 'undefined') return 'USD'
    const keys: string[] = []
    const byApiKey = currencyPrefKeyByApiKey(apiKeyRef?.trim() ?? '')
    if (byApiKey) keys.push(byApiKey)
    keys.push(currencyPrefKeyByProvider(providerName))
    keys.push(`${FX_CURRENCY_PREF_KEY_PREFIX}${providerName}`)
    for (const key of keys) {
      const cached = window.localStorage.getItem(key)
      if (cached?.trim()) return normalizeCurrencyCode(cached)
    }
    return 'USD'
  }

  function persistPreferredCurrency(
    providerNames: string[],
    currency: string,
    options?: { apiKeyRef?: string },
  ) {
    if (typeof window === 'undefined') return
    const normalized = normalizeCurrencyCode(currency)
    const keys = new Set<string>()
    const byApiKey = currencyPrefKeyByApiKey(options?.apiKeyRef?.trim() ?? '')
    if (byApiKey) keys.add(byApiKey)
    providerNames.forEach((providerName) => {
      keys.add(currencyPrefKeyByProvider(providerName))
      keys.add(`${FX_CURRENCY_PREF_KEY_PREFIX}${providerName}`)
    })
    keys.forEach((key) => {
      window.localStorage.setItem(key, normalized)
    })
  }

  function updateUsagePricingCurrency(
    providerNames: string[],
    draft: UsagePricingDraft,
    nextCurrency: string,
  ) {
    const raw = normalizeCurrencyCode(nextCurrency)
    const nextProviders = providerNames.filter((providerName) => Boolean(config?.providers?.[providerName]))
    if (!nextProviders.length) return
    let nextDraftForAutoSave: UsagePricingDraft | null = null
    setUsagePricingDrafts((prev) => {
      const cur = prev[nextProviders[0]] ?? draft
      const oldCurrency = normalizeCurrencyCode(cur.currency)
      const amountRaw = Number(cur.amountText)
      const nextAmount =
        Number.isFinite(amountRaw) && amountRaw > 0
          ? formatDraftAmount(convertUsdToCurrency(convertCurrencyToUsd(amountRaw, oldCurrency), raw))
          : cur.amountText
      const nextDraft = {
        ...cur,
        currency: raw,
        amountText: nextAmount,
      }
      nextDraftForAutoSave = nextDraft
      const next = { ...prev }
      nextProviders.forEach((providerName) => {
        next[providerName] = nextDraft
      })
      return next
    })
    if (nextDraftForAutoSave) {
      queueUsagePricingAutoSaveForProviders(nextProviders, nextDraftForAutoSave)
    }
    persistPreferredCurrency(nextProviders, raw, { apiKeyRef: providerApiKeyLabel(nextProviders[0]) })
  }

  function closeUsageScheduleCurrencyMenu() {
    setUsageScheduleCurrencyMenu(null)
    setUsageScheduleCurrencyQuery('')
  }

  function updateUsageScheduleCurrency(rowIndex: number, nextCurrency: string) {
    const raw = normalizeCurrencyCode(nextCurrency)
    const row = usageScheduleRows[rowIndex]
    if (row) {
      persistPreferredCurrency([row.provider, ...(row.groupProviders ?? [])], raw, { apiKeyRef: row.apiKeyRef })
    }
    setUsageScheduleSaveState('idle')
    setUsageScheduleRows((prev) =>
      prev.map((row, index) => {
        if (index !== rowIndex) return row
        const oldCurrency = normalizeCurrencyCode(row.currency)
        const amountRaw = Number(row.amountText)
        const nextAmount =
          Number.isFinite(amountRaw) && amountRaw > 0
            ? formatDraftAmount(convertUsdToCurrency(convertCurrencyToUsd(amountRaw, oldCurrency), raw))
            : row.amountText
        return { ...row, currency: raw, amountText: nextAmount }
      }),
    )
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

  function toDateTimeLocalValue(unixMs?: number | null): string {
    if (!unixMs || !Number.isFinite(unixMs) || unixMs <= 0) return ''
    const d = new Date(unixMs)
    const pad = (n: number) => String(n).padStart(2, '0')
    const yyyy = d.getFullYear()
    const mm = pad(d.getMonth() + 1)
    const dd = pad(d.getDate())
    const hh = pad(d.getHours())
    const min = pad(d.getMinutes())
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`
  }

  function fromDateTimeLocalValue(value: string): number | null {
    const raw = value.trim()
    if (!raw) return null
    const unixMs = Date.parse(raw)
    if (!Number.isFinite(unixMs) || unixMs <= 0) return null
    return unixMs
  }

  function parsePositiveAmount(value: string): number | null {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return null
    return n
  }

function scheduleRowsSignature(rows: ProviderScheduleDraft[]): string {
    return JSON.stringify(
      rows.map((row) => ({
        provider: row.provider.trim(),
        groupProviders: Array.from(new Set((row.groupProviders ?? []).map((name) => name.trim()).filter(Boolean)))
          .sort(),
        id: row.id.trim(),
        mode: row.mode,
        apiKeyRef: row.apiKeyRef.trim(),
        start: row.startText.trim(),
        end: row.endText.trim(),
        amount: row.amountText.trim(),
        currency: normalizeCurrencyCode(row.currency),
      })),
    )
  }

  function scheduleSignaturesByProvider(
    rows: ProviderScheduleDraft[],
    providerNames?: string[],
  ): Record<string, string> {
    const grouped: Record<string, ProviderScheduleDraft[]> = {}
    for (const row of rows) {
      const targets = Array.from(
        new Set(
          [row.provider, ...(row.groupProviders ?? [])]
            .map((name) => name.trim())
            .filter(Boolean),
        ),
      )
      if (!targets.length) continue
      targets.forEach((provider) => {
        if (!grouped[provider]) grouped[provider] = []
        grouped[provider].push(row)
      })
    }
    const providers = providerNames?.length
      ? Array.from(new Set(providerNames))
      : Object.keys(grouped)
    const out: Record<string, string> = {}
    providers.forEach((provider) => {
      const providerRows = (grouped[provider] ?? [])
        .map((row) => ({
          id: row.id.trim(),
          mode: row.mode,
          apiKeyRef: row.apiKeyRef.trim(),
          start: row.startText.trim(),
          end: row.endText.trim(),
          amount: row.amountText.trim(),
          currency: normalizeCurrencyCode(row.currency),
        }))
        .sort((a, b) =>
          a.start.localeCompare(b.start) ||
          a.end.localeCompare(b.end) ||
          a.id.localeCompare(b.id),
        )
      out[provider] = JSON.stringify(providerRows)
    })
    return out
  }

  function parseScheduleRowsForSave(rows: ProviderScheduleDraft[]): {
    ok: true
    periodsByProvider: Record<string, ProviderScheduleSaveInput[]>
  } | { ok: false; reason: string } {
    const grouped: Record<string, ProviderScheduleSaveInput[]> = {}
    const dedupeByProvider: Record<string, Set<string>> = {}
    const apiKeyPeriodSet = new Set<string>()

    for (const row of rows) {
      const providers = Array.from(
        new Set(
          [row.provider, ...(row.groupProviders ?? [])]
            .map((name) => name.trim())
            .filter(Boolean),
        ),
      )
      if (!providers.length) return { ok: false, reason: 'provider is required' }
      if (row.mode !== 'package_total' && row.mode !== 'per_request') {
        return { ok: false, reason: 'mode must be monthly fee or $/request' }
      }
      const start = fromDateTimeLocalValue(row.startText)
      const end = fromDateTimeLocalValue(row.endText)
      const amount = parsePositiveAmount(row.amountText)
      if (!start || !amount) {
        return { ok: false, reason: 'complete each row with valid start and amount' }
      }
      if (row.mode === 'package_total' && !end) {
        return { ok: false, reason: 'monthly fee row requires expires time' }
      }
      if (end != null && start >= end) {
        return { ok: false, reason: 'each row start must be earlier than expires' }
      }
      const apiKeyLabel = row.apiKeyRef.trim() || providerApiKeyLabel(providers[0])
      const endKey = end == null ? 'open' : String(end)
      const apiKeyPeriodKey = `${apiKeyLabel}|${start}|${endKey}`
      if (apiKeyLabel !== '-' && apiKeyPeriodSet.has(apiKeyPeriodKey)) {
        return { ok: false, reason: `duplicate start/expires for API key ${apiKeyLabel}` }
      }
      apiKeyPeriodSet.add(apiKeyPeriodKey)
      const amountUsd = convertCurrencyToUsd(amount, row.currency)
      const dedupeKey = `${row.mode}|${apiKeyLabel}|${start}|${endKey}|${amountUsd.toFixed(8)}`
      providers.forEach((provider) => {
        if (!grouped[provider]) grouped[provider] = []
        if (!dedupeByProvider[provider]) dedupeByProvider[provider] = new Set<string>()
        if (dedupeByProvider[provider].has(dedupeKey)) return
        dedupeByProvider[provider].add(dedupeKey)
        grouped[provider].push({
          id: row.id.trim() || null,
          mode: row.mode,
          amount_usd: amountUsd,
          api_key_ref: apiKeyLabel,
          started_at_unix_ms: start,
          ended_at_unix_ms: end ?? undefined,
        })
      })
    }

    for (const provider of Object.keys(grouped)) {
      const periods = grouped[provider]
      periods.sort((a, b) => a.started_at_unix_ms - b.started_at_unix_ms)
      for (let i = 1; i < periods.length; i += 1) {
        const prevEnd = periods[i - 1].ended_at_unix_ms
        if (prevEnd == null || prevEnd > periods[i].started_at_unix_ms) {
          return { ok: false, reason: `periods overlap for ${provider}` }
        }
      }
    }
    return { ok: true, periodsByProvider: grouped }
  }

  function providerPreferredCurrency(providerName: string): string {
    return readPreferredCurrency(providerName, providerApiKeyLabel(providerName))
  }

  function providerApiKeyLabel(providerName: string): string {
    const keyPreview = config?.providers?.[providerName]?.key_preview?.trim()
    if (keyPreview) return keyPreview
    if (config?.providers?.[providerName]?.has_key) return 'set'
    return '-'
  }

function scheduleDraftFromPeriod(
  providerName: string,
  period: ProviderSchedulePeriod,
  fallbackCurrency?: string,
  groupProviders?: string[],
): ProviderScheduleDraft {
  const apiKeyRef = (period.api_key_ref ?? providerApiKeyLabel(providerName)).trim() || providerApiKeyLabel(providerName)
  const currency = fallbackCurrency
    ? normalizeCurrencyCode(fallbackCurrency)
    : readPreferredCurrency(providerName, apiKeyRef)
  const mode: PricingTimelineMode = period.mode === 'per_request' ? 'per_request' : 'package_total'
  const fallbackEndMs =
    mode === 'package_total'
      ? period.started_at_unix_ms + 30 * 24 * 60 * 60 * 1000
      : undefined
  const endMs = period.ended_at_unix_ms ?? fallbackEndMs
  return {
    provider: providerName,
    groupProviders: (groupProviders?.length ? groupProviders : [providerName]).filter(Boolean),
    id: period.id,
    mode,
    apiKeyRef,
    startText: toDateTimeLocalValue(period.started_at_unix_ms),
    endText: toDateTimeLocalValue(endMs),
    amountText: formatDraftAmount(convertUsdToCurrency(period.amount_usd, currency)),
    currency,
    }
  }

function newScheduleDraft(
  providerName: string,
  seedAmountUsd?: number | null,
  seedCurrency?: string,
  seedMode: PricingTimelineMode = 'package_total',
  groupProviders?: string[],
): ProviderScheduleDraft {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
    const end = start + 30 * 24 * 60 * 60 * 1000
    const currency = seedCurrency
      ? normalizeCurrencyCode(seedCurrency)
      : readPreferredCurrency(providerName, providerApiKeyLabel(providerName))
  return {
    provider: providerName,
    groupProviders: (groupProviders?.length ? groupProviders : [providerName]).filter(Boolean),
    id: '',
    mode: seedMode,
    apiKeyRef: providerApiKeyLabel(providerName),
    startText: toDateTimeLocalValue(start),
    endText: toDateTimeLocalValue(end),
      amountText:
        seedAmountUsd && seedAmountUsd > 0
          ? formatDraftAmount(convertUsdToCurrency(seedAmountUsd, currency))
          : '',
      currency,
    }
  }

  function historyEffectiveDisplayValue(row: SpendHistoryRow): number | null {
    if (row.effective_total_usd != null && Number.isFinite(row.effective_total_usd) && row.effective_total_usd > 0) {
      return row.effective_total_usd
    }
    const tracked = row.tracked_total_usd ?? 0
    const scheduled = row.scheduled_total_usd ?? 0
    const manual = row.manual_total_usd ?? 0
    const total = tracked + scheduled + manual
    return total > 0 ? total : null
  }

  function historyPerReqDisplayValue(row: SpendHistoryRow): number | null {
    if (row.effective_usd_per_req != null && Number.isFinite(row.effective_usd_per_req) && row.effective_usd_per_req > 0) {
      return row.effective_usd_per_req
    }
    if (row.manual_usd_per_req != null && Number.isFinite(row.manual_usd_per_req) && row.manual_usd_per_req > 0) {
      return row.manual_usd_per_req
    }
    return null
  }

  function historyDraftFromRow(row: SpendHistoryRow): UsageHistoryDraft {
    const effective = historyEffectiveDisplayValue(row)
    const perReq = historyPerReqDisplayValue(row)
    return {
      effectiveText: effective != null ? formatDraftAmount(effective) : '',
      perReqText: perReq != null ? formatDraftAmount(perReq) : '',
    }
  }

  function fmtHistorySource(source?: string | null): string {
    if (!source || source === 'none') return 'none'
    if (source === 'manual_per_request' || source === 'manual_total') return 'manual'
    if (source === 'tracked+manual_per_request' || source === 'tracked+manual_total') return 'tracked+manual'
    if (source === 'scheduled_package_total') return 'scheduled'
    return source
  }

  const closeUsagePricingCurrencyMenu = useCallback(() => {
    setUsagePricingCurrencyMenu(null)
    setUsagePricingCurrencyQuery('')
  }, [])

  function pricingDraftSignature(draft: UsagePricingDraft): string {
    return JSON.stringify({
      mode: draft.mode,
      amountText: draft.amountText.trim(),
      currency: normalizeCurrencyCode(draft.currency),
    })
  }

  function buildUsagePricingDraft(
    providerName: string,
    providerCfg?: Config['providers'][string],
  ): UsagePricingDraft {
    const mode = (providerCfg?.manual_pricing_mode ?? 'none') as UsagePricingMode
    const cachedCurrency = readPreferredCurrency(
      providerName,
      providerCfg?.key_preview?.trim() || (providerCfg?.has_key ? 'set' : '-'),
    )
    const currency = normalizeCurrencyCode(cachedCurrency)
    const amountUsd = providerCfg?.manual_pricing_amount_usd
    const amountText =
      amountUsd != null && Number.isFinite(amountUsd) && amountUsd > 0
        ? formatDraftAmount(convertUsdToCurrency(amountUsd, currency))
        : ''
    return { mode, amountText, currency }
  }

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

  async function openUsageScheduleModal(
    providerName: string,
    seedCurrency?: string,
    options?: { keepVisible?: boolean },
  ) {
    if (!providerName) return
    const keepVisible = options?.keepVisible === true && usageScheduleModalOpen
    closeUsagePricingCurrencyMenu()
    closeUsageScheduleCurrencyMenu()
    setUsageScheduleProvider(providerName)
    setUsageScheduleModalOpen(true)
    if (!keepVisible) setUsageScheduleLoading(true)
    setUsageScheduleSaveState('idle')
    setUsageScheduleSaveError('')
    try {
      const providers = Array.from(
        new Set(
          [providerName, ...usageScheduleProviderOptions].filter(
            (name) => Boolean(name) && Boolean(config?.providers?.[name]),
          ),
        ),
      )
      const chunks = await Promise.all(
        providers.map(async (provider) => {
          const res = await invoke<{ ok: boolean; periods?: ProviderSchedulePeriod[] }>('get_provider_timeline', {
            provider,
          })
          const periods = Array.isArray(res?.periods) ? res.periods : []
          return { provider, periods }
        }),
      )
      const rowsByKey = new Map<string, ProviderScheduleDraft>()
      chunks.forEach(({ provider, periods }) => {
        const preferredCurrency =
          provider === providerName && seedCurrency ? seedCurrency : providerPreferredCurrency(provider)
        periods
          .sort((a, b) => a.started_at_unix_ms - b.started_at_unix_ms)
          .forEach((period) => {
            const apiKeyRef = (period.api_key_ref ?? providerApiKeyLabel(provider)).trim() || providerApiKeyLabel(provider)
            const linkedProviders = linkedProvidersForApiKey(apiKeyRef, provider)
            const canonicalProvider = linkedProviders[0] ?? provider
            const endMs = period.ended_at_unix_ms ?? null
            const dedupeKey = [
              apiKeyRef,
              period.mode ?? 'package_total',
              String(period.started_at_unix_ms),
              String(endMs ?? 'open'),
              Number.isFinite(period.amount_usd) ? period.amount_usd.toFixed(8) : String(period.amount_usd),
            ].join('|')
            const existing = rowsByKey.get(dedupeKey)
            if (existing) {
              const mergedProviders = Array.from(
                new Set([...existing.groupProviders, ...linkedProviders, provider].filter(Boolean)),
              )
              rowsByKey.set(dedupeKey, { ...existing, groupProviders: mergedProviders })
              return
            }
            rowsByKey.set(
              dedupeKey,
              scheduleDraftFromPeriod(
                canonicalProvider,
                period,
                preferredCurrency,
                linkedProviders,
              ),
            )
          })
      })
      const rows = Array.from(rowsByKey.values()).sort((a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.startText.localeCompare(b.startText) ||
        a.endText.localeCompare(b.endText),
      )
      setUsageScheduleRows(rows)
      usageScheduleLastSavedSigRef.current = scheduleRowsSignature(rows)
      usageScheduleLastSavedByProviderRef.current = scheduleSignaturesByProvider(rows, providers)
      setUsageScheduleSaveState(rows.length > 0 ? 'saved' : 'idle')
      setUsageScheduleSaveError('')
    } catch (e) {
      flashToast(String(e), 'error')
      if (!keepVisible) {
        setUsageScheduleRows([])
        usageScheduleLastSavedSigRef.current = scheduleRowsSignature([])
        usageScheduleLastSavedByProviderRef.current = {}
      }
      setUsageScheduleSaveState('idle')
      setUsageScheduleSaveError('')
    } finally {
      setUsageScheduleLoading(false)
    }
  }

  async function autoSaveUsageScheduleRows(rows: ProviderScheduleDraft[], signature: string) {
    const parsed = parseScheduleRowsForSave(rows)
    if (!parsed.ok) {
      setUsageScheduleSaveState('invalid')
      setUsageScheduleSaveError(parsed.reason)
      return
    }
    setUsageScheduleSaving(true)
    setUsageScheduleSaveState('saving')
    setUsageScheduleSaveError('')
    try {
      const prevByProvider = usageScheduleLastSavedByProviderRef.current
      const nextByProvider = scheduleSignaturesByProvider(rows)
      const providerNames = Array.from(new Set([...Object.keys(prevByProvider), ...Object.keys(nextByProvider)]))
      for (const provider of providerNames) {
        if (!config?.providers?.[provider]) continue
        const prevSig = prevByProvider[provider] ?? '[]'
        const nextSig = nextByProvider[provider] ?? '[]'
        if (prevSig === nextSig) continue
        await invoke('set_provider_timeline', {
          provider,
          periods: parsed.periodsByProvider[provider] ?? [],
        })
      }
      usageScheduleLastSavedByProviderRef.current = nextByProvider
      usageScheduleLastSavedSigRef.current = signature
      setUsageScheduleSaveState('saved')
      setUsageScheduleSaveError('')
      await refreshConfig()
      await refreshUsageStatistics({ silent: true })
      if (usageHistoryModalOpen) {
        await refreshUsageHistory({ silent: true })
      }
    } catch (e) {
      setUsageScheduleSaveState('error')
      const msg = String(e)
      setUsageScheduleSaveError(msg)
      flashToast(`Scheduled auto-save failed: ${msg}`, 'error')
    } finally {
      setUsageScheduleSaving(false)
    }
  }

  function resolvePricingAmountUsd(draft: UsagePricingDraft, fallbackAmountUsd?: number | null): number | null {
    const amountRaw = Number(draft.amountText)
    if (Number.isFinite(amountRaw) && amountRaw > 0) {
      return convertCurrencyToUsd(amountRaw, draft.currency)
    }
    if (fallbackAmountUsd != null && Number.isFinite(fallbackAmountUsd) && fallbackAmountUsd > 0) {
      return fallbackAmountUsd
    }
    return null
  }

  function setUsagePricingSaveStateForProviders(
    providerNames: string[],
    state: UsagePricingSaveState,
  ) {
    setUsagePricingSaveState((prev) => {
      const next = { ...prev }
      providerNames.forEach((providerName) => {
        next[providerName] = state
      })
      return next
    })
  }

  async function activatePackageTotalMode(
    providerName: string,
    draft: UsagePricingDraft,
    options?: { skipRefresh?: boolean; silentError?: boolean },
  ): Promise<boolean> {
    const skipRefresh = options?.skipRefresh === true
    const silentError = options?.silentError === true
    const providerCfg = config?.providers?.[providerName]
    if (!providerCfg) return false
    const now = Date.now()
    let timelinePeriods: ProviderSchedulePeriod[] = []
    try {
      const res = await invoke<{ ok: boolean; periods?: ProviderSchedulePeriod[] }>('get_provider_timeline', {
        provider: providerName,
      })
      timelinePeriods = Array.isArray(res?.periods) ? res.periods : []
    } catch {
      timelinePeriods = []
    }

    const packagePeriods = timelinePeriods
      .filter((period) => (period.mode ?? 'package_total') === 'package_total')
      .filter((period) => Number.isFinite(period.amount_usd) && period.amount_usd > 0)
      .sort((a, b) => b.started_at_unix_ms - a.started_at_unix_ms)
    const activePackage = packagePeriods.find((period) => {
      const starts = period.started_at_unix_ms <= now
      const notEnded = period.ended_at_unix_ms == null || now < period.ended_at_unix_ms
      return starts && notEnded
    })
    const upcomingPackage = packagePeriods.find((period) => period.started_at_unix_ms > now)

    let amountUsd = resolvePricingAmountUsd(draft, providerCfg.manual_pricing_amount_usd ?? null)
    if (amountUsd == null && packagePeriods.length > 0) amountUsd = packagePeriods[0].amount_usd
    if (amountUsd == null) {
      setUsagePricingSaveState((prev) => ({ ...prev, [providerName]: 'idle' }))
      return false
    }
    setUsagePricingSaveState((prev) => ({ ...prev, [providerName]: 'saving' }))
    try {
      if (activePackage || upcomingPackage) {
        const rewrittenPeriods = timelinePeriods.map((period) => {
          const mode = (period.mode ?? 'package_total') as PricingTimelineMode
          const inActiveOrUpcomingWindow =
            mode === 'package_total' &&
            (period.started_at_unix_ms >= now ||
              (period.started_at_unix_ms <= now &&
                (period.ended_at_unix_ms == null || now < period.ended_at_unix_ms)))
          return {
            id: period.id,
            mode,
            amount_usd: inActiveOrUpcomingWindow ? amountUsd : period.amount_usd,
            api_key_ref: period.api_key_ref ?? providerApiKeyLabel(providerName),
            started_at_unix_ms: period.started_at_unix_ms,
            ended_at_unix_ms: period.ended_at_unix_ms ?? undefined,
          }
        })
        await invoke('set_provider_timeline', {
          provider: providerName,
          periods: rewrittenPeriods,
        })
      } else {
        await invoke('set_provider_manual_pricing', {
          provider: providerName,
          mode: 'package_total',
          amountUsd,
          packageExpiresAtUnixMs: null,
        })
      }
      await invoke('set_provider_gap_fill', {
        provider: providerName,
        mode: 'none',
        amountUsd: null,
      })
      usagePricingLastSavedSigRef.current[providerName] = pricingDraftSignature({
        ...draft,
        amountText: formatDraftAmount(convertUsdToCurrency(amountUsd, draft.currency)),
      })
      setUsagePricingSaveState((prev) => ({ ...prev, [providerName]: 'saved' }))
      if (!skipRefresh) {
        await refreshConfig()
        await refreshUsageStatistics({ silent: true })
      }
      return true
    } catch (e) {
      setUsagePricingSaveState((prev) => ({ ...prev, [providerName]: 'error' }))
      if (!silentError) flashToast(String(e), 'error')
      return false
    }
  }

  async function saveUsagePricingForProviders(
    providerNames: string[],
    draft: UsagePricingDraft,
    options?: { silent?: boolean },
  ): Promise<boolean> {
    const silent = options?.silent === true
    const targets = providerNames.filter((providerName) => Boolean(config?.providers?.[providerName]))
    if (!targets.length) return false
    let draftForSave = draft
    if (draft.mode === 'package_total') {
      let sharedAmountUsd = resolvePricingAmountUsd(draft, null)
      if (sharedAmountUsd == null) {
        for (const providerName of targets) {
          try {
            const res = await invoke<{ ok: boolean; periods?: ProviderSchedulePeriod[] }>('get_provider_timeline', {
              provider: providerName,
            })
            const periods = Array.isArray(res?.periods) ? res.periods : []
            const latest = periods
              .filter((period) => (period.mode ?? 'package_total') === 'package_total')
              .filter((period) => Number.isFinite(period.amount_usd) && period.amount_usd > 0)
              .sort((a, b) => b.started_at_unix_ms - a.started_at_unix_ms)[0]
            if (latest) {
              sharedAmountUsd = latest.amount_usd
              break
            }
          } catch {
            // Ignore read failure and continue other providers.
          }
        }
      }
      if (sharedAmountUsd != null) {
        draftForSave = {
          ...draft,
          amountText: formatDraftAmount(convertUsdToCurrency(sharedAmountUsd, draft.currency)),
        }
      }
    }
    let allOk = true
    for (const providerName of targets) {
      const ok = await saveUsagePricingRow(providerName, {
        silent: true,
        draftOverride: draftForSave,
        skipRefresh: true,
      })
      if (!ok) allOk = false
    }
    if (allOk) {
      await refreshConfig()
      await refreshUsageStatistics({ silent: true })
      return true
    }
    if (!silent) flashToast('Failed to save linked pricing row', 'error')
    return false
  }

  function queueUsagePricingAutoSaveForProviders(providerNames: string[], draft: UsagePricingDraft) {
    if (!usagePricingModalOpen) return
    const targets = providerNames.filter((providerName) => Boolean(config?.providers?.[providerName]))
    if (!targets.length) return
    if (draft.mode === 'package_total') {
      setUsagePricingSaveStateForProviders(targets, 'idle')
      return
    }
    const signature = pricingDraftSignature(draft)
    if (targets.every((providerName) => usagePricingLastSavedSigRef.current[providerName] === signature)) {
      setUsagePricingSaveStateForProviders(targets, 'saved')
      return
    }
    const timerKey = `pricing:${targets.join('|')}`
    clearAutoSaveTimer(timerKey)
    setUsagePricingSaveStateForProviders(targets, 'idle')
    queueAutoSaveTimer(timerKey, () => {
      void (async () => {
        setUsagePricingSaveStateForProviders(targets, 'saving')
        const ok = await saveUsagePricingForProviders(targets, draft, { silent: true })
        if (ok) {
          targets.forEach((providerName) => {
            usagePricingLastSavedSigRef.current[providerName] = signature
          })
          setUsagePricingSaveStateForProviders(targets, 'saved')
        } else {
          setUsagePricingSaveStateForProviders(targets, 'error')
        }
      })()
    })
  }

  async function saveUsagePricingRow(
    providerName: string,
    options?: { silent?: boolean; draftOverride?: UsagePricingDraft; skipRefresh?: boolean },
  ): Promise<boolean> {
    const silent = options?.silent === true
    const skipRefresh = options?.skipRefresh === true
    const draft = options?.draftOverride ?? usagePricingDrafts[providerName]
    if (!draft) return false
    const mode = draft.mode
    if (mode === 'package_total') {
      const activated = await activatePackageTotalMode(providerName, draft, {
        skipRefresh,
        silentError: silent,
      })
      if (silent || !activated) return activated
      await openUsageScheduleModal(providerName, draft.currency)
      return true
    }
    try {
      if (mode === 'none') {
        await invoke('set_provider_manual_pricing', {
          provider: providerName,
          mode: 'none',
          amountUsd: null,
          packageExpiresAtUnixMs: null,
        })
      } else {
        const amountRaw = Number(draft.amountText)
        if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
          if (!silent) flashToast('Pricing amount must be > 0', 'error')
          return false
        }
        const amountUsd = convertCurrencyToUsd(amountRaw, draft.currency)
        await invoke('set_provider_manual_pricing', {
          provider: providerName,
          mode,
          amountUsd,
          packageExpiresAtUnixMs: null,
        })
      }
      await invoke('set_provider_gap_fill', {
        provider: providerName,
        mode: 'none',
        amountUsd: null,
      })
      if (!silent) flashToast(`Pricing saved: ${providerName}`)
      if (!skipRefresh) {
        await refreshConfig()
        await refreshUsageStatistics({ silent })
      }
      return true
    } catch (e) {
      if (!silent) flashToast(String(e), 'error')
      return false
    }
  }

  async function refreshUsageHistory(options?: { silent?: boolean; keepEditCell?: boolean }) {
    const silent = options?.silent === true
    const keepEditCell = options?.keepEditCell === true
    if (!silent) setUsageHistoryLoading(true)
    try {
      const res = await invoke<{ ok: boolean; rows: SpendHistoryRow[] }>('get_spend_history', {
        provider: null,
        days: 180,
        compactOnly: true,
      })
      const rows = Array.isArray(res?.rows) ? res.rows : []
      setUsageHistoryRows(rows)
      setUsageHistoryDrafts(() => {
        const next: Record<string, UsageHistoryDraft> = {}
        for (const row of rows) {
          const key = `${row.provider}|${row.day_key}`
          next[key] = historyDraftFromRow(row)
        }
        return next
      })
      if (!keepEditCell) setUsageHistoryEditCell(null)
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      if (!silent) setUsageHistoryLoading(false)
    }
  }

  function queueUsageHistoryAutoSave(row: SpendHistoryRow, field: 'effective' | 'per_req') {
    if (!usageHistoryModalOpen) return
    queueAutoSaveTimer('history:edit', () => {
      void saveUsageHistoryRow(row, { silent: true, keepEditCell: true, field })
    })
  }

  async function saveUsageHistoryRow(
    row: SpendHistoryRow,
    options?: { silent?: boolean; keepEditCell?: boolean; field?: 'effective' | 'per_req' },
  ) {
    const silent = options?.silent === true
    const keepEditCell = options?.keepEditCell === true
    const field = options?.field ?? 'effective'
    const key = `${row.provider}|${row.day_key}`
    const draft = usageHistoryDrafts[key] ?? historyDraftFromRow(row)
    const effectiveDraft = parsePositiveAmount(draft.effectiveText)
    const effectiveNow = historyEffectiveDisplayValue(row)
    const perReqDraft = parsePositiveAmount(draft.perReqText)
    const perReqNow = historyPerReqDisplayValue(row)
    const trackedBase = row.tracked_total_usd ?? 0
    const scheduledBase = row.scheduled_total_usd ?? 0
    const closeEnough = (a: number, b: number) => Math.abs(a - b) < 0.0005
    const effectiveChanged =
      effectiveDraft != null && (effectiveNow == null || !closeEnough(effectiveDraft, effectiveNow))
    const perReqChanged =
      perReqDraft != null && (perReqNow == null || !closeEnough(perReqDraft, perReqNow))
    let totalUsedUsd: number | null = null
    let usdPerReq: number | null = null

    if (field === 'per_req' && perReqChanged) {
      totalUsedUsd = null
      usdPerReq = perReqDraft
    } else if (field === 'effective' && effectiveChanged) {
      const minimum = trackedBase + scheduledBase
      if (effectiveDraft < minimum - 0.0005) {
        if (!silent) flashToast('Effective $ cannot be lower than tracked + scheduled', 'error')
        return
      }
      const delta = effectiveDraft - minimum
      totalUsedUsd = delta > 0.0005 ? delta : null
      usdPerReq = null
    } else {
      if (!silent) flashToast('No history change to save')
      return
    }
    try {
      await invoke('set_spend_history_entry', {
        provider: row.provider,
        dayKey: row.day_key,
        totalUsedUsd,
        usdPerReq,
      })
      if (!silent) flashToast(`History saved: ${row.provider} ${row.day_key}`)
      await refreshUsageHistory({ silent: true, keepEditCell })
      await refreshUsageStatistics({ silent: true })
    } catch (e) {
      if (!silent) flashToast(String(e), 'error')
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
          ? 'Switched to provider: ' + provider
          : target === 'gateway'
            ? 'Switched to gateway'
            : 'Switched to official'
      flashToast(msg)
      await refreshStatus({ refreshSwapStatus: false })
      await Promise.all([refreshCodexSwapStatus(homes), refreshConfig({ refreshProviderSwitchStatus: false })])
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      setProviderSwitchBusy(false)
    }
  }

  async function refreshStatus(options?: { refreshSwapStatus?: boolean }) {
    const shouldRefreshSwapStatus = options?.refreshSwapStatus ?? true
    if (isDevPreview) {
      setStatus(devStatus)
      if (shouldRefreshSwapStatus) {
        void refreshCodexSwapStatus()
      }
      return
    }
    try {
      const s = await invoke<Status>('get_status')
      setStatus(s)
      if (!overrideDirtyRef.current) setOverride(s.manual_override ?? '')
      if (shouldRefreshSwapStatus) {
        // Best-effort: keep swap badge fresh on the normal status poll cadence.
        void refreshCodexSwapStatus()
      }
    } catch (e) {
      console.error(e)
    }
  }

  async function refreshConfig(options?: { refreshProviderSwitchStatus?: boolean }) {
    const shouldRefreshProviderSwitchStatus = options?.refreshProviderSwitchStatus ?? true
    if (isDevPreview) {
      setConfig(devConfig)
      setBaselineBaseUrls(
        Object.fromEntries(Object.entries(devConfig.providers).map(([name, p]) => [name, p.base_url])),
      )
      setGatewayTokenPreview('ao_dev********7f2a')
      if (shouldRefreshProviderSwitchStatus) {
        void refreshProviderSwitchStatus()
      }
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
      if (homes.length > 0 && shouldRefreshProviderSwitchStatus) {
        void refreshProviderSwitchStatus(homes)
      }
    } catch (e) {
      console.error(e)
    }
  }

  const managedProviderNames = useMemo(() => {
    if (config?.providers) {
      const fromOrder = orderedConfigProviders.filter((name) => Boolean(config.providers[name]))
      const leftovers = Object.keys(config.providers)
        .filter((name) => !fromOrder.includes(name))
        .sort((a, b) => a.localeCompare(b))
      return [...fromOrder, ...leftovers].filter((name) => name !== 'official')
    }
    const fromSwitchboard = providerSwitchStatus?.provider_options ?? []
    const fromStatus = status?.providers ? Object.keys(status.providers) : []
    return Array.from(new Set([...fromSwitchboard, ...fromStatus])).filter(
      (name) => Boolean(name) && name !== 'official',
    )
  }, [config, orderedConfigProviders, providerSwitchStatus?.provider_options, status?.providers])
  const providerGroupLabelByName = useMemo(() => {
    const grouped = new Map<string, string[]>()
    managedProviderNames.forEach((providerName) => {
      const keyLabel = providerApiKeyLabel(providerName).trim()
      if (!keyLabel || keyLabel === '-' || keyLabel === 'set') return
      const names = grouped.get(keyLabel) ?? []
      names.push(providerName)
      grouped.set(keyLabel, names)
    })
    const labels: Record<string, string> = {}
    grouped.forEach((names) => {
      if (names.length < 2) return
      const merged = names.join(' / ')
      names.forEach((name) => {
        labels[name] = merged
      })
    })
    return labels
  }, [managedProviderNames, config])

  function providerDisplayName(providerName: string): string {
    return providerGroupLabelByName[providerName] ?? providerName
  }

  const providerNamesByKeyLabel = useMemo(() => {
    const grouped = new Map<string, string[]>()
    managedProviderNames.forEach((providerName) => {
      const keyLabel = providerApiKeyLabel(providerName).trim()
      if (!keyLabel || keyLabel === '-' || keyLabel === 'set') return
      const names = grouped.get(keyLabel) ?? []
      names.push(providerName)
      grouped.set(keyLabel, names)
    })
    return grouped
  }, [managedProviderNames, config])

  function linkedProvidersForApiKey(apiKeyRef: string, fallbackProvider: string): string[] {
    const key = apiKeyRef.trim()
    if (!key || key === '-' || key === 'set') return [fallbackProvider]
    const linked = providerNamesByKeyLabel.get(key) ?? []
    const unique = Array.from(new Set([...linked, fallbackProvider].filter(Boolean)))
    return unique.length ? unique : [fallbackProvider]
  }

  const switchboardProviderCards = useMemo(() => {
    return managedProviderNames.map((name) => {
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
  }, [config, status, managedProviderNames])

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
    const summaryActiveHours = usageSummary?.active_window_hours
    if (summaryActiveHours != null && Number.isFinite(summaryActiveHours) && summaryActiveHours > 0) {
      return summaryActiveHours
    }
    const bucketSeconds = usageStatistics?.bucket_seconds ?? 0
    if (bucketSeconds <= 0) return 0
    const activeBucketCount = usageTimeline.reduce(
      (sum, point) => sum + ((point.requests ?? 0) > 0 ? 1 : 0),
      0,
    )
    if (activeBucketCount <= 0) return 0
    return (activeBucketCount * bucketSeconds) / 3600
  }, [usageSummary?.active_window_hours, usageTimeline, usageStatistics?.bucket_seconds])
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
      avgTotalUsed: mean(usageByProvider.map((row) => providerTotalUsedDisplayUsd(row))),
    }
  }, [usageByProvider])
  const usagePricingProviderNames = managedProviderNames
  const usagePricingGroups = useMemo<UsagePricingGroup[]>(() => {
    const modePriority = (providerName: string) => {
      const mode = (config?.providers?.[providerName]?.manual_pricing_mode ?? 'none') as UsagePricingMode
      if (mode === 'package_total') return 2
      if (mode === 'per_request') return 1
      return 0
    }
    const groups = new Map<string, string[]>()
    usagePricingProviderNames.forEach((providerName) => {
      const keyLabel = providerApiKeyLabel(providerName).trim()
      const groupKey =
        keyLabel && keyLabel !== '-' && keyLabel !== 'set'
          ? `key:${keyLabel}`
          : `provider:${providerName}`
      const members = groups.get(groupKey) ?? []
      members.push(providerName)
      groups.set(groupKey, members)
    })
    return Array.from(groups.values()).map((providers) => {
      const primaryProvider =
        [...providers].sort((a, b) => modePriority(b) - modePriority(a) || a.localeCompare(b))[0] ?? providers[0]
      return {
        id: providers.join('|'),
        providers,
        primaryProvider,
        displayName: providers.join(' / '),
        keyLabel: providerApiKeyLabel(primaryProvider),
      }
    })
  }, [usagePricingProviderNames, config])
  const usageScheduleProviderOptions = managedProviderNames
  const usageScheduleSaveStatusText = useMemo(() => {
    if (usageScheduleSaveState === 'saving') return 'Auto-saving...'
    if (usageScheduleSaveState === 'saved') return 'Auto-saved'
    if (usageScheduleSaveState === 'invalid') {
      return usageScheduleSaveError
        ? `Auto-save paused: ${usageScheduleSaveError}`
        : 'Auto-save paused (complete row to save)'
    }
    if (usageScheduleSaveState === 'error') {
      return usageScheduleSaveError ? `Auto-save failed: ${usageScheduleSaveError}` : 'Auto-save failed'
    }
    return 'Auto-save'
  }, [usageScheduleSaveError, usageScheduleSaveState])
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
      const providerCount = Math.max(1, usageByProvider.length)
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
      const medianPerProvider = reqMedian / providerCount
      const peakPerProvider = peakReq / providerCount
      if (medianPerProvider > 0 && peakPerProvider >= medianPerProvider * 5) {
        messages.push(
          `Request spike around ${formatBucket(peakPoint.bucket_unix_ms)}: ${peakPerProvider.toFixed(1)}/provider vs median ${medianPerProvider.toFixed(1)}/provider`,
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

  function fmtKpiTokens(value?: number | null): string {
    if (value == null || !Number.isFinite(value) || value < 0) return '-'
    if (value >= 1_000_000_000_000) {
      const compact = value / 1_000_000_000_000
      const rounded = compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)
      return rounded.replace(/\.0$/, '') + 'T'
    }
    if (value >= 1_000_000_000) {
      const compact = value / 1_000_000_000
      const rounded = compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)
      return rounded.replace(/\.0$/, '') + 'B'
    }
    if (value >= 10_000_000) {
      const compact = value / 1_000_000
      const rounded = compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)
      return rounded.replace(/\.0$/, '') + 'M'
    }
    return Math.round(value).toLocaleString()
  }

  function fmtPricingSource(source?: string | null): string {
    if (!source || source === 'none') return 'unconfigured'
    if (source === 'token_rate') return 'monthly credit'
    if (source === 'provider_budget_api') return 'monthly credit'
    if (source === 'provider_budget_api+manual_history') return 'monthly credit'
    if (source === 'provider_budget_api_latest_day') return 'monthly credit'
    if (source === 'provider_token_rate') return 'monthly credit'
    if (source === 'manual_per_request') return 'manual'
    if (source === 'manual_per_request_timeline') return 'manual'
    if (source === 'manual_package_total') return 'manual package total'
    if (source === 'manual_package_timeline') return 'scheduled'
    if (source === 'manual_package_timeline+manual_history') return 'scheduled + manual'
    if (source === 'manual_history') return 'history manual'
    if (source === 'gap_fill_per_request') return 'gap fill $/req'
    if (source === 'gap_fill_total') return 'gap fill total'
    if (source === 'gap_fill_per_day_average') return 'gap fill $/day'
    return source
  }

  function providerTotalUsedDisplayUsd(row: UsageStatistics['summary']['by_provider'][number]): number | null {
    const totalUsed = row.total_used_cost_usd
    if (totalUsed == null || !Number.isFinite(totalUsed) || totalUsed <= 0) return null
    return totalUsed
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
      clearAutoSaveTimersByPrefix('pricing:')
      usagePricingLastSavedSigRef.current = {}
      setUsagePricingSaveState({})
      return
    }
    if (!config) return
    void refreshFxRatesDaily(false)
    if (usagePricingDraftsPrimedRef.current) return
    setUsagePricingDrafts(() => {
      const next: Record<string, UsagePricingDraft> = {}
      usagePricingProviderNames.forEach((providerName) => {
        const providerCfg = config?.providers?.[providerName]
        next[providerName] = buildUsagePricingDraft(providerName, providerCfg)
        usagePricingLastSavedSigRef.current[providerName] = pricingDraftSignature(next[providerName])
      })
      return next
    })
    setUsagePricingSaveState(() => {
      const next: Record<string, UsagePricingSaveState> = {}
      usagePricingProviderNames.forEach((providerName) => {
        next[providerName] = 'saved'
      })
      return next
    })
    usagePricingDraftsPrimedRef.current = true
  }, [usagePricingModalOpen, usagePricingProviderNames, config, closeUsagePricingCurrencyMenu])

  useEffect(() => {
    if (!usagePricingModalOpen || !config || !usagePricingDraftsPrimedRef.current) return
    const providerSet = new Set(usagePricingProviderNames)
    setUsagePricingDrafts((prev) => {
      const next: Record<string, UsagePricingDraft> = { ...prev }
      let changed = false
      usagePricingProviderNames.forEach((providerName) => {
        if (next[providerName]) return
        const providerCfg = config.providers?.[providerName]
        next[providerName] = buildUsagePricingDraft(providerName, providerCfg)
        usagePricingLastSavedSigRef.current[providerName] = pricingDraftSignature(next[providerName])
        changed = true
      })
      Object.keys(next).forEach((providerName) => {
        if (providerSet.has(providerName)) return
        delete next[providerName]
        delete usagePricingLastSavedSigRef.current[providerName]
        changed = true
      })
      return changed ? next : prev
    })
    setUsagePricingSaveState((prev) => {
      const next: Record<string, UsagePricingSaveState> = { ...prev }
      let changed = false
      usagePricingProviderNames.forEach((providerName) => {
        if (next[providerName]) return
        next[providerName] = 'saved'
        changed = true
      })
      Object.keys(next).forEach((providerName) => {
        if (providerSet.has(providerName)) return
        delete next[providerName]
        changed = true
      })
      return changed ? next : prev
    })
  }, [usagePricingModalOpen, usagePricingProviderNames, config])

  useEffect(() => {
    if (!usageHistoryModalOpen) {
      clearAutoSaveTimer('history:edit')
      return
    }
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

  useEffect(() => {
    if (!usageScheduleCurrencyMenu) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        closeUsageScheduleCurrencyMenu()
        return
      }
      if (usageScheduleCurrencyMenuRef.current?.contains(target)) return
      if (target.closest('.aoUsageScheduleCurrencyWrap')) return
      closeUsageScheduleCurrencyMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeUsageScheduleCurrencyMenu()
    }
    const onViewportChange = () => {
      closeUsageScheduleCurrencyMenu()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [usageScheduleCurrencyMenu])

  useEffect(() => {
    if (!usageScheduleModalOpen || usageScheduleLoading || usageScheduleSaving) {
      return
    }
    const signature = scheduleRowsSignature(usageScheduleRows)
    if (signature === usageScheduleLastSavedSigRef.current) {
      if (usageScheduleSaveState === 'saving') {
        setUsageScheduleSaveState('saved')
      } else if (usageScheduleSaveState === 'invalid' || usageScheduleSaveState === 'error') {
        setUsageScheduleSaveState('idle')
        setUsageScheduleSaveError('')
      }
      return
    }
    queueAutoSaveTimer('schedule:rows', () => {
      void autoSaveUsageScheduleRows(usageScheduleRows, signature)
    })
    return () => {
      clearAutoSaveTimer('schedule:rows')
    }
  }, [
    usageScheduleModalOpen,
    usageScheduleLoading,
    usageScheduleRows,
    usageScheduleSaving,
    usageScheduleSaveState,
  ])

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
                  <div className="aoUsageKpiValue">{fmtKpiTokens(usageSummary?.total_tokens)}</div>
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
                      Base Pricing
                    </button>
                    <button
                      className="aoTinyBtn"
                      onClick={() => {
                        const providerName =
                          usageScheduleProviderOptions.find(
                            (name) => config?.providers?.[name]?.manual_pricing_mode === 'package_total',
                          ) ??
                          usageScheduleProviderOptions[0] ??
                          usageByProvider[0]?.provider
                        if (!providerName) return
                        void openUsageScheduleModal(providerName, providerPreferredCurrency(providerName))
                      }}
                      disabled={!usageScheduleProviderOptions.length}
                    >
                      Pricing Timeline
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
                        <th>Source</th>
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
                          <td>{fmtUsdMaybe(providerTotalUsedDisplayUsd(p))}</td>
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
                  Open Base Pricing for current mode, Pricing Timeline for historical periods, and Daily History for
                  day-level fixes.
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
                  <button
                    className={
                      'aoSwitchQuickBtn aoSwitchQuickBtnHint' +
                      (providerSwitchStatus?.mode === 'provider' ? ' is-active' : '')
                    }
                    disabled
                  >
                    <span className="aoSwitchQuickTitle">Direct Provider</span>
                    <span className="aoSwitchQuickSub">
                      {providerSwitchStatus?.mode === 'provider' && providerSwitchStatus?.model_provider
                        ? 'Active: ' + providerSwitchStatus.model_provider
                        : 'Use selected provider below'}
                    </span>
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
                <div className="aoModalTitle">Daily History</div>
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
                  <colgroup>
                    <col className="aoUsageHistoryColDate" />
                    <col className="aoUsageHistoryColProv" />
                    <col className="aoUsageHistoryColReq" />
                    <col className="aoUsageHistoryColTok" />
                    <col className="aoUsageHistoryColReqUsd" />
                    <col className="aoUsageHistoryColEff" />
                    <col className="aoUsageHistoryColPkg" />
                    <col className="aoUsageHistoryColSrc" />
                    <col className="aoUsageHistoryColAct" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Provider</th>
                      <th>Req</th>
                      <th>Tokens</th>
                      <th>$ / req</th>
                      <th>Effective $</th>
                      <th>Package $</th>
                      <th>Source</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageHistoryRows.map((row) => {
                      const key = `${row.provider}|${row.day_key}`
                      const baseDraft = historyDraftFromRow(row)
                      const draft = usageHistoryDrafts[key] ?? baseDraft
                      const perReqDisplay = historyPerReqDisplayValue(row)
                      const effectiveDisplay = historyEffectiveDisplayValue(row)
                      const effectiveEditing = usageHistoryEditCell === `${key}|effective`
                      const perReqEditing = usageHistoryEditCell === `${key}|per_req`
                      return (
                        <tr key={key}>
                          <td className="aoUsageHistoryDateCell">{row.day_key}</td>
                          <td className="aoUsageProviderName">{row.provider}</td>
                          <td>{(row.req_count ?? 0).toLocaleString()}</td>
                          <td>{(row.total_tokens ?? 0).toLocaleString()}</td>
                          <td>
                            <div className="aoUsageHistoryValueCell">
                              {perReqEditing ? (
                                <input
                                  className="aoInput aoUsageHistoryInput"
                                  type="number"
                                  min="0"
                                  step="0.0001"
                                  placeholder="0"
                                  value={draft.perReqText}
                                  onChange={(e) => {
                                    setUsageHistoryDrafts((prev) => ({
                                      ...prev,
                                      [key]: { ...draft, perReqText: e.target.value },
                                    }))
                                    queueUsageHistoryAutoSave(row, 'per_req')
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      clearAutoSaveTimer('history:edit')
                                      setUsageHistoryEditCell(null)
                                      void saveUsageHistoryRow(row, { field: 'per_req' })
                                    } else if (e.key === 'Escape') {
                                      setUsageHistoryDrafts((prev) => ({ ...prev, [key]: baseDraft }))
                                      setUsageHistoryEditCell(null)
                                    }
                                  }}
                                  onBlur={() => {
                                    clearAutoSaveTimer('history:edit')
                                    setUsageHistoryEditCell(null)
                                    void saveUsageHistoryRow(row, {
                                      silent: true,
                                      keepEditCell: false,
                                      field: 'per_req',
                                    })
                                  }}
                                  autoFocus
                                />
                              ) : (
                                <span>{fmtUsdMaybe(perReqDisplay)}</span>
                              )}
                              <button
                                className="aoUsageHistoryEditBtn"
                                title="Edit $/req"
                                aria-label="Edit $/req"
                                onClick={() => {
                                  setUsageHistoryDrafts((prev) => ({ ...prev, [key]: draft }))
                                  setUsageHistoryEditCell(`${key}|per_req`)
                                }}
                              >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                                </svg>
                              </button>
                            </div>
                          </td>
                          <td>
                            <div className="aoUsageHistoryValueCell">
                              {effectiveEditing ? (
                                <input
                                  className="aoInput aoUsageHistoryInput"
                                  type="number"
                                  min="0"
                                  step="0.001"
                                  placeholder="0"
                                  value={draft.effectiveText}
                                  onChange={(e) => {
                                    setUsageHistoryDrafts((prev) => ({
                                      ...prev,
                                      [key]: { ...draft, effectiveText: e.target.value },
                                    }))
                                    queueUsageHistoryAutoSave(row, 'effective')
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      clearAutoSaveTimer('history:edit')
                                      setUsageHistoryEditCell(null)
                                      void saveUsageHistoryRow(row, { field: 'effective' })
                                    } else if (e.key === 'Escape') {
                                      setUsageHistoryDrafts((prev) => ({ ...prev, [key]: baseDraft }))
                                      setUsageHistoryEditCell(null)
                                    }
                                  }}
                                  onBlur={() => {
                                    clearAutoSaveTimer('history:edit')
                                    setUsageHistoryEditCell(null)
                                    void saveUsageHistoryRow(row, {
                                      silent: true,
                                      keepEditCell: false,
                                      field: 'effective',
                                    })
                                  }}
                                  autoFocus
                                />
                              ) : (
                                <span>{fmtUsdMaybe(effectiveDisplay)}</span>
                              )}
                              <button
                                className="aoUsageHistoryEditBtn"
                                title="Edit effective"
                                aria-label="Edit effective"
                                onClick={() => {
                                  setUsageHistoryDrafts((prev) => ({ ...prev, [key]: draft }))
                                  setUsageHistoryEditCell(`${key}|effective`)
                                }}
                              >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                                </svg>
                              </button>
                            </div>
                          </td>
                          <td>{fmtUsdMaybe(row.scheduled_package_total_usd ?? null)}</td>
                          <td>{fmtHistorySource(row.source)}</td>
                          <td>
                            <div className="aoUsageHistoryActions">
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
                                      setUsageHistoryEditCell(null)
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
                <div className="aoModalTitle">Base Pricing</div>
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
                {usagePricingGroups.map((group) => {
                  const providerName = group.primaryProvider
                  const providerCfg = config?.providers?.[providerName]
                  const draft = usagePricingDrafts[providerName] ?? buildUsagePricingDraft(providerName, providerCfg)
                  const mode = draft.mode
                  const scheduleManaged = mode === 'package_total'
                  const amountDisabled = !providerCfg || mode === 'none' || scheduleManaged
                  const groupState = usagePricingSaveState[providerName] ?? 'idle'
                  return (
                    <div key={`pricing-${group.id}`} className="aoUsagePricingRow">
                      <div className="aoUsagePricingProviderWrap">
                        <div className="aoUsagePricingProvider">{group.displayName}</div>
                        <div className="aoHint aoUsagePricingKeyHint">key: {group.keyLabel}</div>
                      </div>
                      <select
                        className="aoSelect aoUsagePricingSelect aoUsagePricingMode"
                        value={mode}
                        disabled={!providerCfg}
                        onChange={(e) => {
                          const nextMode = (e.target.value as UsagePricingMode) ?? 'none'
                          const nextDraft: UsagePricingDraft = {
                            ...draft,
                            mode: nextMode,
                            amountText: nextMode === 'none' ? '' : draft.amountText,
                          }
                          setUsagePricingDrafts((prev) => {
                            const next = { ...prev }
                            group.providers.forEach((name) => {
                              next[name] = nextDraft
                            })
                            return next
                          })
                          if (nextMode !== 'package_total') {
                            queueUsagePricingAutoSaveForProviders(group.providers, nextDraft)
                          } else {
                            clearAutoSaveTimer(`pricing:${group.id}`)
                            setUsagePricingSaveStateForProviders(group.providers, 'saving')
                            void (async () => {
                              const activated = await saveUsagePricingForProviders(group.providers, nextDraft, {
                                silent: true,
                              })
                              if (!activated) {
                                await openUsageScheduleModal(providerName, providerPreferredCurrency(providerName))
                                setUsagePricingSaveStateForProviders(group.providers, 'error')
                              } else {
                                const signature = pricingDraftSignature(nextDraft)
                                group.providers.forEach((name) => {
                                  usagePricingLastSavedSigRef.current[name] = signature
                                })
                                setUsagePricingSaveStateForProviders(group.providers, 'saved')
                              }
                            })()
                          }
                        }}
                      >
                        <option value="none">Monthly credit</option>
                        <option value="package_total">Monthly fee</option>
                        <option value="per_request">$ / request</option>
                      </select>
                      {scheduleManaged ? (
                        <>
                          <button
                            className="aoTinyBtn aoUsagePricingScheduleInline"
                            disabled={!providerCfg}
                            onClick={() =>
                              void openUsageScheduleModal(
                                providerName,
                                providerPreferredCurrency(providerName),
                              )
                            }
                          >
                            Schedule
                          </button>
                          <div className="aoUsagePricingSchedulePlaceholder" />
                        </>
                      ) : (
                        <>
                          <input
                            className="aoInput aoUsagePricingInput aoUsagePricingAmount"
                            type="number"
                            step="0.001"
                            min="0"
                            disabled={amountDisabled}
                            placeholder="Amount"
                            value={draft.amountText}
                            onChange={(e) => {
                              const nextDraft: UsagePricingDraft = {
                                ...draft,
                                amountText: e.target.value,
                              }
                              setUsagePricingDrafts((prev) => {
                                const next = { ...prev }
                                group.providers.forEach((name) => {
                                  next[name] = nextDraft
                                })
                                return next
                              })
                              queueUsagePricingAutoSaveForProviders(group.providers, nextDraft)
                            }}
                          />
                          <div className="aoUsagePricingCurrencyWrap">
                            <button
                              type="button"
                              className="aoSelect aoUsagePricingCurrencyBtn"
                              disabled={!providerCfg || amountDisabled}
                              aria-haspopup="listbox"
                              aria-expanded={usagePricingCurrencyMenu?.provider === providerName}
                              onClick={(e) => {
                                const button = e.currentTarget
                                const rect = button.getBoundingClientRect()
                                setUsagePricingCurrencyMenu((prev) => {
                                  if (prev?.provider === providerName) {
                                    setUsagePricingCurrencyQuery('')
                                    return null
                                  }
                                  setUsagePricingCurrencyQuery('')
                                  return {
                                    provider: providerName,
                                    providers: group.providers,
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
                        </>
                      )}
                      <div className="aoUsagePricingActions">
                        <span
                          className={`aoHint aoUsagePricingAutosave aoUsagePricingAutosave-${
                            groupState
                          }`}
                        >
                          {groupState === 'saving'
                            ? 'Auto-saving...'
                            : groupState === 'saved'
                              ? 'Auto-saved'
                              : groupState === 'error'
                                ? 'Auto-save failed'
                                : 'Auto-save'}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="aoHint">
                Monthly fee uses Scheduled Period History. Switching to Monthly credit keeps past history and applies
                credit after scheduled expiry.
              </div>
              <div className="aoHint">
                Providers sharing the same API key are linked as one row in Usage editing. Other pages still keep
                provider-level separation.
              </div>
            </div>
          </div>
          {usagePricingCurrencyMenu
            ? createPortal(
                (() => {
                  const providerName = usagePricingCurrencyMenu.provider
                  if (!usagePricingProviderNames.includes(providerName)) return null
                  const providerNames = (usagePricingCurrencyMenu.providers ?? [])
                    .filter((name) => usagePricingProviderNames.includes(name))
                  const targets = providerNames.length ? providerNames : [providerName]
                  const providerCfg = config?.providers?.[providerName]
                  const draft =
                    usagePricingDrafts[providerName] ?? buildUsagePricingDraft(providerName, providerCfg)
                  const amountDisabled = !providerCfg || draft.mode === 'package_total'
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
                              updateUsagePricingCurrency(targets, draft, normalized)
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

      {usageScheduleModalOpen ? (
        <ModalBackdrop
          className="aoModalBackdrop aoModalBackdropTop"
          onClose={() => {
            closeUsageScheduleCurrencyMenu()
            clearAutoSaveTimer('schedule:rows')
            setUsageScheduleSaveState('idle')
            setUsageScheduleSaveError('')
            setUsageScheduleModalOpen(false)
          }}
        >
          <div className="aoModal aoModalWide aoUsageScheduleModal" onClick={(e) => e.stopPropagation()}>
            <div className="aoModalHeader">
              <div>
                <div className="aoModalTitle">Pricing Timeline</div>
                <div className="aoModalSub">
                  Edit base pricing timeline rows (monthly fee or $/request) with explicit start/expires.
                </div>
              </div>
              <button
                className="aoBtn"
                onClick={() => {
                  closeUsageScheduleCurrencyMenu()
                  clearAutoSaveTimer('schedule:rows')
                  setUsageScheduleSaveState('idle')
                  setUsageScheduleSaveError('')
                  setUsageScheduleModalOpen(false)
                }}
              >
                Close
              </button>
            </div>
            <div className="aoModalBody">
              {usageScheduleLoading ? (
                <div className="aoHint">Loading...</div>
              ) : (
                <>
                  <table className="aoUsageScheduleTable">
                    <colgroup>
                      <col className="aoUsageScheduleColProvider" />
                      <col className="aoUsageScheduleColApiKey" />
                      <col className="aoUsageScheduleColMode" />
                      <col className="aoUsageScheduleColStart" />
                      <col className="aoUsageScheduleColExpires" />
                      <col className="aoUsageScheduleColAmount" />
                      <col className="aoUsageScheduleColCurrency" />
                      <col className="aoUsageScheduleColAction" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Provider</th>
                        <th>API Key</th>
                        <th>Mode</th>
                        <th>Start</th>
                        <th>Expires</th>
                        <th>Amount</th>
                        <th>Currency</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usageScheduleRows
                        .map((row, index) => ({ row, index }))
                        .sort((a, b) =>
                          a.row.provider.localeCompare(b.row.provider) ||
                          a.row.startText.localeCompare(b.row.startText) ||
                          a.row.endText.localeCompare(b.row.endText),
                        )
                        .map(({ row, index }) => (
                          <tr key={`${row.provider}-${row.id || 'new'}-${index}`}>
                            <td>{providerDisplayName(row.provider)}</td>
                            <td>{row.apiKeyRef || providerApiKeyLabel(row.provider)}</td>
                            <td>
                              <select
                                className="aoSelect aoUsageScheduleMode"
                                value={row.mode}
                                onChange={(e) => {
                                  const nextMode = (e.target.value as PricingTimelineMode) ?? 'package_total'
                                  setUsageScheduleSaveState('idle')
                                  setUsageScheduleRows((prev) =>
                                    prev.map((item, i) =>
                                      i === index ? { ...item, mode: nextMode } : item,
                                    ),
                                  )
                                }}
                              >
                                <option value="package_total">Monthly fee</option>
                                <option value="per_request">$ / request</option>
                              </select>
                            </td>
                            <td>
                              <input
                                className="aoInput aoUsageScheduleInput"
                                type="datetime-local"
                                value={row.startText}
                                onChange={(e) => {
                                  setUsageScheduleSaveState('idle')
                                  setUsageScheduleRows((prev) =>
                                    prev.map((item, i) =>
                                      i === index ? { ...item, startText: e.target.value } : item,
                                    ),
                                  )
                                }}
                              />
                            </td>
                            <td>
                              <input
                                className="aoInput aoUsageScheduleInput"
                                type="datetime-local"
                                value={row.endText}
                                onChange={(e) => {
                                  setUsageScheduleSaveState('idle')
                                  setUsageScheduleRows((prev) =>
                                    prev.map((item, i) =>
                                      i === index ? { ...item, endText: e.target.value } : item,
                                    ),
                                  )
                                }}
                              />
                            </td>
                            <td>
                              <input
                                className="aoInput aoUsageScheduleAmount"
                                type="number"
                                min="0"
                                step="0.001"
                                placeholder="0"
                                value={row.amountText}
                                onChange={(e) => {
                                  setUsageScheduleSaveState('idle')
                                  setUsageScheduleRows((prev) =>
                                    prev.map((item, i) =>
                                      i === index ? { ...item, amountText: e.target.value } : item,
                                    ),
                                  )
                                }}
                              />
                            </td>
                            <td>
                              <div className="aoUsageScheduleCurrencyWrap">
                                <button
                                  type="button"
                                  className="aoSelect aoUsageScheduleCurrencyBtn"
                                  aria-haspopup="listbox"
                                  aria-expanded={usageScheduleCurrencyMenu?.rowIndex === index}
                                  onClick={(e) => {
                                    const button = e.currentTarget
                                    const rect = button.getBoundingClientRect()
                                    setUsageScheduleCurrencyMenu((prev) => {
                                      if (prev?.rowIndex === index) {
                                        setUsageScheduleCurrencyQuery('')
                                        return null
                                      }
                                      setUsageScheduleCurrencyQuery('')
                                      return {
                                        rowIndex: index,
                                        left: Math.max(8, Math.round(rect.left)),
                                        top: Math.round(rect.bottom + 4),
                                        width: Math.round(rect.width),
                                      }
                                    })
                                  }}
                                >
                                  <span>{currencyLabel(normalizeCurrencyCode(row.currency))}</span>
                                  <span className="aoUsagePricingCurrencyChevron" aria-hidden="true">
                                    ▼
                                  </span>
                                </button>
                              </div>
                            </td>
                            <td>
                              <button
                                className="aoTinyBtn"
                                onClick={() => {
                                  setUsageScheduleSaveState('idle')
                                  setUsageScheduleRows((prev) => prev.filter((_, i) => i !== index))
                                }}
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                      {usageScheduleRows.length === 0 ? (
                        <tr>
                          <td colSpan={8}>
                            <div className="aoHint">No scheduled periods yet. Click Add Period to create one.</div>
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                  <div className="aoUsageScheduleActions">
                    <button
                      className="aoTinyBtn"
                      onClick={() => {
                        setUsageScheduleSaveState('idle')
                        const targetProvider =
                          usageScheduleProviderOptions.includes(usageScheduleProvider)
                            ? usageScheduleProvider
                            : usageScheduleProviderOptions[0] ?? usageScheduleProvider
                        if (!targetProvider) return
                        setUsageScheduleRows((prev) => {
                          const providerRows = prev.filter((item) => item.provider === targetProvider)
                          const last = providerRows[providerRows.length - 1]
                          const lastAmount = parsePositiveAmount(last?.amountText ?? '')
                          const lastCurrency = last?.currency
                          const fallbackCurrency =
                            lastCurrency ?? providerPreferredCurrency(targetProvider)
                          const providerAmountUsd =
                            config?.providers?.[targetProvider]?.manual_pricing_amount_usd ?? null
                          const seedAmountUsd =
                            lastAmount != null
                              ? convertCurrencyToUsd(lastAmount, fallbackCurrency)
                              : providerAmountUsd
                          const providerMode = (config?.providers?.[targetProvider]?.manual_pricing_mode ??
                            'package_total') as UsagePricingMode
                          const seedMode: PricingTimelineMode =
                            providerMode === 'per_request' ? 'per_request' : 'package_total'
                          const linkedProviders = linkedProvidersForApiKey(
                            providerApiKeyLabel(targetProvider),
                            targetProvider,
                          )
                          return [
                            ...prev,
                            newScheduleDraft(
                              targetProvider,
                              seedAmountUsd,
                              fallbackCurrency,
                              seedMode,
                              linkedProviders,
                            ),
                          ]
                        })
                      }}
                    >
                      Add Period
                    </button>
                    <span className={`aoHint aoUsageScheduleAutosave aoUsageScheduleAutosave-${usageScheduleSaveState}`}>
                      {usageScheduleSaveStatusText}
                    </span>
                  </div>
                  <div className="aoHint aoUsageScheduleHint">
                    Timeline rows are the source for historical base pricing. Editing here updates only listed rows.
                  </div>
                </>
              )}
            </div>
          </div>
          {usageScheduleCurrencyMenu
            ? createPortal(
                (() => {
                  const row = usageScheduleRows[usageScheduleCurrencyMenu.rowIndex]
                  if (!row) return null
                  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
                  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800
                  const width = Math.max(86, Math.min(132, usageScheduleCurrencyMenu.width))
                  const left = Math.max(8, Math.min(usageScheduleCurrencyMenu.left, viewportWidth - width - 8))
                  const menuHeight = 260
                  const belowSpace = viewportHeight - usageScheduleCurrencyMenu.top - 8
                  const top =
                    belowSpace >= 180
                      ? usageScheduleCurrencyMenu.top
                      : Math.max(8, usageScheduleCurrencyMenu.top - menuHeight - 36)
                  const maxHeight = Math.max(140, Math.min(menuHeight, viewportHeight - top - 8))
                  const query = usageScheduleCurrencyQuery.trim().toUpperCase()
                  const filteredOptions = usageCurrencyOptions.filter((currencyCode) => {
                    const normalized = normalizeCurrencyCode(currencyCode)
                    const label = currencyLabel(normalized).toUpperCase()
                    return query.length === 0 || normalized.includes(query) || label.includes(query)
                  })

                  return (
                    <div
                      ref={usageScheduleCurrencyMenuRef}
                      className="aoUsagePricingCurrencyMenu aoUsagePricingCurrencyMenuPortal"
                      role="listbox"
                      style={{ left, top, width, maxHeight }}
                    >
                      <div className="aoUsagePricingCurrencySearchWrap">
                        <input
                          className="aoInput aoUsagePricingCurrencySearch"
                          placeholder="Search"
                          value={usageScheduleCurrencyQuery}
                          onChange={(e) => setUsageScheduleCurrencyQuery(e.target.value)}
                          autoFocus
                        />
                      </div>
                      {filteredOptions.map((currencyCode) => {
                        const normalized = normalizeCurrencyCode(currencyCode)
                        const isActive = normalizeCurrencyCode(row.currency) === normalized
                        return (
                          <button
                            type="button"
                            key={currencyCode}
                            className={`aoUsagePricingCurrencyItem${isActive ? ' is-active' : ''}`}
                            onClick={() => {
                              updateUsageScheduleCurrency(usageScheduleCurrencyMenu.rowIndex, normalized)
                              closeUsageScheduleCurrencyMenu()
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
