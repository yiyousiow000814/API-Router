import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'
import type { CodexSwapStatus, Config, ProviderSwitchboardStatus, SpendHistoryRow, Status, UsageStatistics } from './types'
import { fmtWhen } from './utils/format'
import { normalizePathForCompare } from './utils/path'
import { resolveCliHomes } from './utils/cliHomes'
import { AppLayout } from './components/AppLayout'
import { UsageHistoryColGroup } from './components/UsageHistoryColGroup'
import { useReorderDrag } from './hooks/useReorderDrag'
import { useUsageHistoryScrollbar } from './hooks/useUsageHistoryScrollbar'
import { useAppEffects } from './hooks/useAppEffects'
import { useGatewayActions } from './hooks/useGatewayActions'
import { useAppBackendActions } from './hooks/useAppBackendActions'
import { useProviderCards } from './hooks/useProviderCards'
import { useUsageHistoryActions } from './hooks/useUsageHistoryActions'
import { useUsagePricingScheduleActions } from './hooks/useUsagePricingScheduleActions'
import { useUsageFilters } from './hooks/useUsageFilters'
import { useClearErrors } from './hooks/useClearErrors'
import { useSwitchboardView } from './hooks/useSwitchboardView'
import { useAppDerivedState } from './hooks/useAppDerivedState'
import { useUsageViewModel, type UsageChartHover } from './hooks/useUsageViewModel'
import { buildDevMockHistoryRows, parseDevFlag } from './utils/devMockHistory'
import { devConfig, devStatus } from './utils/devPreviewState'
import type {
  ProviderScheduleDraft,
  UsagePricingDraft,
  UsagePricingSaveState,
  UsageScheduleSaveState,
} from './appTypes'
import {
  fmtHistorySource,
  historyDraftFromRow,
  historyEffectiveDisplayValue,
  historyPerReqDisplayValue,
  type UsageHistoryDraft,
} from './utils/usageHistory'
import {
  convertCurrencyToUsd as convertCurrencyToUsdWithRates,
  convertUsdToCurrency as convertUsdToCurrencyWithRates,
  currencyLabel,
  formatDraftAmount,
  normalizeCurrencyCode,
  parsePositiveAmount,
  parseScheduleRowsForSaveWithResolver,
  scheduleDraftFromPeriod as buildScheduleDraftFromPeriod,
  scheduleRowsSignature,
  scheduleSignaturesByProvider,
  newScheduleDraft as buildNewScheduleDraft,
} from './utils/pricingHelpers'
import {
  persistPreferredCurrency as persistPreferredCurrencyUtil,
  readPreferredCurrency as readPreferredCurrencyUtil,
} from './utils/currencyPrefs'
type TopPage = 'dashboard' | 'usage_statistics' | 'provider_switchboard'
const FX_RATES_CACHE_KEY = 'ao.fx.usd.daily.v1'
const FX_CURRENCY_PREF_KEY_PREFIX = 'ao.usagePricing.currency.'
const USAGE_PROVIDER_SHOW_DETAILS_KEY = 'ao.usage.provider.showDetails.v1'
export default function App() {
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
  const devMockHistoryEnabled = useMemo(() => parseDevFlag(devFlags.get('mockHistory')), [devFlags])
  const devAutoOpenHistory = useMemo(() => parseDevFlag(devFlags.get('openHistory')), [devFlags])
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
  useEffect(() => {
    if (!devAutoOpenHistory) return
    setUsageHistoryModalOpen(true)
  }, [devAutoOpenHistory])
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
  const [fxRatesByCurrency, setFxRatesByCurrency] = useState<Record<string, number>>({ USD: 1 })
  const [fxRatesDate, setFxRatesDate] = useState<string>('')
  const [usageChartHover, setUsageChartHover] = useState<UsageChartHover | null>(null)
  const [updatingSessionPref, setUpdatingSessionPref] = useState<Record<string, boolean>>({})
  const usageRefreshTimerRef = useRef<number | null>(null)
  const idleUsageSchedulerRef = useRef<(() => void) | null>(null)
  const usageActiveRef = useRef<boolean>(false)
  const activeUsageTimerRef = useRef<number | null>(null)
  const providerSwitchRefreshTimerRef = useRef<number | null>(null)
  const providerSwitchDirWatcherPrimedRef = useRef<boolean>(false)
  const usagePricingDraftsPrimedRef = useRef<boolean>(false)
  const usageHistoryLoadedRef = useRef<boolean>(false)
  const usageHistoryScrollbar = useUsageHistoryScrollbar()
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
  const clearErrors = useClearErrors(status, setClearErrorsBeforeMs)
  const {
    providers,
    visibleEvents,
    canClearErrors,
    clientSessions,
    orderedConfigProviders,
    nextProviderPlaceholder,
    codexSwapBadge,
  } = useAppDerivedState({
    status,
    config,
    clearErrorsBeforeMs,
    codexSwapStatus,
    providerSwitchStatus,
  })
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
  const backendActions = useAppBackendActions({
    isDevPreview,
    usageWindowHours,
    usageFilterProviders,
    usageFilterModels,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapApplyBoth,
    codexSwapDir1Ref,
    codexSwapDir2Ref,
    codexSwapApplyBothRef,
    overrideDirtyRef,
    status,
    setStatus,
    setConfig,
    setBaselineBaseUrls,
    setGatewayTokenPreview,
    setOverride,
    setCodexSwapStatus,
    setProviderSwitchStatus,
    setProviderSwitchBusy,
    setUsageStatistics,
    setUsageStatisticsLoading,
    setUpdatingSessionPref,
    flashToast,
    resolveCliHomes,
    devConfig,
    devStatus,
  })
  const setProviderSwitchTarget = backendActions.setProviderSwitchTarget, refreshStatus = backendActions.refreshStatus, refreshConfig = backendActions.refreshConfig
  const setSessionPreferred = useCallback(
    async (sessionId: string, provider: string | null) => {
      await backendActions.setSessionPreferred(sessionId, provider)
    },
    [backendActions],
  )
  const toggleCodexSwap = backendActions.toggleCodexSwap
  const refreshProviderSwitchStatus = backendActions.refreshProviderSwitchStatus
  const refreshUsageStatistics = backendActions.refreshUsageStatistics
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
  function readPreferredCurrency(providerName: string, apiKeyRef?: string): string {
    return readPreferredCurrencyUtil(FX_CURRENCY_PREF_KEY_PREFIX, providerName, apiKeyRef, providerApiKeyLabel)
  }
  function persistPreferredCurrency(
    providerNames: string[],
    currency: string,
    options?: { apiKeyRef?: string },
  ) {
    persistPreferredCurrencyUtil(FX_CURRENCY_PREF_KEY_PREFIX, providerNames, currency, options, providerApiKeyLabel)
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
  function convertUsdToCurrency(usdAmount: number, currency: string): number {
    return convertUsdToCurrencyWithRates(fxRatesByCurrency, usdAmount, currency)
  }
  function convertCurrencyToUsd(amount: number, currency: string): number {
    return convertCurrencyToUsdWithRates(fxRatesByCurrency, amount, currency)
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
  const usageHistoryTableWrapRef = usageHistoryScrollbar.tableWrapRef
  const usageHistoryTableSurfaceRef = usageHistoryScrollbar.tableSurfaceRef
  const usageHistoryScrollbarOverlayRef = usageHistoryScrollbar.scrollbarOverlayRef
  const usageHistoryScrollbarThumbRef = usageHistoryScrollbar.scrollbarThumbRef
  const scheduleUsageHistoryScrollbarSync = usageHistoryScrollbar.scheduleSync
  const activateUsageHistoryScrollbarUi = usageHistoryScrollbar.activateUi
  const onUsageHistoryScrollbarPointerDown = usageHistoryScrollbar.onPointerDown
  const onUsageHistoryScrollbarPointerMove = usageHistoryScrollbar.onPointerMove
  const onUsageHistoryScrollbarPointerUp = usageHistoryScrollbar.onPointerUp
  const onUsageHistoryScrollbarLostPointerCapture = usageHistoryScrollbar.onLostPointerCapture
  const renderUsageHistoryColGroup = useCallback(() => <UsageHistoryColGroup />, [])
  const closeUsagePricingCurrencyMenu = useCallback(() => {
    setUsagePricingCurrencyMenu(null)
    setUsagePricingCurrencyQuery('')
  }, [])
  const {
    refreshUsageHistory,
    saveUsageHistoryRow,
    queueUsageHistoryAutoSave,
  } = useUsageHistoryActions({
    isDevPreview,
    devMockHistoryEnabled,
    usageHistoryModalOpen,
    usageHistoryDrafts,
    usageHistoryLoadedRef,
    setUsageHistoryRows,
    setUsageHistoryDrafts,
    setUsageHistoryEditCell,
    setUsageHistoryLoading,
    queueAutoSaveTimer,
    formatDraftAmount,
    historyDraftFromRow,
    historyEffectiveDisplayValue,
    historyPerReqDisplayValue,
    parsePositiveAmount,
    buildDevMockHistoryRows,
    refreshUsageStatistics,
    flashToast,
  })
  const {
    pricingDraftSignature,
    buildUsagePricingDraft,
    refreshFxRatesDaily,
    openUsageScheduleModal,
    setUsagePricingSaveStateForProviders,
    autoSaveUsageScheduleRows,
    saveUsagePricingForProviders,
    queueUsagePricingAutoSaveForProviders,
  } = useUsagePricingScheduleActions({
    FX_RATES_CACHE_KEY,
    isDevPreview,
    config,
    fxRatesByCurrency,
    usagePricingModalOpen,
    usageScheduleModalOpen,
    usageHistoryModalOpen,
    usageScheduleProviderOptions: Object.keys(config?.providers ?? {}).filter((name) => name !== 'official'),
    usagePricingDrafts,
    usagePricingLastSavedSigRef,
    usageScheduleLastSavedSigRef,
    usageScheduleLastSavedByProviderRef,
    setFxRatesByCurrency,
    setFxRatesDate,
    setUsageScheduleProvider,
    setUsageScheduleModalOpen,
    setUsageScheduleLoading,
    setUsageScheduleRows,
    setUsageScheduleSaving,
    setUsageScheduleSaveState,
    setUsageScheduleSaveError,
    setUsagePricingSaveState,
    clearAutoSaveTimer,
    queueAutoSaveTimer,
    closeUsagePricingCurrencyMenu,
    closeUsageScheduleCurrencyMenu,
    refreshConfig,
    refreshUsageStatistics,
    refreshUsageHistory,
    flashToast,
    normalizeCurrencyCode,
    readPreferredCurrency,
    providerPreferredCurrency,
    providerApiKeyLabel,
    linkedProvidersForApiKey: (apiKeyRef: string, fallbackProvider: string) => {
      const key = apiKeyRef.trim()
      if (!key || key === '-' || key === 'set') return [fallbackProvider]
      const providers = Object.keys(config?.providers ?? {})
        .filter((name) => name !== 'official')
        .filter((name) => providerApiKeyLabel(name).trim() === key)
      const unique = Array.from(new Set([...providers, fallbackProvider].filter(Boolean)))
      return unique.length ? unique : [fallbackProvider]
    },
    convertUsdToCurrency,
    convertCurrencyToUsd,
    formatDraftAmount,
    buildScheduleDraftFromPeriod,
    scheduleRowsSignature,
    scheduleSignaturesByProvider,
    parseScheduleRowsForSaveWithResolver,
  })
  const {
    managedProviderNames,
    providerDisplayName,
    linkedProvidersForApiKey,
    switchboardProviderCards,
    switchboardModeLabel,
    switchboardModelProviderLabel,
    switchboardTargetDirsLabel,
  } = useSwitchboardView({
    config,
    status,
    orderedConfigProviders,
    providerSwitchStatus,
    providerApiKeyLabel,
  })
  const {
    usageSummary,
    usageByProvider,
    usageTopModel,
    usageProviderFilterOptions,
    usageModelFilterOptions,
    usageProviderRowKey,
    usageProviderDisplayGroups,
    usageDedupedTotalUsedUsd,
    usageTotalInputTokens,
    usageTotalOutputTokens,
    usageAvgTokensPerRequest,
    usagePricedRequestCount,
    usagePricedCoveragePct,
    usageActiveWindowHours,
    usageAvgRequestsPerHour,
    usageAvgTokensPerHour,
    usageWindowLabel,
    usageProviderTotalsAndAverages,
    usagePricingProviderNames,
    usagePricingGroups,
    usageScheduleProviderOptions,
    usageAnomalies,
    usageChart,
    fmtUsdMaybe,
    fmtKpiTokens,
    fmtPricingSource,
    fmtUsageBucketLabel,
    showUsageChartHover,
  } = useUsageViewModel({
    usageStatistics,
    usageWindowHours,
    managedProviderNames,
    providerApiKeyLabel,
    configProviders: config?.providers ?? {},
    setUsageChartHover,
  })
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
  const { toggleUsageProviderFilter, toggleUsageModelFilter } = useUsageFilters({
    usageProviderFilterOptions,
    usageModelFilterOptions,
    setUsageFilterProviders,
    setUsageFilterModels,
  })
  const {
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
  } = useGatewayActions({
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
  })
  useAppEffects({
    isDevPreview,
    activePage,
    statusLastActivityUnixMs: status?.last_activity_unix_ms,
    usageWindowHours,
    usageFilterProviders,
    usageFilterModels,
    usagePricingModalOpen,
    usagePricingProviderNames,
    usageHistoryModalOpen,
    usageScheduleCurrencyMenu,
    usagePricingCurrencyMenu,
    usageScheduleModalOpen,
    usageScheduleLoading,
    usageScheduleSaving,
    usageScheduleRows,
    usageScheduleSaveState,
    config,
    setStatus,
    setConfig,
    setBaselineBaseUrls,
    setGatewayTokenPreview,
    refreshProviderSwitchStatus,
    refreshStatus,
    refreshConfig,
    refreshQuotaAll,
    usageActiveRef,
    usageRefreshTimerRef,
    idleUsageSchedulerRef,
    activeUsageTimerRef,
    providerSwitchDirWatcherPrimedRef,
    providerSwitchRefreshTimerRef,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapApplyBoth,
    refreshUsageStatistics,
    refreshFxRatesDaily,
    usagePricingDraftsPrimedRef,
    closeUsagePricingCurrencyMenu,
    clearAutoSaveTimersByPrefix,
    usagePricingLastSavedSigRef,
    setUsagePricingSaveState,
    setUsagePricingDrafts,
    buildUsagePricingDraft,
    pricingDraftSignature,
    usageHistoryLoadedRef,
    clearAutoSaveTimer,
    usageHistoryScrollbar,
    refreshUsageHistory,
    usageHistoryRows,
    usagePricingCurrencyMenuRef,
    closeUsageScheduleCurrencyMenu,
    usageScheduleCurrencyMenuRef,
    usageScheduleLastSavedSigRef,
    setUsageScheduleSaveState,
    setUsageScheduleSaveError,
    queueAutoSaveTimer,
    autoSaveUsageScheduleRows,
    scheduleRowsSignature,
  })
  const {
    setAllProviderPanels,
    allProviderPanelsOpen,
    renderProviderCard,
  } = useProviderCards({
    config,
    status,
    orderedConfigProviders,
    providerPanelsOpen,
    setProviderPanelsOpen,
    editingProviderName,
    setEditingProviderName,
    providerNameDrafts,
    setProviderNameDrafts,
    baselineBaseUrls,
    dragOverProvider,
    dragBaseTop,
    dragOffsetY,
    registerProviderCardRef,
    onProviderHandlePointerDown,
    saveProvider,
    openKeyModal,
    clearKey,
    deleteProvider,
    setConfig,
    openUsageBaseModal,
    clearUsageBaseUrl,
    refreshStatus,
    refreshConfig,
    flashToast,
  })
  return <AppLayout {...{
    containerRef, contentRef, mainAreaRef, toast, activePage, switchPage, setInstructionModalOpen, usageWindowHours, usageStatisticsLoading, usageFilterProviders, usageProviderFilterOptions, usageFilterModels, usageModelFilterOptions, usageAnomalies, usageSummary, usageTopModel, usageDedupedTotalUsedUsd, usageTotalInputTokens, usageTotalOutputTokens, usageAvgTokensPerRequest, usageActiveWindowHours, usagePricedRequestCount, usagePricedCoveragePct, usageAvgRequestsPerHour, usageAvgTokensPerHour, usageWindowLabel, usageStatistics, setUsageWindowHours, setUsageFilterProviders, toggleUsageProviderFilter, setUsageFilterModels, toggleUsageModelFilter, fmtKpiTokens, fmtUsdMaybe, fmtWhen, usageChart, usageChartHover, setUsageChartHover, showUsageChartHover, fmtUsageBucketLabel, usageByProvider, usageProviderDisplayGroups, usageProviderShowDetails, usageProviderTotalsAndAverages, usageScheduleProviderOptions, config, openUsageScheduleModal, providerPreferredCurrency, setUsageProviderShowDetails, usageProviderRowKey, fmtPricingSource, setUsageHistoryModalOpen, setUsagePricingModalOpen, switchboardModeLabel, switchboardModelProviderLabel, switchboardTargetDirsLabel, providerSwitchStatus, providerSwitchBusy, switchboardProviderCards, setProviderSwitchTarget, codexSwapModalOpen, setCodexSwapModalOpen, status, providers, gatewayTokenPreview, codexRefreshing, override, refreshingProviders, clientSessions, updatingSessionPref, visibleEvents, canClearErrors, codexSwapBadge, flashToast, setGatewayModalOpen, setGatewayTokenReveal, refreshStatus, setCodexRefreshing, resolveCliHomes, codexSwapDir1, codexSwapDir2, codexSwapApplyBoth, toggleCodexSwap, setOverride, overrideDirtyRef, applyOverride, setPreferred, refreshQuota, setSessionPreferred, clearErrors, setConfigModalOpen, keyModal, usageBaseModal, instructionModalOpen, configModalOpen, gatewayModalOpen, gatewayTokenReveal, allProviderPanelsOpen, newProviderName, newProviderBaseUrl, nextProviderPlaceholder, providerListRef, orderedConfigProviders, dragPreviewOrder, draggingProvider, dragCardHeight, setKeyModal, setUsageBaseModal, setAllProviderPanels, setNewProviderName, setNewProviderBaseUrl, saveKey, clearUsageBaseUrl, saveUsageBaseUrl, addProvider, renderProviderCard, setGatewayTokenPreview, usageHistoryModalOpen, usageHistoryLoading, usageHistoryRows, usageHistoryTableSurfaceRef, usageHistoryTableWrapRef, usageHistoryScrollbarOverlayRef, usageHistoryScrollbarThumbRef, renderUsageHistoryColGroup, scheduleUsageHistoryScrollbarSync, activateUsageHistoryScrollbarUi, usageHistoryDrafts, usageHistoryEditCell, setUsageHistoryEditCell, setUsageHistoryDrafts, historyDraftFromRow, formatDraftAmount, historyPerReqDisplayValue, historyEffectiveDisplayValue, queueUsageHistoryAutoSave, clearAutoSaveTimer, saveUsageHistoryRow, refreshUsageHistory, refreshUsageStatistics, fmtHistorySource, onUsageHistoryScrollbarPointerDown, onUsageHistoryScrollbarPointerMove, onUsageHistoryScrollbarPointerUp, onUsageHistoryScrollbarLostPointerCapture, usagePricingModalOpen, fxRatesDate, usagePricingGroups, usagePricingDrafts, usagePricingSaveState, usagePricingProviderNames, usagePricingCurrencyMenu, usagePricingCurrencyQuery, usageCurrencyOptions, usagePricingCurrencyMenuRef, usagePricingLastSavedSigRef, setUsagePricingCurrencyMenu, setUsagePricingCurrencyQuery, setUsagePricingDrafts, setUsagePricingSaveStateForProviders, buildUsagePricingDraft, queueUsagePricingAutoSaveForProviders, saveUsagePricingForProviders, pricingDraftSignature, normalizeCurrencyCode, currencyLabel, updateUsagePricingCurrency, closeUsagePricingCurrencyMenu, usageScheduleModalOpen, usageScheduleLoading, usageScheduleRows, usageScheduleProvider, usageScheduleSaveState, usageScheduleSaveStatusText, usageScheduleCurrencyMenu, usageScheduleCurrencyMenuRef, usageScheduleCurrencyQuery, setUsageScheduleCurrencyQuery, setUsageScheduleRows, setUsageScheduleSaveState, setUsageScheduleSaveError, closeUsageScheduleCurrencyMenu, setUsageScheduleModalOpen, providerDisplayName, providerApiKeyLabel, updateUsageScheduleCurrency, setUsageScheduleCurrencyMenu, parsePositiveAmount, convertCurrencyToUsd, linkedProvidersForApiKey, buildNewScheduleDraft, readPreferredCurrency, fxRatesByCurrency, setCodexSwapDir1, setCodexSwapDir2, setCodexSwapApplyBoth, normalizePathForCompare,
  }} />
}
