import { useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'
import './components/AppShared.css'
import type { CodexSwapStatus, Config, ProviderSwitchboardStatus, Status, UsageStatistics } from './types'
import { fmtAmount, fmtPct, fmtUsd, pctOf } from './utils/format'
import {
  fmtKpiTokens as formatKpiTokens,
  fmtPricingSource as formatPricingSource,
  fmtUsdMaybe as formatUsdMaybe,
  fmtUsageBucketLabel as formatUsageBucketLabel,
} from './utils/usageDisplay'
import { devConfig, devStatus, parseDevFlag, type SpendHistoryRow } from './devMockData'
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
import { AppMainContent } from './components/AppMainContent'
import { AppModals } from './components/AppModals'
import { AppTopNav } from './components/AppTopNav'
import { useConfigDrag } from './hooks/useConfigDrag'
import { useProviderActions } from './hooks/useProviderActions'
import { useUsageHistoryScrollbar } from './hooks/useUsageHistoryScrollbar'
import { useAppPolling } from './hooks/useAppPolling'
import { useAppPrefs } from './hooks/useAppPrefs'
import { useSwitchboardStatusActions } from './hooks/useSwitchboardStatusActions'
import { useStatusDerivations } from './hooks/useStatusDerivations'
import { usePageScroll } from './hooks/usePageScroll'
import { useAppUsageEffects } from './hooks/useAppUsageEffects'
import { useDashboardDerivations } from './hooks/useDashboardDerivations'
import { useProviderPanelUi } from './hooks/useProviderPanelUi'
import { useAppActions } from './hooks/useAppActions'
import { useUsageOpsBridge } from './hooks/useUsageOpsBridge'
import { useUsageUiDerived } from './hooks/useUsageUiDerived'
import { useMainContentCallbacks } from './hooks/useMainContentCallbacks'
import {
  buildCodexSwapBadge,
  resolveConfigEditorHomes,
  resolveCliHomes,
} from './utils/switchboard'
import { usageProviderRowKey } from './utils/usageStatisticsView'
type TopPage = 'dashboard' | 'usage_statistics' | 'provider_switchboard'
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
  const rawConfigTestMode = useMemo(() => parseDevFlag(devFlags.get('test')), [devFlags])
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
  const [rawConfigModalOpen, setRawConfigModalOpen] = useState<boolean>(false)
  const [rawConfigTexts, setRawConfigTexts] = useState<Record<string, string>>({})
  const [rawConfigLoadingByHome, setRawConfigLoadingByHome] = useState<Record<string, boolean>>({})
  const [rawConfigSavingByHome, setRawConfigSavingByHome] = useState<Record<string, boolean>>({})
  const [rawConfigDirtyByHome, setRawConfigDirtyByHome] = useState<Record<string, boolean>>({})
  const [rawConfigLoadedByHome, setRawConfigLoadedByHome] = useState<Record<string, boolean>>({})
  const [rawConfigHomeOptions, setRawConfigHomeOptions] = useState<string[]>([])
  const [rawConfigHomeLabels, setRawConfigHomeLabels] = useState<Record<string, string>>({})
  const [instructionModalOpen, setInstructionModalOpen] = useState<boolean>(false)
  const [codexSwapModalOpen, setCodexSwapModalOpen] = useState<boolean>(false)
  const [codexSwapDir1, setCodexSwapDir1] = useState<string>('')
  const [codexSwapDir2, setCodexSwapDir2] = useState<string>('')
  const [codexSwapUseWindows, setCodexSwapUseWindows] = useState<boolean>(false)
  const [codexSwapUseWsl, setCodexSwapUseWsl] = useState<boolean>(false)
  const [codexSwapStatus, setCodexSwapStatus] = useState<CodexSwapStatus | null>(null)
  const [editingProviderName, setEditingProviderName] = useState<string | null>(null)
  const [providerNameDrafts, setProviderNameDrafts] = useState<Record<string, string>>({})
  const [refreshingProviders, setRefreshingProviders] = useState<Record<string, boolean>>({})
  const [codexRefreshing, setCodexRefreshing] = useState<boolean>(false)
  const [activePage, setActivePage] = useState<TopPage>('dashboard')
  const [providerSwitchStatus, setProviderSwitchStatus] = useState<ProviderSwitchboardStatus | null>(null)
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
  const { switchPage } = usePageScroll({ containerRef, mainAreaRef, activePage, setActivePage: (next) => setActivePage(next as TopPage) })
  useAppPrefs({
    isDevPreview,
    devAutoOpenHistory,
    setUsageHistoryModalOpen,
    autoSaveTimersRef,
    setProviderPanelsOpen,
    providerPanelsOpen,
    clearErrorsBeforeMs,
    setClearErrorsBeforeMs,
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
  const { providers, visibleEvents, canClearErrors, clearErrors, clientSessions } = useStatusDerivations({
    status,
    config,
    clearErrorsBeforeMs,
    setClearErrorsBeforeMs,
  })
  function flashToast(msg: string, kind: 'info' | 'error' = 'info') {
    setToast(msg)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    const ms = kind === 'error' ? 5200 : 2400
    toastTimerRef.current = window.setTimeout(() => setToast(''), ms)
  }

  async function loadRawConfigHome(home: string) {
    const target = home.trim()
    if (!target) return
    setRawConfigLoadingByHome((prev) => ({ ...prev, [target]: true }))
    try {
      if (rawConfigTestMode || isDevPreview) {
        if (rawConfigTestMode || isDevPreview) {
          const lower = target.toLowerCase()
          const shouldFailOnce = (lower.includes('\\wsl.localhost\\') || lower.includes('\\wsl$\\')) && !rawConfigTestFailOnceRef.current[target]
          if (shouldFailOnce) {
            rawConfigTestFailOnceRef.current[target] = true
            setRawConfigTexts((prev) => ({ ...prev, [target]: '' }))
            setRawConfigDirtyByHome((prev) => ({ ...prev, [target]: false }))
            setRawConfigLoadedByHome((prev) => ({ ...prev, [target]: false }))
            flashToast('[TEST] Simulated load failure for WSL2 target.', 'error')
            return
          }
        }
        const mockToml = Array.from({ length: 64 }, (_, idx) => {
          const n = String(idx + 1).padStart(2, '0')
          return `# [TEST] sample line ${n}\nmodel_provider = "api_router"\n`
        }).join('\n')
        setRawConfigTexts((prev) => ({
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
      setRawConfigTexts((prev) => ({ ...prev, [target]: txt }))
      setRawConfigDirtyByHome((prev) => ({ ...prev, [target]: false }))
      setRawConfigLoadedByHome((prev) => ({ ...prev, [target]: true }))
    } catch (e) {
      setRawConfigTexts((prev) => ({ ...prev, [target]: '' }))
      setRawConfigLoadedByHome((prev) => ({ ...prev, [target]: false }))
      flashToast(String(e), 'error')
    } finally {
      setRawConfigLoadingByHome((prev) => ({ ...prev, [target]: false }))
    }
  }

  async function openRawConfigModal(options?: { reopenGettingStartedOnFail?: boolean }) {
    const reopenGettingStartedOnFail = Boolean(options?.reopenGettingStartedOnFail)
    if (rawConfigTestMode || isDevPreview) {
      const mockWindowsHome = 'C:\\Users\\<user>\\.codex'
      const mockWslHome = '\\\\wsl.localhost\\Ubuntu\\home\\<user>\\.codex'
      setRawConfigHomeOptions([mockWindowsHome, mockWslHome])
      setRawConfigHomeLabels({
        [mockWindowsHome]: `Windows: ${mockWindowsHome}`,
        [mockWslHome]: `WSL2: ${mockWslHome}`,
      })
      const homeOptions = [mockWindowsHome, mockWslHome]
      setRawConfigTexts(Object.fromEntries(homeOptions.map((home) => [home, ''])))
      setRawConfigDirtyByHome({})
      setRawConfigLoadedByHome({})
      setRawConfigSavingByHome({})
      setRawConfigLoadingByHome({})
      rawConfigTestFailOnceRef.current = {}
      setRawConfigModalOpen(true)
      await Promise.all(homeOptions.map((home) => loadRawConfigHome(home)))
      return
    }
    try {
      const homes = resolveConfigEditorHomes(codexSwapDir1, codexSwapDir2)
      let homeOptions = homes
      if (!homeOptions.length) {
        const defaultHome = await invoke<string>('codex_cli_default_home')
        homeOptions = [defaultHome]
      }
      const labels: Record<string, string> = {}
      if (homeOptions.length > 1) {
        homeOptions.forEach((home) => {
          const lower = home.toLowerCase()
          const isWsl = lower.startsWith('\\\\wsl.localhost\\') || lower.startsWith('\\\\wsl$\\')
          const kind = isWsl ? 'WSL2' : 'Windows'
          labels[home] = `${kind}: ${home}`
        })
      }
      setRawConfigHomeOptions(homeOptions)
      setRawConfigHomeLabels(labels)
      setRawConfigTexts(Object.fromEntries(homeOptions.map((home) => [home, ''])))
      setRawConfigDirtyByHome({})
      setRawConfigLoadedByHome({})
      setRawConfigSavingByHome({})
      setRawConfigLoadingByHome({})
      setRawConfigModalOpen(true)
      await Promise.all(homeOptions.map((home) => loadRawConfigHome(home)))
    } catch (e) {
      const msg = String(e)
      flashToast(msg, 'error')
      if (reopenGettingStartedOnFail) setInstructionModalOpen(true)
    }
  }

  function updateRawConfigText(home: string, next: string) {
    setRawConfigTexts((prev) => ({ ...prev, [home]: next }))
    setRawConfigDirtyByHome((prev) => ({ ...prev, [home]: true }))
  }

  async function saveRawConfigHome(home: string) {
    const target = home.trim()
    if (!target) return
    if (rawConfigSavingByHome[target]) return
    if (!rawConfigLoadedByHome[target]) return
    if (rawConfigTestMode || isDevPreview) {
      setRawConfigDirtyByHome((prev) => ({ ...prev, [target]: false }))
      flashToast('[TEST] Saved in sandbox only (no real files changed).')
      return
    }
    setRawConfigSavingByHome((prev) => ({ ...prev, [target]: true }))
    try {
      await invoke('set_codex_cli_config_toml', {
        cliHome: target,
        tomlText: rawConfigTexts[target] ?? '',
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
    refreshStatus,
    refreshConfig,
    setProviderSwitchTarget,
  } = useSwitchboardStatusActions({
    isDevPreview,
    devStatus,
    devConfig,
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
    setCodexSwapStatus,
    providerSwitchStatus,
    setProviderSwitchStatus,
    flashToast,
  })
  const {
    setSessionPreferred,
    orderedConfigProviders,
    nextProviderPlaceholder,
    applyOverride,
    setPreferred,
    applyProviderOrder,
    onDevPreviewBootstrap,
  } = useAppActions({
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
  const codexSwapBadge = useMemo(() => buildCodexSwapBadge(codexSwapStatus, providerSwitchStatus), [codexSwapStatus, providerSwitchStatus])
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
    setCodexRefreshing,
    refreshStatus,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
    toggleCodexSwap,
    setCodexSwapModalOpen,
    setOverride,
    overrideDirtyRef,
    applyOverride,
  })
  const {
    clearAutoSaveTimer,
    clearAutoSaveTimersByPrefix,
    queueAutoSaveTimer,
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
    usageFilterProviders,
    usageFilterModels,
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
    providerGroupLabelByName, linkedProvidersForApiKey, switchboardProviderCards, switchboardModeLabel,
    switchboardModelProviderLabel, switchboardTargetDirsLabel, usageSummary, usageByProvider, usageTotalInputTokens,
    usageTotalOutputTokens, usageAvgTokensPerRequest, usageTopModel, usageProviderFilterOptions, usageModelFilterOptions,
    usageProviderDisplayGroups, usagePricedRequestCount, usageDedupedTotalUsedUsd, usagePricedCoveragePct,
    usageActiveWindowHours, usageAvgRequestsPerHour, usageAvgTokensPerHour, usageWindowLabel,
    usageProviderTotalsAndAverages, usagePricingProviderNames, usagePricingGroups, usageScheduleProviderOptions,
    usageAnomalies, toggleUsageProviderFilter, toggleUsageModelFilter, usageChart, showUsageChartHover,
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
    usageStatistics,
    usageFilterProviders,
    setUsageFilterProviders,
    usageFilterModels,
    setUsageFilterModels,
    usageWindowHours,
    setUsageChartHover,
    formatUsdMaybe,
  })
  const { providerDisplayName, usageScheduleSaveStatusText } = useUsageUiDerived({
    providerGroupLabelByName,
    usageScheduleSaveState,
    usageScheduleSaveError,
    setUsageFilterProviders,
    usageProviderFilterOptions,
    setUsageFilterModels,
    usageModelFilterOptions,
  })
  const {
    saveProvider, deleteProvider, saveKey, clearKey, refreshQuota, refreshQuotaAll,
    saveUsageBaseUrl, clearUsageBaseUrl, openKeyModal, openUsageBaseModal, addProvider,
  } = useProviderActions({
    config,
    status,
    isDevPreview,
    keyModal,
    usageBaseModal,
    newProviderName,
    newProviderBaseUrl,
    setKeyModal,
    setUsageBaseModal,
    setNewProviderName,
    setNewProviderBaseUrl,
    setRefreshingProviders,
    refreshStatus,
    refreshConfig,
    flashToast,
  })
  useAppPolling({
    isDevPreview,
    statusLastActivityUnixMs: status?.last_activity_unix_ms,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
    refreshStatus,
    refreshConfig,
    refreshProviderSwitchStatus,
    refreshQuotaAll,
    onDevPreviewBootstrap,
  })
  useAppUsageEffects({
    activePage,
    refreshUsageStatistics,
    usageWindowHours,
    usageFilterProviders,
    usageFilterModels,
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
    setAllProviderPanels,
    allProviderPanelsOpen,
    renderProviderCard,
  } = useProviderPanelUi({
    orderedConfigProviders,
    providerPanelsOpen,
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
    setConfig,
    baselineBaseUrls,
    saveProvider,
    deleteProvider,
    openKeyModal,
    clearKey,
    openUsageBaseModal,
    clearUsageBaseUrl,
    editingProviderName,
  })
  const clearUsageScheduleRowsAutoSave = () => clearAutoSaveTimer('schedule:rows')
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
            />
          </div>
          {/* Surface errors via toast to avoid layout shifts. */}
          <div className={`aoMainArea${activePage === 'dashboard' ? '' : ' aoMainAreaFill'}`} ref={mainAreaRef}>
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
              codexSwapBadgeText={codexSwapBadge.badgeText}
              codexSwapBadgeTitle={codexSwapBadge.badgeTitle}
              override={override}
              onOverrideChange={onOverrideChange}
              onPreferredChange={(next) => void setPreferred(next)}
              onOpenConfigModal={() => setConfigModalOpen(true)}
              refreshingProviders={refreshingProviders}
              onRefreshQuota={(name) => void refreshQuota(name)}
              clientSessions={clientSessions ?? []}
              updatingSessionPref={updatingSessionPref}
              onSetSessionPreferred={(sessionId, provider) => void setSessionPreferred(sessionId, provider)}
              visibleEvents={visibleEvents}
              canClearErrors={canClearErrors}
              onClearErrors={clearErrors}
              usageProps={{
                config,
                usageWindowHours,
                setUsageWindowHours,
                usageStatisticsLoading,
                usageFilterProviders,
                setUsageFilterProviders,
                usageProviderFilterOptions,
                toggleUsageProviderFilter,
                usageFilterModels,
                setUsageFilterModels,
                usageModelFilterOptions,
                toggleUsageModelFilter,
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
              }}
              switchboardProps={{
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
              }}
            />
          </div>
        </div>
      </div>
      <AppModals
        keyModal={keyModal}
        setKeyModal={setKeyModal}
        saveKey={saveKey}
        usageBaseModal={usageBaseModal}
        setUsageBaseModal={setUsageBaseModal}
        clearUsageBaseUrl={clearUsageBaseUrl}
        saveUsageBaseUrl={saveUsageBaseUrl}
        instructionModalOpen={instructionModalOpen}
        setInstructionModalOpen={setInstructionModalOpen}
        openRawConfigModal={openRawConfigModal}
        configModalOpen={configModalOpen}
        config={config}
        allProviderPanelsOpen={allProviderPanelsOpen}
        setAllProviderPanels={setAllProviderPanels}
        newProviderName={newProviderName}
        newProviderBaseUrl={newProviderBaseUrl}
        nextProviderPlaceholder={nextProviderPlaceholder}
        setNewProviderName={setNewProviderName}
        setNewProviderBaseUrl={setNewProviderBaseUrl}
        addProvider={addProvider}
        setConfigModalOpen={setConfigModalOpen}
        rawConfigModalOpen={rawConfigModalOpen}
        rawConfigHomeOptions={rawConfigHomeOptions}
        rawConfigHomeLabels={rawConfigHomeLabels}
        rawConfigTexts={rawConfigTexts}
        rawConfigLoadingByHome={rawConfigLoadingByHome}
        rawConfigSavingByHome={rawConfigSavingByHome}
        rawConfigDirtyByHome={rawConfigDirtyByHome}
        rawConfigLoadedByHome={rawConfigLoadedByHome}
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
    </div>
  )
}
