import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'
import './components/AppShared.css'
import { recordStartupStage } from './startupTrace'
import type {
  CodexSwapStatus,
  Config,
  ProviderSwitchboardStatus,
  Status,
  UsageStatistics,
  UsageStatisticsOverview,
} from './types'
import { fmtAmount, fmtPct, fmtUsd, pctOf } from './utils/format'
import {
  fmtKpiTokens as formatKpiTokens,
  fmtPricingSource as formatPricingSource,
  fmtUsdMaybe as formatUsdMaybe,
  fmtUsageBucketLabel as formatUsageBucketLabel,
} from './utils/usageDisplay'
import type { SpendHistoryRow } from './devMockData'
import type {
  ProviderScheduleDraft,
  UsageHistoryDraft,
  UsagePricingDraft,
  UsagePricingSaveState,
  UsageScheduleSaveState,
} from './types/usage'
import {
  convertCurrencyToUsd,
  currencyLabel,
  normalizeCurrencyCode,
  parsePositiveAmount,
} from './utils/currency'
import { AppMainContent, preloadAppMainContentModules } from './components/AppMainContent'
import { AppTopNav } from './components/AppTopNav'
import type { EventLogDailyStat, EventLogEntry } from './components/EventLogPanel'
import type { LastErrorJump } from './components/ProvidersTable'
import { useConfigDrag } from './hooks/useConfigDrag'
import { useProviderActions } from './hooks/useProviderActions'
import { useUsageHistoryScrollbar } from './hooks/useUsageHistoryScrollbar'
import { useAppPolling } from './hooks/useAppPolling'
import { useAppPrefs } from './hooks/useAppPrefs'
import { useRefreshScheduler } from './hooks/useRefreshScheduler'
import { useSwitchboardStatusActions } from './hooks/useSwitchboardStatusActions'
import { useStatusDerivations } from './hooks/useStatusDerivations'
import { usePageScroll } from './hooks/usePageScroll'
import { useAppUsageEffects } from './hooks/useAppUsageEffects'
import { buildUsageRefreshRevision } from './hooks/useAppUsageEffects'
import { buildUsageHistoryQuotaRefreshToken } from './hooks/useAppUsageEffects'
import { useDashboardDerivations } from './hooks/useDashboardDerivations'
import { useProviderPanelUi } from './hooks/useProviderPanelUi'
import { useAppActions } from './hooks/useAppActions'
import { useUsageOpsBridge } from './hooks/useUsageOpsBridge'
import { useUsageUiDerived } from './hooks/useUsageUiDerived'
import { useMainContentCallbacks } from './hooks/useMainContentCallbacks'
import { useTopNavIntentPrefetch } from './hooks/useTopNavIntentPrefetch'
import type {
  KeyModalState,
  ProviderBaseUrlModalState,
  ProviderEmailModalState,
  UsageAuthModalState,
  UsageBaseModalState,
} from './hooks/providerActions/types'
import {
  buildCodexSwapBadge,
  resolveCliHomes,
} from './utils/switchboard'
import { usageProviderRowKey } from './utils/usageStatisticsView'
import {
  USAGE_REQUESTS_CANONICAL_QUERY_KEY,
  primeUsageRequestsPrefetchCache,
} from './components/UsageStatisticsPanel'
import {
  buildDevPreviewFollowConfig,
  copyDevPreviewBorrowedProvider,
  getDevPreviewSourceProviders,
  updateDevPreviewPairState,
} from './utils/devPreviewConfigSource'
import { lanConfigSourceSyncSignature } from './utils/lanConfigSourceSync'
import { ensureLanConfigSourceTrust, waitForLanConfigSourceTrust } from './utils/lanPairCompletion'

const AppModals = lazy(async () => {
  const module = await import('./components/AppModals')
  return { default: module.AppModals }
})

const ProviderGroupManagerModal = lazy(async () => {
  const module = await import('./components/ProviderGroupManagerModal')
  return { default: module.ProviderGroupManagerModal }
})

type TopPage =
  | 'dashboard'
  | 'usage_statistics'
  | 'usage_requests'
  | 'provider_switchboard'
  | 'event_log'
  | 'web_codex'
const RAW_DRAFT_WINDOWS_KEY = '__draft_windows__'
const RAW_DRAFT_WSL_KEY = '__draft_wsl2__'
const RAW_DRAFT_STORAGE_KEY = 'ao.rawConfigDraft.shared.v1'
const RAW_DRAFT_WINDOWS_STORAGE_KEY_LEGACY = 'ao.rawConfigDraft.windows.v1'
const RAW_DRAFT_WSL_STORAGE_KEY_LEGACY = 'ao.rawConfigDraft.wsl2.v1'
const USAGE_PROVIDER_SHOW_DETAILS_KEY = 'ao.usage.provider.showDetails.v1'
const EVENT_LOG_PRELOAD_REFRESH_MS = 15_000
const EVENT_LOG_PRELOAD_LIMIT = 5000

type CopyProviderResult = {
  target_name: string
  local_copy_state: 'copied' | 'linked'
}

type DevPreviewModule = typeof import('./devMockData')

function parseDevFlag(raw: string | null): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function createEmptyDevStatus(): Status {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    preferred_provider: '',
    manual_override: null,
    providers: {},
    metrics: {},
    recent_events: [],
    quota: {},
    ledgers: {},
    last_activity_unix_ms: 0,
    codex_account: { ok: false, signed_in: false },
  }
}

function createEmptyDevConfig(): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: '',
      session_preferred_providers: {},
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 2,
      cooldown_seconds: 60,
      request_timeout_seconds: 300,
    },
    providers: {},
    provider_order: [],
  }
}

recordStartupStage('frontend_app_module_loaded')

export default function App() {
  useEffect(() => {
    recordStartupStage('frontend_app_component_mounted')
  }, [])
  const isDevPreview = useMemo(() => {
    if (!import.meta.env.DEV) return false
    if (typeof window === 'undefined') return false
    const w = window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }
    return !Boolean(w.__TAURI__?.core?.invoke)
  }, [])
  const devFlags = useMemo(() => {
    if (typeof window === 'undefined') return new URLSearchParams()
    return new URLSearchParams(window.location.search)
  }, [])
  const [devPreviewModule, setDevPreviewModule] = useState<DevPreviewModule | null>(null)
  const devMockHistoryEnabled = useMemo(() => parseDevFlag(devFlags.get('mockHistory')), [devFlags])
  const devAutoOpenHistory = useMemo(() => parseDevFlag(devFlags.get('openHistory')), [devFlags])
  const rawConfigTestMode = useMemo(() => parseDevFlag(devFlags.get('test')), [devFlags])
  const devStatus = useMemo(() => devPreviewModule?.devStatus ?? createEmptyDevStatus(), [devPreviewModule])
  const devConfig = useMemo(() => devPreviewModule?.devConfig ?? createEmptyDevConfig(), [devPreviewModule])
  const [status, setStatus] = useState<Status | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [, setBaselineBaseUrls] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<string>('')
  const [override, setOverride] = useState<string>('') // '' => auto
  const [newProviderName, setNewProviderName] = useState<string>('')
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState<string>('')
  const [newProviderKey, setNewProviderKey] = useState<string>('')
  const [newProviderKeyStorage, setNewProviderKeyStorage] = useState<'auth_json' | 'config_toml_experimental_bearer_token'>('auth_json')
  const [providerPanelsOpen, setProviderPanelsOpen] = useState<Record<string, boolean>>({})
  const [keyModal, setKeyModal] = useState<KeyModalState>({
    open: false,
    provider: '',
    value: '',
    storage: 'auth_json',
    loading: false,
    loadFailed: false,
  })
  const [providerBaseUrlModal, setProviderBaseUrlModal] = useState<ProviderBaseUrlModalState>({
    open: false,
    provider: '',
    value: '',
  })
  const [usageBaseModal, setUsageBaseModal] = useState<UsageBaseModalState>({
    open: false,
    provider: '',
    baseUrl: '',
    showUrlInput: true,
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
  const [usageAuthModal, setUsageAuthModal] = useState<UsageAuthModalState>({
    open: false,
    provider: '',
    baseUrl: '',
    token: '',
    username: '',
    password: '',
    loading: false,
    loadFailed: false,
  })
  const [providerEmailModal, setProviderEmailModal] = useState<ProviderEmailModalState>({
    open: false,
    provider: '',
    value: '',
  })
  const overrideDirtyRef = useRef<boolean>(false)
  const [gatewayTokenPreview, setGatewayTokenPreview] = useState<string>('')
  const [gatewayTokenReveal, setGatewayTokenReveal] = useState<string>('')
  const [gatewayModalOpen, setGatewayModalOpen] = useState<boolean>(false)
  const [configModalOpen, setConfigModalOpen] = useState<boolean>(false)
  const [rawConfigModalOpen, setRawConfigModalOpen] = useState<boolean>(false)
  const [rawConfigTexts, setRawConfigTexts] = useState<Record<string, string>>({})
  const [rawConfigLoadingByHome, setRawConfigLoadingByHome] = useState<Record<string, boolean>>({})
  const [rawConfigSavingByHome, setRawConfigSavingByHome] = useState<Record<string, boolean>>({})
  const [rawConfigDirtyByHome, setRawConfigDirtyByHome] = useState<Record<string, boolean>>({})
  const [rawConfigLoadedByHome, setRawConfigLoadedByHome] = useState<Record<string, boolean>>({})
  const [rawConfigDraftByHome, setRawConfigDraftByHome] = useState<Record<string, boolean>>({})
  const [rawConfigHomeOptions, setRawConfigHomeOptions] = useState<string[]>([])
  const [rawConfigHomeLabels, setRawConfigHomeLabels] = useState<Record<string, string>>({})
  const [instructionModalOpen, setInstructionModalOpen] = useState<boolean>(false)
  const [codexSwapModalOpen, setCodexSwapModalOpen] = useState<boolean>(false)
  const [codexSwapDir1, setCodexSwapDir1] = useState<string>('')
  const [codexSwapDir2, setCodexSwapDir2] = useState<string>('')
  const [codexSwapUseWindows, setCodexSwapUseWindows] = useState<boolean>(false)
  const [codexSwapUseWsl, setCodexSwapUseWsl] = useState<boolean>(false)
  const [codexSwapTarget, setCodexSwapTarget] = useState<'windows' | 'wsl2' | 'both'>('both')
  const [codexSwapStatus, setCodexSwapStatus] = useState<CodexSwapStatus | null>(null)
  const [editingProviderName, setEditingProviderName] = useState<string | null>(null)
  const [providerNameDrafts, setProviderNameDrafts] = useState<Record<string, string>>({})
  const [refreshingProviders, setRefreshingProviders] = useState<Record<string, boolean>>({})
  const [codexRefreshing, setCodexRefreshing] = useState<boolean>(false)
  const [activePage, setActivePage] = useState<TopPage>('dashboard')
  const { runPrimaryRefresh, enqueueBackgroundRefresh } = useRefreshScheduler(activePage)
  const [eventLogFocusRequest, setEventLogFocusRequest] = useState<{
    provider: string
    unixMs: number
    message: string
    nonce: number
  } | null>(null)
  const [eventLogPreloadEntries, setEventLogPreloadEntries] = useState<EventLogEntry[]>([])
  const [eventLogPreloadDailyStats, setEventLogPreloadDailyStats] = useState<EventLogDailyStat[]>([])
  const [providerSwitchStatus, setProviderSwitchStatus] = useState<ProviderSwitchboardStatus | null>(null)
  const [providerGroupManagerOpen, setProviderGroupManagerOpen] = useState<boolean>(false)
  const [providerGroupManagerFocusProvider, setProviderGroupManagerFocusProvider] = useState<string | null>(null)
  const [usageOverview, setUsageOverview] = useState<UsageStatisticsOverview | null>(null)
  const [usageStatistics, setUsageStatistics] = useState<UsageStatistics | null>(null)
  const [usageWindowHours, setUsageWindowHours] = useState<number>(24)
  const [usageFilterNodes, setUsageFilterNodes] = useState<string[]>([])
  const [usageFilterProviders, setUsageFilterProviders] = useState<string[]>([])
  const [usageFilterModels, setUsageFilterModels] = useState<string[]>([])
  const [usageFilterOrigins, setUsageFilterOrigins] = useState<string[]>([])
  const usageRefreshRevision = useMemo(
    () =>
      buildUsageRefreshRevision({
        usageWindowHours,
        usageFilterNodes,
        usageFilterProviders,
        usageFilterModels,
        usageFilterOrigins,
      }),
    [
      usageWindowHours,
      usageFilterNodes,
      usageFilterProviders,
      usageFilterModels,
      usageFilterOrigins,
    ],
  )
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
  const [usageProviderShowDetails, setUsageProviderShowDetails] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(USAGE_PROVIDER_SHOW_DETAILS_KEY) !== '0'
  })
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
  const openProviderGroupManager = useCallback((provider?: string) => {
    setProviderGroupManagerFocusProvider(provider?.trim() ? provider.trim() : null)
    setProviderGroupManagerOpen(true)
  }, [])
  const [fxRatesByCurrency, setFxRatesByCurrency] = useState<Record<string, number>>({ USD: 1 })
  const [fxRatesDate, setFxRatesDate] = useState<string>('')
  const [usageChartHover, setUsageChartHover] = useState<{
    x: number
    y: number
    title: string
    subtitle: string
  } | null>(null)
  const [updatingSessionPref, setUpdatingSessionPref] = useState<Record<string, boolean>>({})
  const usagePricingDraftsPrimedRef = useRef<boolean>(false)
  const usageHistoryLoadedRef = useRef<boolean>(false)
  const {
    usageHistoryTableSurfaceRef,
    usageHistoryTableWrapRef,
    usageHistoryScrollbarOverlayRef,
    usageHistoryScrollbarThumbRef,
    refreshUsageHistoryScrollbarUi,
    scheduleUsageHistoryScrollbarSync,
    activateUsageHistoryScrollbarUi,
    onUsageHistoryScrollbarPointerDown,
    onUsageHistoryScrollbarPointerMove,
    onUsageHistoryScrollbarPointerUp,
    onUsageHistoryScrollbarLostPointerCapture,
    resetUsageHistoryScrollbarState,
    clearUsageHistoryScrollbarTimers,
  } = useUsageHistoryScrollbar()
  const codexSwapDir1Ref = useRef<string>('')
  const codexSwapDir2Ref = useRef<string>('')
  const codexSwapUseWindowsRef = useRef<boolean>(false)
  const codexSwapUseWslRef = useRef<boolean>(false)
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
  const rawConfigTestFailOnceRef = useRef<Record<string, boolean>>({})
  const eventLogPreloadSeqRef = useRef(0)
  const devPreviewLocalConfigRef = useRef<Config | null>(null)
  const devPreviewFollowSourceProvidersRef = useRef<Config['providers'] | null>(null)
  const rawConfigTextsRef = useRef<Record<string, string>>({})
  const rawConfigDraftAutoSaveTimerRef = useRef<Record<string, number>>({})
  const lastLanConfigSyncSignatureRef = useRef<string>('')
  const pairCompletionWatchSeqRef = useRef(0)
  const setRawConfigTextsSync = (
    updater: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>),
  ) => {
    setRawConfigTexts((prev) => {
      const next = typeof updater === 'function' ? (updater as (p: Record<string, string>) => Record<string, string>)(prev) : updater
      rawConfigTextsRef.current = next
      return next
    })
  }
  const { switchPage } = usePageScroll({ containerRef, mainAreaRef, activePage, setActivePage: (next) => setActivePage(next as TopPage) })
  const handleOpenLastErrorInEventLog = useCallback((payload: LastErrorJump) => {
    const nonce = Date.now()
    setEventLogFocusRequest({
      provider: payload.provider,
      unixMs: payload.unixMs,
      message: payload.message,
      nonce,
    })
    switchPage('event_log')
  }, [switchPage])
  const handleEventLogFocusRequestHandled = (nonce: number) => {
    setEventLogFocusRequest((current) => {
      if (!current) return current
      return current.nonce === nonce ? null : current
    })
  }
  const eventLogSeedEvents = useMemo(
    () => (eventLogPreloadEntries.length > 0 ? eventLogPreloadEntries : status?.recent_events ?? []),
    [eventLogPreloadEntries, status?.recent_events],
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as Window & {
      __ui_check__?: {
        jumpToEventLogError?: ((payload?: { provider: string; unixMs: number; message: string }) => boolean) | undefined
        primeRequestsPrefetchCache?: ((payload: {
          rows: Array<{
            id: string
            provider: string
            api_key_ref: string
            model: string
            origin: string
            session_id: string
            unix_ms: number
            node_id: string
            node_name: string
            input_tokens: number
            output_tokens: number
            total_tokens: number
            cache_creation_input_tokens: number
            cache_read_input_tokens: number
          }>
          hasMore?: boolean
          dailyTotals?: {
            days: Array<{
              day_start_unix_ms: number
              provider_totals: Record<string, number>
              total_tokens: number
            }>
            providers: Array<{
              provider: string
              total_tokens: number
            }>
          }
        }) => void) | undefined
      }
    }
    const prev = w.__ui_check__?.jumpToEventLogError
    const prevPrime = w.__ui_check__?.primeRequestsPrefetchCache
    const next = w.__ui_check__ ?? {}
    next.jumpToEventLogError = (payload) => {
      const candidate =
        payload
          ? {
              provider: payload.provider,
              unix_ms: payload.unixMs,
              message: payload.message,
            }
          : eventLogSeedEvents.find((row) => row.level === 'error')
      if (!candidate) return false
      handleOpenLastErrorInEventLog({
        provider: candidate.provider,
        unixMs: candidate.unix_ms,
        message: candidate.message,
      })
      return true
    }
    next.primeRequestsPrefetchCache = (payload) => {
      primeUsageRequestsPrefetchCache({
        queryKey: USAGE_REQUESTS_CANONICAL_QUERY_KEY,
        rows: payload?.rows ?? [],
        hasMore: Boolean(payload?.hasMore),
        dailyTotals: payload?.dailyTotals ?? null,
      })
    }
    w.__ui_check__ = next
    return () => {
      if (!w.__ui_check__) return
      if (prev) w.__ui_check__.jumpToEventLogError = prev
      else delete w.__ui_check__.jumpToEventLogError
      if (prevPrime) w.__ui_check__.primeRequestsPrefetchCache = prevPrime
      else delete w.__ui_check__.primeRequestsPrefetchCache
    }
  }, [eventLogSeedEvents, handleOpenLastErrorInEventLog])
  useEffect(() => {
    if (!isDevPreview) return
    let cancelled = false
    void import('./devMockData').then((module) => {
      if (cancelled) return
      setDevPreviewModule(module)
      setStatus(module.devStatus)
      setConfig(module.devConfig)
      setBaselineBaseUrls(
        Object.fromEntries(
          Object.entries(module.devConfig.providers).map(([name, provider]) => [name, provider.base_url]),
        ),
      )
      setGatewayTokenPreview('ao_dev********7f2a')
    })
    return () => {
      cancelled = true
    }
  }, [isDevPreview])
  useEffect(() => {
    if (activePage !== 'event_log') return
    let cancelled = false
    const loadEventLogPreload = async () => {
      const reqId = ++eventLogPreloadSeqRef.current
      try {
        const [entriesRaw, dailyRaw] = await Promise.all([
          invoke<EventLogEntry[]>('get_event_log_entries', {
            fromUnixMs: null,
            toUnixMs: null,
            limit: EVENT_LOG_PRELOAD_LIMIT,
          }),
          invoke<EventLogDailyStat[]>('get_event_log_daily_stats', {
            fromUnixMs: null,
            toUnixMs: null,
          }),
        ])
        if (cancelled || eventLogPreloadSeqRef.current !== reqId) return
        if (Array.isArray(entriesRaw)) {
          setEventLogPreloadEntries([...entriesRaw].sort((a, b) => b.unix_ms - a.unix_ms))
        }
        if (Array.isArray(dailyRaw)) {
          const normalized = dailyRaw
            .filter((row) =>
              row != null &&
              Number.isFinite(Number(row.day_start_unix_ms)) &&
              Number.isFinite(Number(row.total)) &&
              Number.isFinite(Number(row.infos)) &&
              Number.isFinite(Number(row.warnings)) &&
              Number.isFinite(Number(row.errors)),
            )
            .map((row) => ({
              day: String(row.day ?? ''),
              day_start_unix_ms: Number(row.day_start_unix_ms),
              total: Number(row.total),
              infos: Number(row.infos),
              warnings: Number(row.warnings),
              errors: Number(row.errors),
            }))
            .sort((a, b) => a.day_start_unix_ms - b.day_start_unix_ms)
          setEventLogPreloadDailyStats(normalized)
        }
      } catch {
        // Keep the last successful preload snapshot if refresh fails transiently.
      }
    }
    void loadEventLogPreload()
    const timer = window.setInterval(() => {
      void loadEventLogPreload()
    }, EVENT_LOG_PRELOAD_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activePage])
  useEffect(() => {
    rawConfigTextsRef.current = rawConfigTexts
  }, [rawConfigTexts])
  useAppPrefs({
    isDevPreview,
    devAutoOpenHistory,
    setUsageHistoryModalOpen,
    autoSaveTimersRef,
    setProviderPanelsOpen,
    providerPanelsOpen,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
    setCodexSwapDir1,
    setCodexSwapDir2,
    setCodexSwapUseWindows,
    setCodexSwapUseWsl,
    codexSwapDir1Ref,
    codexSwapDir2Ref,
    codexSwapUseWindowsRef,
    codexSwapUseWslRef,
    swapPrefsLoadedRef,
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = window.localStorage.getItem('ao.codexSwap.target')
    if (raw === 'windows' || raw === 'wsl2' || raw === 'both') {
      setCodexSwapTarget(raw)
    }
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('ao.codexSwap.target', codexSwapTarget)
  }, [codexSwapTarget])
  useEffect(() => {
    if (codexSwapUseWindows && codexSwapUseWsl) return
    if (codexSwapUseWindows && codexSwapTarget !== 'windows') {
      setCodexSwapTarget('windows')
      return
    }
    if (codexSwapUseWsl && codexSwapTarget !== 'wsl2') {
      setCodexSwapTarget('wsl2')
      return
    }
  }, [codexSwapUseWindows, codexSwapUseWsl, codexSwapTarget])
  const { providers, clientSessions } = useStatusDerivations({
    status,
    config,
  })
  const flashToast = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    setToast(msg)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    const ms = kind === 'error' ? 5200 : 2400
    toastTimerRef.current = window.setTimeout(() => setToast(''), ms)
  }, [])

  function draftStorageKeyForHome(home: string): string | null {
    if (home === RAW_DRAFT_WINDOWS_KEY || home === RAW_DRAFT_WSL_KEY) return RAW_DRAFT_STORAGE_KEY
    return null
  }

  function readDraftFromStorage(home: string): string {
    if (typeof window === 'undefined') return ''
    const key = draftStorageKeyForHome(home)
    if (!key) return ''
    try {
      const current = window.localStorage.getItem(key)
      if (current != null) return current
      // one-time legacy fallback: prefer non-empty value if it exists
      const legacyWindows = window.localStorage.getItem(RAW_DRAFT_WINDOWS_STORAGE_KEY_LEGACY) ?? ''
      const legacyWsl = window.localStorage.getItem(RAW_DRAFT_WSL_STORAGE_KEY_LEGACY) ?? ''
      const migrated = legacyWindows || legacyWsl
      if (migrated) {
        window.localStorage.setItem(key, migrated)
      }
      return migrated
    } catch {
      return ''
    }
  }

  function writeDraftToStorage(home: string, text: string): void {
    if (typeof window === 'undefined') return
    const key = draftStorageKeyForHome(home)
    if (!key) return
    try {
      window.localStorage.setItem(key, text)
    } catch {
      // ignore storage write failures
    }
  }

  async function loadRawConfigHome(home: string) {
    const target = home.trim()
    if (!target) return
    setRawConfigLoadingByHome((prev) => ({ ...prev, [target]: true }))
    try {
      if (rawConfigTestMode || isDevPreview) {
        const lower = target.toLowerCase()
        const shouldFailOnce = (lower.includes('\\wsl.localhost\\') || lower.includes('\\wsl$\\')) && !rawConfigTestFailOnceRef.current[target]
        if (shouldFailOnce) {
          rawConfigTestFailOnceRef.current[target] = true
          setRawConfigTextsSync((prev) => ({ ...prev, [target]: '' }))
          setRawConfigDirtyByHome((prev) => ({ ...prev, [target]: false }))
          setRawConfigLoadedByHome((prev) => ({ ...prev, [target]: false }))
          flashToast('[TEST] Simulated load failure for WSL2 target.', 'error')
          return
        }
        const mockToml = Array.from({ length: 64 }, (_, idx) => {
          const n = String(idx + 1).padStart(2, '0')
          return `# [TEST] sample line ${n}\nmodel_provider = "api_router"\n`
        }).join('\n')
        setRawConfigTextsSync((prev) => ({
          ...prev,
          [target]: prev[target] || mockToml,
        }))
        setRawConfigDirtyByHome((prev) => ({ ...prev, [target]: false }))
        setRawConfigLoadedByHome((prev) => ({ ...prev, [target]: true }))
        return
      }
      const txt = await invoke<string>('get_codex_cli_config_toml', {
        cliHome: target,
      })
      setRawConfigTextsSync((prev) => ({ ...prev, [target]: txt }))
      setRawConfigDirtyByHome((prev) => ({ ...prev, [target]: false }))
      setRawConfigLoadedByHome((prev) => ({ ...prev, [target]: true }))
    } catch (e) {
      setRawConfigTextsSync((prev) => ({ ...prev, [target]: '' }))
      setRawConfigLoadedByHome((prev) => ({ ...prev, [target]: false }))
      flashToast(String(e), 'error')
    } finally {
      setRawConfigLoadingByHome((prev) => ({ ...prev, [target]: false }))
    }
  }

  function buildRawConfigModalPanes(
    windowsEnabled: boolean,
    windowsHome: string,
    wslEnabled: boolean,
    wslHome: string,
  ): {
    homeOptions: string[]
    draftByHome: Record<string, boolean>
    labels: Record<string, string>
  } {
    const windowsPane = windowsEnabled && windowsHome ? windowsHome : RAW_DRAFT_WINDOWS_KEY
    const wslPane = wslEnabled && wslHome ? wslHome : RAW_DRAFT_WSL_KEY
    const windowsIsDraft = windowsPane === RAW_DRAFT_WINDOWS_KEY
    const wslIsDraft = wslPane === RAW_DRAFT_WSL_KEY

    let homeOptions: string[]
    if (!windowsIsDraft && !wslIsDraft) {
      homeOptions = [windowsPane, wslPane]
    } else if (!windowsIsDraft && wslIsDraft) {
      homeOptions = [windowsPane, wslPane]
    } else if (windowsIsDraft && !wslIsDraft) {
      homeOptions = [wslPane, windowsPane]
    } else {
      homeOptions = [windowsPane, wslPane]
    }

    const draftByHome: Record<string, boolean> = {
      [windowsPane]: windowsIsDraft,
      [wslPane]: wslIsDraft,
    }
    const labels: Record<string, string> = {
      [windowsPane]: windowsIsDraft
        ? 'Draft: local scratchpad (not written to file)'
        : `Windows: ${windowsPane}`,
      [wslPane]: wslIsDraft
        ? 'Draft: local scratchpad (not written to file)'
        : `WSL2: ${wslPane}`,
    }
    return { homeOptions, draftByHome, labels }
  }

  async function openRawConfigModal(options?: { reopenGettingStartedOnFail?: boolean }) {
    const reopenGettingStartedOnFail = Boolean(options?.reopenGettingStartedOnFail)
    if (rawConfigTestMode || isDevPreview) {
      const mockWindowsHome = 'C:\\Users\\<user>\\.codex'
      const mockWslHome = '\\\\wsl.localhost\\Ubuntu\\home\\<user>\\.codex'
      const { homeOptions, draftByHome, labels } = buildRawConfigModalPanes(
        codexSwapUseWindows,
        mockWindowsHome,
        codexSwapUseWsl,
        mockWslHome,
      )
      setRawConfigHomeOptions(homeOptions)
      setRawConfigDraftByHome(draftByHome)
      setRawConfigHomeLabels(labels)
      setRawConfigTextsSync(
        Object.fromEntries(homeOptions.map((home) => [home, draftByHome[home] ? readDraftFromStorage(home) : ''])),
      )
      setRawConfigDirtyByHome({})
      setRawConfigLoadedByHome(Object.fromEntries(homeOptions.map((home) => [home, draftByHome[home]])))
      setRawConfigSavingByHome({})
      setRawConfigLoadingByHome({})
      rawConfigTestFailOnceRef.current = {}
      setRawConfigModalOpen(true)
      await Promise.all(homeOptions.filter((home) => !draftByHome[home]).map((home) => loadRawConfigHome(home)))
      return
    }
    try {
      const windowsHome = codexSwapDir1.trim()
      const wslHome = codexSwapDir2.trim()
      const { homeOptions, draftByHome, labels } = buildRawConfigModalPanes(
        codexSwapUseWindows,
        windowsHome,
        codexSwapUseWsl,
        wslHome,
      )
      setRawConfigDraftByHome(draftByHome)
      setRawConfigHomeOptions(homeOptions)
      setRawConfigHomeLabels(labels)
      setRawConfigTextsSync(
        Object.fromEntries(homeOptions.map((home) => [home, draftByHome[home] ? readDraftFromStorage(home) : ''])),
      )
      setRawConfigDirtyByHome({})
      setRawConfigLoadedByHome(Object.fromEntries(homeOptions.map((home) => [home, Boolean(draftByHome[home])])))
      setRawConfigSavingByHome({})
      setRawConfigLoadingByHome({})
      setRawConfigModalOpen(true)
      await Promise.all(homeOptions.filter((home) => !draftByHome[home]).map((home) => loadRawConfigHome(home)))
    } catch (e) {
      const msg = String(e)
      flashToast(msg, 'error')
      if (reopenGettingStartedOnFail) setInstructionModalOpen(true)
    }
  }

  function updateRawConfigText(home: string, next: string) {
    setRawConfigTextsSync((prev) => ({ ...prev, [home]: next }))
    setRawConfigDirtyByHome((prev) => ({ ...prev, [home]: true }))
    if (rawConfigDraftByHome[home]) {
      setRawConfigSavingByHome((prev) => ({ ...prev, [home]: true }))
    }
  }

  async function saveRawConfigHome(home: string) {
    const target = home.trim()
    if (!target) return
    if (rawConfigSavingByHome[target]) return
    if (!rawConfigLoadedByHome[target]) return
    if (rawConfigDraftByHome[target]) {
      setRawConfigSavingByHome((prev) => ({ ...prev, [target]: true }))
      writeDraftToStorage(target, rawConfigTextsRef.current[target] ?? '')
      setRawConfigDirtyByHome((prev) => ({ ...prev, [target]: false }))
      setRawConfigSavingByHome((prev) => ({ ...prev, [target]: false }))
      flashToast('Saved draft')
      return
    }
    if (rawConfigTestMode || isDevPreview) {
      setRawConfigDirtyByHome((prev) => ({ ...prev, [target]: false }))
      flashToast('[TEST] Saved in sandbox only (no real files changed).')
      return
    }
    setRawConfigSavingByHome((prev) => ({ ...prev, [target]: true }))
    try {
      await invoke('set_codex_cli_config_toml', {
        cliHome: target,
        tomlText: rawConfigTextsRef.current[target] ?? '',
      })
      setRawConfigDirtyByHome((prev) => ({ ...prev, [target]: false }))
      flashToast(`Saved: ${target}`)
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      setRawConfigSavingByHome((prev) => ({ ...prev, [target]: false }))
    }
  }
  const {
    providerSwitchBusy,
    toggleCodexSwap,
    refreshProviderSwitchStatus,
    refreshGatewayTokenPreview,
    refreshStatus,
    refreshConfig,
    setProviderSwitchTarget,
  } = useSwitchboardStatusActions({
    isDevPreview,
    devStatus,
    devConfig,
    listenPort: config?.listen.port ?? devConfig.listen.port,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
    codexSwapDir1Ref,
    codexSwapDir2Ref,
    codexSwapUseWindowsRef,
    codexSwapUseWslRef,
    overrideDirtyRef,
    setStatus,
    setOverride,
    setConfig,
    setBaselineBaseUrls,
    setGatewayTokenPreview,
    codexSwapStatus,
    setCodexSwapStatus,
    providerSwitchStatus,
    setProviderSwitchStatus,
    flashToast,
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    for (const [home, timer] of Object.entries(rawConfigDraftAutoSaveTimerRef.current)) {
      if (!rawConfigDraftByHome[home] && timer != null) {
        window.clearTimeout(timer)
        delete rawConfigDraftAutoSaveTimerRef.current[home]
      }
    }
    for (const [home, isDraft] of Object.entries(rawConfigDraftByHome)) {
      if (!isDraft) continue
      if (!rawConfigDirtyByHome[home]) continue
      const prevTimer = rawConfigDraftAutoSaveTimerRef.current[home]
      if (prevTimer != null) window.clearTimeout(prevTimer)
      rawConfigDraftAutoSaveTimerRef.current[home] = window.setTimeout(() => {
        setRawConfigSavingByHome((prev) => ({ ...prev, [home]: true }))
        writeDraftToStorage(home, rawConfigTextsRef.current[home] ?? '')
        setRawConfigDirtyByHome((prev) => ({ ...prev, [home]: false }))
        setRawConfigSavingByHome((prev) => ({ ...prev, [home]: false }))
        delete rawConfigDraftAutoSaveTimerRef.current[home]
      }, 450)
    }
    return () => {
      for (const timer of Object.values(rawConfigDraftAutoSaveTimerRef.current)) {
        if (timer != null) window.clearTimeout(timer)
      }
    }
  }, [rawConfigDraftByHome, rawConfigDirtyByHome, rawConfigTexts])
  const {
    setSessionPreferred,
    orderedConfigProviders,
    nextProviderPlaceholder,
    applyOverride,
    setPreferred,
    setRouteMode,
    applyProviderOrder,
    onDevPreviewBootstrap,
  } = useAppActions({
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
    setOverride,
    setBaselineBaseUrls,
    setGatewayTokenPreview,
    devStatus,
    devConfig,
  })
  useEffect(() => {
    if (!config) return
    setBaselineBaseUrls((prev) => {
      const next: Record<string, string> = { ...prev }
      let changed = false
      for (const [name, provider] of Object.entries(config.providers ?? {})) {
        if (!Object.prototype.hasOwnProperty.call(next, name)) {
          next[name] = provider.base_url
          changed = true
        }
      }
      for (const name of Object.keys(next)) {
        if (!config.providers?.[name]) {
          delete next[name]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [config, setBaselineBaseUrls])
  const onDevPreviewTick = useCallback(() => {
    if (!devPreviewModule) return
    setStatus((prev) => devPreviewModule.evolveDevStatus(prev))
  }, [devPreviewModule])
  const codexSwapBadge = useMemo(() => {
    const windowsHome = codexSwapUseWindows ? codexSwapDir1.trim() : ''
    const wslHome = codexSwapUseWsl ? codexSwapDir2.trim() : ''
    const selectedHomes =
      codexSwapTarget === 'windows'
        ? windowsHome
          ? [windowsHome]
          : []
        : codexSwapTarget === 'wsl2'
          ? wslHome
            ? [wslHome]
            : []
          : resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapUseWindows, codexSwapUseWsl)
    return buildCodexSwapBadge(codexSwapStatus, providerSwitchStatus, selectedHomes)
  }, [
    codexSwapStatus,
    providerSwitchStatus,
    codexSwapTarget,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
  ])
  const routeMode = (config?.routing.route_mode ?? 'follow_preferred_auto') as
    | 'follow_preferred_auto'
    | 'balanced_auto'
  const {
    providerListRef,
    registerProviderCardRef,
    onProviderHandlePointerDown,
    draggingProvider,
    dragOverProvider,
    dragPreviewOrder,
    dragOffsetY,
    dragBaseTop,
    dragCardHeight,
  } = useConfigDrag({ orderedConfigProviders, applyProviderOrder, configModalOpen })
  const {
    onCopyToken,
    onShowGatewayRotate,
    onCodexLoginLogout,
    onCodexRefresh,
    onCodexSwapAuthConfig,
    onOpenCodexSwapOptions,
    onOverrideChange,
  } = useMainContentCallbacks({
    status,
    flashToast,
    setGatewayModalOpen,
    setGatewayTokenReveal,
    setGatewayTokenPreview,
    setCodexRefreshing,
    refreshStatus,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
    codexSwapTarget,
    providerSwitchStatus,
    setProviderSwitchTarget,
    setCodexSwapModalOpen,
    override,
    setOverride,
    overrideDirtyRef,
    applyOverride,
  })
  const {
    clearAutoSaveTimer,
    clearAutoSaveTimersByPrefix,
    queueAutoSaveTimer,
    refreshUsageOverview,
    refreshUsageStatistics,
    usageCurrencyOptions,
    providerApiKeyLabel,
    providerPreferredCurrency,
    updateUsagePricingCurrency,
    closeUsageScheduleCurrencyMenu,
    updateUsageScheduleCurrency,
    scheduleRowsSignature,
    newScheduleDraft,
    historyEffectiveDisplayValue,
    historyPerReqDisplayValue,
    historyDraftFromRow,
    fmtHistorySource,
    closeUsagePricingCurrencyMenu,
    pricingDraftSignature,
    buildUsagePricingDraft,
    refreshFxRatesDaily,
    openUsageScheduleModal,
    autoSaveUsageScheduleRows,
    setUsagePricingSaveStateForProviders,
    saveUsagePricingForProviders,
    queueUsagePricingAutoSaveForProviders,
    refreshUsageHistory,
    queueUsageHistoryAutoSave,
    saveUsageHistoryRow,
  } = useUsageOpsBridge({
    isDevPreview,
    usageWindowHours,
    usageFilterNodes,
    usageFilterProviders,
    usageFilterModels,
    usageFilterOrigins,
    setUsageOverview,
    setUsageStatistics,
    setUsageStatisticsLoading,
    flashToast,
    autoSaveTimersRef,
    fxRatesByCurrency,
    setFxRatesByCurrency,
    setFxRatesDate,
    config,
    setUsagePricingDrafts,
    usageScheduleRows,
    setUsageScheduleRows,
    setUsageScheduleCurrencyMenu,
    setUsageScheduleCurrencyQuery,
    setUsageScheduleProvider,
    setUsageScheduleModalOpen,
    setUsageScheduleLoading,
    setUsageScheduleSaveState,
    setUsageScheduleSaveError,
    setUsageScheduleSaving,
    usageScheduleModalOpen,
    usageScheduleLastSavedSigRef,
    usageScheduleLastSavedByProviderRef,
    setUsagePricingCurrencyMenu,
    setUsagePricingCurrencyQuery,
    refreshConfig,
    usageHistoryModalOpen,
    usagePricingModalOpen,
    setUsagePricingSaveState,
    usagePricingLastSavedSigRef,
    usagePricingDrafts,
    setUsageHistoryLoading,
    devMockHistoryEnabled,
    setUsageHistoryRows,
    usageHistoryLoadedRef,
    setUsageHistoryDrafts,
    setUsageHistoryEditCell,
    usageHistoryDrafts,
  })
  const {
    handleUsageStatisticsIntentPrefetch,
    handleUsageRequestsIntentPrefetch,
  } = useTopNavIntentPrefetch({
    activePage,
    refreshUsageStatistics,
    clientSessions: status?.client_sessions ?? [],
  })
  const usageHistoryQuotaRefreshToken = useMemo(
    () => buildUsageHistoryQuotaRefreshToken(status?.quota),
    [status?.quota],
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    let idleId: number | null = null
    let timerId: number | null = null
    const runPreload = () => {
      if (cancelled) return
      void preloadAppMainContentModules()
    }
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(runPreload, { timeout: 1200 })
    } else {
      timerId = window.setTimeout(runPreload, 300)
    }
    return () => {
      cancelled = true
      if (idleId != null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId)
      }
      if (timerId != null) {
        window.clearTimeout(timerId)
      }
    }
  }, [])
  const {
    providerGroupLabelByName, linkedProvidersForApiKey, switchboardProviderCards, switchboardModeLabel,
    switchboardModelProviderLabel, switchboardTargetDirsLabel, usageSummary, usageByProvider, usageTotalInputTokens,
    usageTotalOutputTokens, usageAvgTokensPerRequest, usageTopModel, usageNodeFilterOptions, usageProviderFilterOptions,
    usageProviderFilterDisplayOptions, usageModelFilterOptions,
    usageOriginFilterOptions,
    usageProviderDisplayGroups, usagePricedRequestCount, usageDedupedTotalUsedUsd, usagePricedCoveragePct,
    usageActiveWindowHours, usageAvgRequestsPerHour, usageAvgTokensPerHour, usageWindowLabel,
    usageProviderTotalsAndAverages, usagePricingProviderNames, usagePricingGroups, usageScheduleProviderOptions,
    usageAnomalies, toggleUsageProviderFilterDisplayOption, toggleUsageModelFilter, toggleUsageNodeFilter, toggleUsageOriginFilter, usageChart, showUsageChartHover,
  } = useDashboardDerivations({
    config,
    orderedConfigProviders,
    providerSwitchStatus,
    status,
    providerApiKeyLabel,
    fmtPct,
    fmtAmount,
    fmtUsd,
    pctOf,
    usageOverview,
    usageStatistics,
    usageFilterNodes,
    setUsageFilterNodes,
    usageFilterProviders,
    setUsageFilterProviders,
    usageFilterModels,
    setUsageFilterModels,
    usageFilterOrigins,
    setUsageFilterOrigins,
    usageWindowHours,
    setUsageChartHover,
    formatUsdMaybe,
  })
  const { providerDisplayName, usageScheduleSaveStatusText } = useUsageUiDerived({
    providerGroupLabelByName,
    usageScheduleSaveState,
    usageScheduleSaveError,
    setUsageFilterNodes,
    usageNodeFilterOptions,
    setUsageFilterProviders,
    usageProviderFilterOptions,
    setUsageFilterModels,
    usageModelFilterOptions,
    setUsageFilterOrigins,
    usageOriginFilterOptions,
  })
  const {
    setProviderDisabled, deleteProvider, saveKey, clearKey, saveProviderBaseUrl, refreshQuota,
    saveUsageBaseUrl, saveUsageAuth, clearUsageAuth, saveProviderEmail, clearProviderEmail,
    setUsageBaseUrl, clearUsageBaseUrl, setProviderQuotaHardCap,
    openKeyModal, openProviderBaseUrlModal, openUsageBaseModal, openUsageAuthModal, openProviderEmailModal, addProvider,
    setProvidersGroup,
  } = useProviderActions({
    config,
    status,
    setStatus,
    isDevPreview,
    setConfig,
    keyModal,
    providerBaseUrlModal,
    providerEmailModal,
    usageBaseModal,
    usageAuthModal,
    newProviderName,
    newProviderBaseUrl,
    newProviderKey,
    newProviderKeyStorage,
    setKeyModal,
    setProviderBaseUrlModal,
    setProviderEmailModal,
    setUsageBaseModal,
    setUsageAuthModal,
    setNewProviderName,
    setNewProviderBaseUrl,
    setNewProviderKey,
    setNewProviderKeyStorage,
    setRefreshingProviders,
    refreshStatus,
    refreshConfig,
    flashToast,
  })
  async function followConfigSource(nodeId: string) {
    try {
      if (isDevPreview) {
        setConfig((prev) => {
          if (!prev) return prev
          const localSnapshot = devPreviewLocalConfigRef.current ?? prev
          if (prev.config_source?.mode !== 'follow') {
            devPreviewLocalConfigRef.current = prev
          }
          devPreviewFollowSourceProvidersRef.current = getDevPreviewSourceProviders(nodeId, localSnapshot)
          return buildDevPreviewFollowConfig(
            prev,
            nodeId,
            localSnapshot,
            devPreviewFollowSourceProvidersRef.current,
          )
        })
        flashToast(`Following config source [TEST]: ${nodeId}`)
        return
      }
      await invoke('set_followed_config_source', { nodeId })
      flashToast(`Following config source: ${nodeId}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }
  async function clearFollowedConfigSource() {
    try {
      if (isDevPreview) {
        setConfig(devPreviewLocalConfigRef.current ?? devConfig)
        devPreviewLocalConfigRef.current = null
        devPreviewFollowSourceProvidersRef.current = null
        flashToast('Returned to local config source [TEST]')
        return
      }
      await invoke('clear_followed_config_source')
      flashToast('Returned to local config source')
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }
  async function requestLanPair(nodeId: string): Promise<string | null> {
    try {
      if (isDevPreview) {
        const requestId = `pair_${nodeId}`
        setConfig((prev) => {
          if (!prev) return prev
          return updateDevPreviewPairState(prev, nodeId, (source) => ({
            ...source,
            trusted: false,
            pair_state: 'pin_required',
            pair_request_id: requestId,
            follow_allowed: false,
            follow_blocked_reason: 'pair this device before following its config',
          }))
        })
        return requestId
      }
      const requestId = await invoke<string>('request_lan_pair', { nodeId })
      await refreshConfig()
      return requestId
    } catch (e) {
      flashToast(String(e), 'error')
      return null
    }
  }
  async function watchLanPairTrust(nodeId: string): Promise<boolean> {
    if (isDevPreview) return true
    const watchSeq = ++pairCompletionWatchSeqRef.current
    return waitForLanConfigSourceTrust({
      nodeId,
      loadStatus: () => invoke<Status>('get_status'),
      loadConfig: () => invoke<Config>('get_config'),
      applyStatus: (nextStatus) => {
        if (pairCompletionWatchSeqRef.current !== watchSeq) return
        setStatus(nextStatus)
        if (!overrideDirtyRef.current) setOverride(nextStatus.manual_override ?? '')
      },
      applyConfig: (nextConfig) => {
        if (pairCompletionWatchSeqRef.current !== watchSeq) return
        setConfig(nextConfig)
        setBaselineBaseUrls(
          Object.fromEntries(Object.entries(nextConfig.providers ?? {}).map(([name, provider]) => [name, provider.base_url])),
        )
      },
    })
  }
  async function approveLanPair(requestId: string): Promise<string | null> {
    try {
      const nodeId = config?.config_source?.sources.find((entry) => entry.pair_request_id === requestId)?.node_id ?? ''
      if (isDevPreview) {
        if (!nodeId) {
          flashToast('Pair request not found [TEST]', 'error')
          return null
        }
        setConfig((prev) => {
          if (!prev) return prev
          return updateDevPreviewPairState(prev, nodeId, (source) => ({
            ...source,
            trusted: false,
            pair_state: 'pin_required',
            pair_request_id: requestId,
            follow_allowed: false,
            follow_blocked_reason: 'pair this device before following its config',
          }))
        })
        return '123456'
      }
      const pinCode = await invoke<string>('approve_lan_pair', { requestId })
      await refreshConfig()
      if (nodeId) {
        void watchLanPairTrust(nodeId)
      }
      return pinCode
    } catch (e) {
      flashToast(String(e), 'error')
      return null
    }
  }
  async function submitLanPairPin(nodeId: string, requestId: string, pinCode: string) {
    if (isDevPreview) {
      setConfig((prev) => {
        if (!prev) return prev
        return updateDevPreviewPairState(prev, nodeId, (source) => ({
          ...source,
          trusted: true,
          pair_state: 'trusted',
          pair_request_id: null,
          follow_allowed: true,
          follow_blocked_reason: null,
        }))
      })
      return
    }
    await invoke('submit_lan_pair_pin', { nodeId, requestId, pinCode })
    await refreshConfig()
    await ensureLanConfigSourceTrust({
      nodeId,
      loadStatus: () => invoke<Status>('get_status'),
      loadConfig: () => invoke<Config>('get_config'),
      applyStatus: (nextStatus) => {
        setStatus(nextStatus)
        if (!overrideDirtyRef.current) setOverride(nextStatus.manual_override ?? '')
      },
      applyConfig: (nextConfig) => {
        setConfig(nextConfig)
        setBaselineBaseUrls(
          Object.fromEntries(Object.entries(nextConfig.providers ?? {}).map(([name, provider]) => [name, provider.base_url])),
        )
      },
    })
  }
  const [lanRemoteUpdatePendingByNode, setLanRemoteUpdatePendingByNode] = useState<
    Record<string, 'requesting'>
  >({})

  useEffect(() => {
    const sources = config?.config_source?.sources ?? []
    setLanRemoteUpdatePendingByNode((prev) => {
      let changed = false
      const next = { ...prev }
      for (const nodeId of Object.keys(prev)) {
        const source = sources.find((item) => item.node_id === nodeId && item.kind === 'peer')
        if (!source) continue
        if (source.remote_update_status?.state?.trim() || !source.version_sync_required) {
          delete next[nodeId]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [config])

  async function requestLanRemoteUpdateSameVersion(nodeId: string) {
    if (lanRemoteUpdatePendingByNode[nodeId]) return
    setLanRemoteUpdatePendingByNode((prev) => ({ ...prev, [nodeId]: 'requesting' }))
    try {
      if (isDevPreview) {
        flashToast(`Requested ${nodeId} to sync to this build [TEST]`)
        setLanRemoteUpdatePendingByNode((prev) => {
          const next = { ...prev }
          delete next[nodeId]
          return next
        })
        return
      }
      await invoke('request_lan_remote_update_same_version', { nodeId })
      flashToast('Peer version sync requested')
      await refreshStatus()
      await refreshConfig({ refreshProviderSwitchStatus: false, force: true })
    } catch (error) {
      setLanRemoteUpdatePendingByNode((prev) => {
        const next = { ...prev }
        delete next[nodeId]
        return next
      })
      flashToast(String(error), 'error')
    }
  }
  async function copyProviderFromConfigSource(sourceNodeId: string, sharedProviderId: string) {
    try {
      if (isDevPreview) {
        const activeConfig = config
        const localBase = devPreviewLocalConfigRef.current ?? activeConfig ?? devConfig
        if (!activeConfig) {
          flashToast('Borrowed provider not found [TEST]', 'error')
          return
        }
        const sourceProviders =
          devPreviewFollowSourceProvidersRef.current ?? getDevPreviewSourceProviders(sourceNodeId, localBase)
        const copied = copyDevPreviewBorrowedProvider({
          activeConfig,
          localBase,
          sourceNodeId,
          sharedProviderId,
          sourceProviders,
        })
        if (!copied) {
          flashToast('Borrowed provider not found [TEST]', 'error')
          return
        }
        devPreviewLocalConfigRef.current = copied.nextLocalConfig
        setConfig((prev) => {
          if (!prev || prev.config_source?.mode !== 'follow') return prev
          return copied.nextFollowConfig
        })
        flashToast(
          copied.localCopyState === 'linked'
            ? `Linked provider [TEST]: ${copied.targetName}`
            : `Copied provider [TEST]: ${copied.targetName}`,
        )
        return
      }
      const result = await invoke<CopyProviderResult>('copy_provider_from_config_source', {
        sourceNodeId,
        sharedProviderId,
      })
      setConfig((prev) => {
        if (!prev || prev.config_source?.mode !== 'follow') return prev
        return {
          ...prev,
          providers: Object.fromEntries(
            Object.entries(prev.providers).map(([name, provider]) => [
              name,
              provider.source_node_id === sourceNodeId && provider.shared_provider_id === sharedProviderId
                ? { ...provider, local_copy_state: result.local_copy_state }
                : provider,
            ]),
          ),
        }
      })
      flashToast(
        result.local_copy_state === 'linked'
          ? `Linked provider: ${result.target_name}`
          : `Copied provider: ${result.target_name}`,
      )
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }
  useAppPolling({
    activePage,
    isDevPreview,
    configModalOpen,
    codexSwapModalOpen,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
    runPrimaryRefresh,
    enqueueBackgroundRefresh,
    refreshStatus,
    refreshConfig,
    refreshProviderSwitchStatus,
    refreshGatewayTokenPreview,
    onDevPreviewBootstrap,
    onDevPreviewTick,
  })
  useEffect(() => {
    if (isDevPreview || !status) return
    const nextSignature = lanConfigSourceSyncSignature(status.lan_sync)
    const prevSignature = lastLanConfigSyncSignatureRef.current
    lastLanConfigSyncSignatureRef.current = nextSignature
    if (!prevSignature || prevSignature === nextSignature) return
    void refreshConfig({ refreshProviderSwitchStatus: false, force: true })
  }, [isDevPreview, refreshConfig, status])
  useEffect(() => {
    if (!isDevPreview) return
    devPreviewLocalConfigRef.current = null
    devPreviewFollowSourceProvidersRef.current = null
  }, [isDevPreview])
  useAppUsageEffects({
    activePage,
    usageRefreshRevision,
    enqueueBackgroundRefresh,
    refreshUsageOverview,
    refreshUsageStatistics,
    hasUsageOverview: usageOverview !== null,
    hasUsageStatistics: usageStatistics !== null,
    isDevPreview,
    refreshFxRatesDaily,
    usagePricingModalOpen,
    usagePricingDraftsPrimedRef,
    closeUsagePricingCurrencyMenu,
    clearAutoSaveTimersByPrefix,
    usagePricingLastSavedSigRef,
    setUsagePricingSaveState,
    config,
    usagePricingProviderNames,
    setUsagePricingDrafts,
    buildUsagePricingDraft,
    pricingDraftSignature,
    usageHistoryModalOpen,
    clearAutoSaveTimer,
    resetUsageHistoryScrollbarState,
    clearUsageHistoryScrollbarTimers,
    usageHistoryLoadedRef,
    usageHistoryQuotaRefreshToken,
    refreshUsageHistory,
    refreshUsageHistoryScrollbarUi,
    usageHistoryRows,
    scheduleUsageHistoryScrollbarSync,
    usagePricingCurrencyMenu,
    usagePricingCurrencyMenuRef,
    usageScheduleCurrencyMenu,
    usageScheduleCurrencyMenuRef,
    closeUsageScheduleCurrencyMenu,
    usageScheduleModalOpen,
    usageScheduleLoading,
    usageScheduleSaving,
    scheduleRowsSignature,
    usageScheduleRows,
    usageScheduleLastSavedSigRef,
    usageScheduleSaveState,
    setUsageScheduleSaveState,
    setUsageScheduleSaveError,
    queueAutoSaveTimer,
    autoSaveUsageScheduleRows,
  })
  const {
    renderProviderCard,
  } = useProviderPanelUi({
    setProviderPanelsOpen,
    setEditingProviderName,
    setProviderNameDrafts,
    providerNameDrafts,
    refreshConfig,
    refreshStatus,
    flashToast,
    registerProviderCardRef,
    dragOverProvider,
    dragOffsetY,
    dragBaseTop,
    onProviderHandlePointerDown,
    config,
    status,
    openProviderGroupManager,
    setProviderDisabled,
    deleteProvider,
    copyProviderFromConfigSource,
    openKeyModal,
    openProviderBaseUrlModal,
    clearKey,
    openUsageBaseModal,
    openUsageAuthModal,
    openProviderEmailModal,
    clearUsageBaseUrl,
    setProviderQuotaHardCap,
    editingProviderName,
  })
  const clearUsageScheduleRowsAutoSave = () => clearAutoSaveTimer('schedule:rows')
  const shouldRenderAppModals =
    keyModal.open ||
    providerBaseUrlModal.open ||
    usageBaseModal.open ||
    usageAuthModal.open ||
    providerEmailModal.open ||
    gatewayModalOpen ||
    configModalOpen ||
    rawConfigModalOpen ||
    instructionModalOpen ||
    codexSwapModalOpen ||
    usageHistoryModalOpen ||
    usagePricingModalOpen ||
    usageScheduleModalOpen

  const usageProps = useMemo(
    () => ({
      config,
      usageWindowHours,
      setUsageWindowHours,
      usageStatisticsLoading,
      usageFilterNodes,
      setUsageFilterNodes,
      usageNodeFilterOptions,
      toggleUsageNodeFilter,
      usageFilterProviders,
      setUsageFilterProviders,
      usageProviderFilterOptions,
      usageProviderFilterDisplayOptions,
      toggleUsageProviderFilterDisplayOption,
      usageFilterModels,
      setUsageFilterModels,
      usageModelFilterOptions,
      toggleUsageModelFilter,
      usageFilterOrigins,
      setUsageFilterOrigins,
      usageOriginFilterOptions,
      toggleUsageOriginFilter,
      usageAnomalies,
      usageSummary,
      formatKpiTokens,
      usageTopModel,
      formatUsdMaybe,
      usageDedupedTotalUsedUsd,
      usageTotalInputTokens,
      usageTotalOutputTokens,
      usageAvgTokensPerRequest,
      usageActiveWindowHours,
      usagePricedRequestCount,
      usagePricedCoveragePct,
      usageAvgRequestsPerHour,
      usageAvgTokensPerHour,
      usageWindowLabel,
      usageStatistics,
      usageChart,
      setUsageChartHover,
      showUsageChartHover,
      usageChartHover,
      formatUsageBucketLabel,
      setUsageHistoryModalOpen,
      setUsagePricingModalOpen,
      usageScheduleProviderOptions,
      usageByProvider,
      openUsageScheduleModal,
      providerPreferredCurrency,
      setUsageProviderShowDetails,
      usageProviderShowDetails,
      usageProviderShowDetailsStorageKey: USAGE_PROVIDER_SHOW_DETAILS_KEY,
      usageProviderDisplayGroups,
      usageProviderRowKey,
      formatPricingSource,
      usageProviderTotalsAndAverages,
      usageActivityUnixMs: status?.last_activity_unix_ms ?? null,
      clientSessions: status?.client_sessions ?? [],
    }),
    [
      config,
      usageWindowHours,
      usageStatisticsLoading,
      usageFilterNodes,
      usageNodeFilterOptions,
      toggleUsageNodeFilter,
      usageFilterProviders,
      usageProviderFilterOptions,
      usageProviderFilterDisplayOptions,
      toggleUsageProviderFilterDisplayOption,
      usageFilterModels,
      usageModelFilterOptions,
      toggleUsageModelFilter,
      usageFilterOrigins,
      usageOriginFilterOptions,
      toggleUsageOriginFilter,
      usageAnomalies,
      usageSummary,
      usageTopModel,
      usageDedupedTotalUsedUsd,
      usageTotalInputTokens,
      usageTotalOutputTokens,
      usageAvgTokensPerRequest,
      usageActiveWindowHours,
      usagePricedRequestCount,
      usagePricedCoveragePct,
      usageAvgRequestsPerHour,
      usageAvgTokensPerHour,
      usageWindowLabel,
      usageStatistics,
      usageChart,
      showUsageChartHover,
      usageChartHover,
      usageScheduleProviderOptions,
      usageByProvider,
      openUsageScheduleModal,
      providerPreferredCurrency,
      usageProviderShowDetails,
      usageProviderDisplayGroups,
      usageProviderRowKey,
      usageProviderTotalsAndAverages,
      status?.last_activity_unix_ms,
      status?.client_sessions,
    ],
  )

  const switchboardProps = useMemo(
    () => ({
      providerSwitchStatus,
      providerSwitchBusy,
      codexSwapDir1,
      codexSwapDir2,
      codexSwapUseWindows,
      codexSwapUseWsl,
      switchboardModeLabel,
      switchboardModelProviderLabel,
      switchboardTargetDirsLabel,
      switchboardProviderCards,
      onSetProviderSwitchTarget: setProviderSwitchTarget,
      onOpenConfigureDirs: () => setCodexSwapModalOpen(true),
      onOpenRawConfig: () => void openRawConfigModal(),
    }),
    [
      providerSwitchStatus,
      providerSwitchBusy,
      codexSwapDir1,
      codexSwapDir2,
      codexSwapUseWindows,
      codexSwapUseWsl,
      switchboardModeLabel,
      switchboardModelProviderLabel,
      switchboardTargetDirsLabel,
      switchboardProviderCards,
      setProviderSwitchTarget,
      openRawConfigModal,
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
            <AppTopNav
              activePage={activePage}
              onSwitchPage={switchPage}
              onOpenGettingStarted={() => setInstructionModalOpen(true)}
              onUsageStatisticsIntent={handleUsageStatisticsIntentPrefetch}
              onUsageRequestsIntent={handleUsageRequestsIntentPrefetch}
            />
          </div>
          {/* Surface errors via toast to avoid layout shifts. */}
          <div
            className={`aoMainArea${activePage === 'dashboard' ? '' : ' aoMainAreaFill'}${
              activePage === 'usage_requests' ? ' aoMainAreaRequestsFill' : ''
            }`}
            ref={mainAreaRef}
          >
            <AppMainContent
              activePage={activePage}
              status={status}
              config={config}
              providers={providers}
              gatewayTokenPreview={gatewayTokenPreview}
              onCopyToken={onCopyToken}
              onShowGatewayRotate={onShowGatewayRotate}
              onCodexLoginLogout={onCodexLoginLogout}
              onCodexRefresh={onCodexRefresh}
              codexRefreshing={codexRefreshing}
              onCodexSwapAuthConfig={onCodexSwapAuthConfig}
              onOpenCodexSwapOptions={onOpenCodexSwapOptions}
              codexSwapTarget={codexSwapTarget}
              codexSwapUseWindows={codexSwapUseWindows}
              codexSwapUseWsl={codexSwapUseWsl}
              onChangeCodexSwapTarget={setCodexSwapTarget}
              codexSwapBadgeText={codexSwapBadge.badgeText}
              codexSwapBadgeTitle={codexSwapBadge.badgeTitle}
              routeMode={routeMode}
              onRouteModeChange={setRouteMode}
              override={override}
              onOverrideChange={onOverrideChange}
              onPreferredChange={(next) => void setPreferred(next)}
              onOpenConfigModal={() => setConfigModalOpen(true)}
              refreshingProviders={refreshingProviders}
              onRefreshQuota={(name) => void refreshQuota(name)}
              clientSessions={clientSessions ?? []}
              updatingSessionPref={updatingSessionPref}
              onSetSessionPreferred={(sessionId, provider) => void setSessionPreferred(sessionId, provider)}
              onOpenLastErrorInEventLog={handleOpenLastErrorInEventLog}
              eventLogSeedEvents={eventLogSeedEvents}
              eventLogSeedDailyStats={eventLogPreloadDailyStats}
              eventLogFocusRequest={eventLogFocusRequest}
              onEventLogFocusRequestHandled={handleEventLogFocusRequestHandled}
              usageOverview={usageOverview}
              usageProps={usageProps}
              switchboardProps={switchboardProps}
            />
          </div>
        </div>
      </div>
      {shouldRenderAppModals ? (
        <Suspense fallback={null}>
          <AppModals
            keyModal={keyModal}
            setKeyModal={setKeyModal}
            saveKey={saveKey}
            providerBaseUrlModal={providerBaseUrlModal}
            setProviderBaseUrlModal={setProviderBaseUrlModal}
            saveProviderBaseUrl={saveProviderBaseUrl}
            providerEmailModal={providerEmailModal}
            setProviderEmailModal={setProviderEmailModal}
            saveProviderEmail={saveProviderEmail}
            clearProviderEmail={clearProviderEmail}
            usageAuthModal={usageAuthModal}
            setUsageAuthModal={setUsageAuthModal}
            saveUsageAuth={saveUsageAuth}
            clearUsageAuth={clearUsageAuth}
            usageBaseModal={usageBaseModal}
            setUsageBaseModal={setUsageBaseModal}
            saveUsageBaseUrl={saveUsageBaseUrl}
            instructionModalOpen={instructionModalOpen}
            setInstructionModalOpen={setInstructionModalOpen}
            openRawConfigModal={openRawConfigModal}
            configModalOpen={configModalOpen}
            config={config}
            newProviderName={newProviderName}
            newProviderBaseUrl={newProviderBaseUrl}
            newProviderKey={newProviderKey}
            newProviderKeyStorage={newProviderKeyStorage}
            nextProviderPlaceholder={nextProviderPlaceholder}
            setNewProviderName={setNewProviderName}
            setNewProviderBaseUrl={setNewProviderBaseUrl}
            setNewProviderKey={setNewProviderKey}
            setNewProviderKeyStorage={setNewProviderKeyStorage}
            addProvider={addProvider}
            followConfigSource={followConfigSource}
            clearFollowedConfigSource={clearFollowedConfigSource}
            requestLanPair={requestLanPair}
            approveLanPair={approveLanPair}
            submitLanPairPin={submitLanPairPin}
            requestLanRemoteUpdateSameVersion={requestLanRemoteUpdateSameVersion}
            lanRemoteUpdatePendingByNode={lanRemoteUpdatePendingByNode}
            openProviderGroupManager={openProviderGroupManager}
            setConfigModalOpen={setConfigModalOpen}
            rawConfigModalOpen={rawConfigModalOpen}
            rawConfigHomeOptions={rawConfigHomeOptions}
            rawConfigHomeLabels={rawConfigHomeLabels}
            rawConfigTexts={rawConfigTexts}
            rawConfigLoadingByHome={rawConfigLoadingByHome}
            rawConfigSavingByHome={rawConfigSavingByHome}
            rawConfigDirtyByHome={rawConfigDirtyByHome}
            rawConfigLoadedByHome={rawConfigLoadedByHome}
            rawConfigDraftByHome={rawConfigDraftByHome}
            onRawConfigTextChange={updateRawConfigText}
            saveRawConfigHome={saveRawConfigHome}
            retryRawConfigHome={loadRawConfigHome}
            setRawConfigModalOpen={setRawConfigModalOpen}
            providerListRef={providerListRef}
            orderedConfigProviders={orderedConfigProviders}
            dragPreviewOrder={dragPreviewOrder}
            draggingProvider={draggingProvider}
            dragCardHeight={dragCardHeight}
            renderProviderCard={renderProviderCard}
            gatewayModalOpen={gatewayModalOpen}
            gatewayTokenPreview={gatewayTokenPreview}
            gatewayTokenReveal={gatewayTokenReveal}
            setGatewayModalOpen={setGatewayModalOpen}
            setGatewayTokenReveal={setGatewayTokenReveal}
            setGatewayTokenPreview={setGatewayTokenPreview}
            flashToast={flashToast}
            usageHistoryModalOpen={usageHistoryModalOpen}
            setUsageHistoryModalOpen={setUsageHistoryModalOpen}
            usageHistoryLoading={usageHistoryLoading}
            usageHistoryRows={usageHistoryRows}
            setUsageHistoryRows={setUsageHistoryRows}
            usageHistoryDrafts={usageHistoryDrafts}
            usageHistoryEditCell={usageHistoryEditCell}
            setUsageHistoryDrafts={setUsageHistoryDrafts}
            setUsageHistoryEditCell={setUsageHistoryEditCell}
            historyDraftFromRow={historyDraftFromRow}
            historyPerReqDisplayValue={historyPerReqDisplayValue}
            historyEffectiveDisplayValue={historyEffectiveDisplayValue}
            formatUsdMaybe={formatUsdMaybe}
            fmtHistorySource={fmtHistorySource}
            queueUsageHistoryAutoSave={queueUsageHistoryAutoSave}
            clearAutoSaveTimer={clearAutoSaveTimer}
            saveUsageHistoryRow={saveUsageHistoryRow}
            refreshUsageHistory={refreshUsageHistory}
            refreshUsageStatistics={refreshUsageStatistics}
            usageHistoryTableSurfaceRef={usageHistoryTableSurfaceRef}
            usageHistoryTableWrapRef={usageHistoryTableWrapRef}
            usageHistoryScrollbarOverlayRef={usageHistoryScrollbarOverlayRef}
            usageHistoryScrollbarThumbRef={usageHistoryScrollbarThumbRef}
            scheduleUsageHistoryScrollbarSync={scheduleUsageHistoryScrollbarSync}
            activateUsageHistoryScrollbarUi={activateUsageHistoryScrollbarUi}
            onUsageHistoryScrollbarPointerDown={onUsageHistoryScrollbarPointerDown}
            onUsageHistoryScrollbarPointerMove={onUsageHistoryScrollbarPointerMove}
            onUsageHistoryScrollbarPointerUp={onUsageHistoryScrollbarPointerUp}
            onUsageHistoryScrollbarLostPointerCapture={onUsageHistoryScrollbarLostPointerCapture}
            usagePricingModalOpen={usagePricingModalOpen}
            setUsagePricingModalOpen={setUsagePricingModalOpen}
            fxRatesDate={fxRatesDate}
            usagePricingGroups={usagePricingGroups}
            usagePricingProviderNames={usagePricingProviderNames}
            usagePricingDrafts={usagePricingDrafts}
            usagePricingSaveState={usagePricingSaveState}
            setUsagePricingDrafts={setUsagePricingDrafts}
            buildUsagePricingDraft={buildUsagePricingDraft}
            queueUsagePricingAutoSaveForProviders={queueUsagePricingAutoSaveForProviders}
            setUsagePricingSaveStateForProviders={setUsagePricingSaveStateForProviders}
            saveUsagePricingForProviders={saveUsagePricingForProviders}
            openUsageScheduleModal={openUsageScheduleModal}
            providerPreferredCurrency={providerPreferredCurrency}
            pricingDraftSignature={pricingDraftSignature}
            usagePricingLastSavedSigRef={usagePricingLastSavedSigRef}
            usagePricingCurrencyMenu={usagePricingCurrencyMenu}
            setUsagePricingCurrencyMenu={setUsagePricingCurrencyMenu}
            usagePricingCurrencyQuery={usagePricingCurrencyQuery}
            setUsagePricingCurrencyQuery={setUsagePricingCurrencyQuery}
            usageCurrencyOptions={usageCurrencyOptions}
            normalizeCurrencyCode={normalizeCurrencyCode}
            currencyLabel={currencyLabel}
            usagePricingCurrencyMenuRef={usagePricingCurrencyMenuRef}
            updateUsagePricingCurrency={updateUsagePricingCurrency}
            closeUsagePricingCurrencyMenu={closeUsagePricingCurrencyMenu}
            usageScheduleModalOpen={usageScheduleModalOpen}
            usageScheduleLoading={usageScheduleLoading}
            usageScheduleRows={usageScheduleRows}
            providerDisplayName={providerDisplayName}
            providerApiKeyLabel={providerApiKeyLabel}
            usageScheduleCurrencyMenu={usageScheduleCurrencyMenu}
            setUsageScheduleCurrencyMenu={setUsageScheduleCurrencyMenu}
            usageScheduleCurrencyQuery={usageScheduleCurrencyQuery}
            setUsageScheduleCurrencyQuery={setUsageScheduleCurrencyQuery}
            setUsageScheduleSaveState={setUsageScheduleSaveState}
            setUsageScheduleRows={setUsageScheduleRows}
            usageScheduleProviderOptions={usageScheduleProviderOptions}
            usageScheduleProvider={usageScheduleProvider}
            parsePositiveAmount={parsePositiveAmount}
            fxRatesByCurrency={fxRatesByCurrency}
            convertCurrencyToUsd={convertCurrencyToUsd}
            linkedProvidersForApiKey={linkedProvidersForApiKey}
            newScheduleDraft={newScheduleDraft}
            usageScheduleSaveState={usageScheduleSaveState}
            usageScheduleSaveStatusText={usageScheduleSaveStatusText}
            usageScheduleCurrencyMenuRef={usageScheduleCurrencyMenuRef}
            updateUsageScheduleCurrency={updateUsageScheduleCurrency}
            closeUsageScheduleCurrencyMenu={closeUsageScheduleCurrencyMenu}
            clearUsageScheduleRowsAutoSave={clearUsageScheduleRowsAutoSave}
            setUsageScheduleSaveError={setUsageScheduleSaveError}
            setUsageScheduleModalOpen={setUsageScheduleModalOpen}
            isDevPreview={isDevPreview}
            listenPort={status?.listen.port}
            codexSwapModalOpen={codexSwapModalOpen}
            codexSwapDir1={codexSwapDir1}
            codexSwapDir2={codexSwapDir2}
            codexSwapUseWindows={codexSwapUseWindows}
            codexSwapUseWsl={codexSwapUseWsl}
            setCodexSwapDir1={setCodexSwapDir1}
            setCodexSwapDir2={setCodexSwapDir2}
            setCodexSwapUseWindows={setCodexSwapUseWindows}
            setCodexSwapUseWsl={setCodexSwapUseWsl}
            setCodexSwapModalOpen={setCodexSwapModalOpen}
            toggleCodexSwap={toggleCodexSwap}
            resolveCliHomes={resolveCliHomes}
          />
        </Suspense>
      ) : null}
      {providerGroupManagerOpen ? (
        <Suspense fallback={null}>
          <ProviderGroupManagerModal
            open={providerGroupManagerOpen}
            config={config}
            status={status}
            orderedConfigProviders={orderedConfigProviders}
            focusProvider={providerGroupManagerFocusProvider}
            onClose={() => {
              setProviderGroupManagerOpen(false)
              setProviderGroupManagerFocusProvider(null)
            }}
            onAssignGroup={setProvidersGroup}
            onSetUsageBase={setUsageBaseUrl}
            onClearUsageBase={clearUsageBaseUrl}
            onClearUsageAuth={clearUsageAuth}
            onSetHardCap={setProviderQuotaHardCap}
            onOpenProviderEmailModal={openProviderEmailModal}
            onOpenUsageAuthModal={openUsageAuthModal}
          />
        </Suspense>
      ) : null}
    </div>
  )
}
