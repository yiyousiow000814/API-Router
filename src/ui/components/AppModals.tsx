import type {
  Dispatch,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  RefObject,
  SetStateAction,
} from 'react'
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { SpendHistoryRow } from '../devMockData'
import { normalizePathForCompare } from '../utils/path'
import { isValidWindowsCodexPath, isValidWslCodexPath } from '../utils/codexPathValidation'
import { GATEWAY_MODEL_PROVIDER_ID, GATEWAY_WINDOWS_HOST } from '../constants'
import { buildGatewayBaseUrl, normalizeGatewayPort } from '../utils/gatewayUrl'
import type { Config } from '../types'
import type { RemoteUpdatePendingStage } from '../utils/remoteUpdateStatus'
import type {
  PricingTimelineMode,
  ProviderScheduleDraft,
  UsageHistoryDraft,
  UsagePricingDraft,
  UsagePricingGroup,
  UsagePricingSaveState,
  UsageScheduleSaveState,
} from '../types/usage'
import type {
  KeyModalState,
  ProviderBaseUrlModalState,
  ProviderEmailModalState,
  UsageAuthModalState,
  UsageBaseModalState,
} from '../hooks/providerActions/types'
import { KeyModal } from './KeyModal'
import { ProviderBaseUrlModal } from './ProviderBaseUrlModal'
import { ProviderEmailModal } from './ProviderEmailModal'
import { UsageAuthModal } from './UsageAuthModal'
import { UsageBaseModal } from './UsageBaseModal'
import { UsageHistoryModal } from './UsageHistoryModal'
import { UsagePricingModal } from './UsagePricingModal'
import { UsageScheduleModal } from './UsageScheduleModal'
import { InstructionModal } from './InstructionModal'
import { GatewayTokenModal } from './GatewayTokenModal'
import { ConfigModal } from './ConfigModal'
import { RawConfigModal } from './RawConfigModal'
import { CodexSwapModal } from './CodexSwapModal'
import { ModalBackdrop } from './ModalBackdrop'

type RotateGatewayTokenResult = {
  token: string
  failed_targets?: string[]
}

type CurrencyMenuState = {
  provider: string
  providers: string[]
  left: number
  top: number
  width: number
} | null

type ScheduleCurrencyMenuState = {
  rowIndex: number
  left: number
  top: number
  width: number
} | null

type PendingTrackedRemoval = {
  row: SpendHistoryRow
} | null

type Props = {
  keyModal: KeyModalState
  setKeyModal: Dispatch<SetStateAction<KeyModalState>>
  saveKey: () => Promise<void>
  providerBaseUrlModal: ProviderBaseUrlModalState
  setProviderBaseUrlModal: Dispatch<SetStateAction<ProviderBaseUrlModalState>>
  saveProviderBaseUrl: () => Promise<void>
  providerEmailModal: ProviderEmailModalState
  setProviderEmailModal: Dispatch<SetStateAction<ProviderEmailModalState>>
  saveProviderEmail: () => Promise<void>
  clearProviderEmail: (provider: string) => Promise<void>
  usageAuthModal: UsageAuthModalState
  setUsageAuthModal: Dispatch<SetStateAction<UsageAuthModalState>>
  saveUsageAuth: () => Promise<void>
  clearUsageAuth: (provider: string) => Promise<void>
  usageBaseModal: UsageBaseModalState
  setUsageBaseModal: Dispatch<SetStateAction<UsageBaseModalState>>
  saveUsageBaseUrl: () => Promise<void>
  instructionModalOpen: boolean
  setInstructionModalOpen: Dispatch<SetStateAction<boolean>>
  openRawConfigModal: (options?: { reopenGettingStartedOnFail?: boolean }) => Promise<void>
  configModalOpen: boolean
  config: Config | null
  newProviderName: string
  newProviderBaseUrl: string
  newProviderKey: string
  newProviderKeyStorage: 'auth_json' | 'config_toml_experimental_bearer_token'
  nextProviderPlaceholder: string
  setNewProviderName: Dispatch<SetStateAction<string>>
  setNewProviderBaseUrl: Dispatch<SetStateAction<string>>
  setNewProviderKey: Dispatch<SetStateAction<string>>
  setNewProviderKeyStorage: Dispatch<SetStateAction<'auth_json' | 'config_toml_experimental_bearer_token'>>
  addProvider: () => Promise<void>
  followConfigSource: (nodeId: string) => Promise<void>
  clearFollowedConfigSource: () => Promise<void>
  requestLanPair: (nodeId: string) => Promise<string | null>
  approveLanPair: (requestId: string) => Promise<string | null>
  submitLanPairPin: (nodeId: string, requestId: string, pinCode: string) => Promise<void>
  requestLanRemoteUpdateSameVersion: (nodeId: string) => Promise<void>
  requestLanRemoteUpdateRollback: (nodeId: string) => Promise<void>
  lanRemoteUpdatePendingByNode: Record<string, RemoteUpdatePendingStage>
  openProviderGroupManager: (provider?: string) => void
  setConfigModalOpen: Dispatch<SetStateAction<boolean>>
  rawConfigModalOpen: boolean
  rawConfigHomeOptions: string[]
  rawConfigHomeLabels: Record<string, string>
  rawConfigTexts: Record<string, string>
  rawConfigLoadingByHome: Record<string, boolean>
  rawConfigSavingByHome: Record<string, boolean>
  rawConfigDirtyByHome: Record<string, boolean>
  rawConfigLoadedByHome: Record<string, boolean>
  rawConfigDraftByHome: Record<string, boolean>
  onRawConfigTextChange: (home: string, next: string) => void
  saveRawConfigHome: (home: string) => Promise<void>
  retryRawConfigHome: (home: string) => Promise<void>
  setRawConfigModalOpen: Dispatch<SetStateAction<boolean>>
  providerListRef: RefObject<HTMLDivElement | null>
  orderedConfigProviders: string[]
  dragPreviewOrder: string[] | null
  draggingProvider: string | null
  dragCardHeight: number
  renderProviderCard: (name: string, overlay?: boolean) => ReactElement | null
  gatewayModalOpen: boolean
  gatewayTokenPreview: string
  gatewayTokenReveal: string
  setGatewayModalOpen: Dispatch<SetStateAction<boolean>>
  setGatewayTokenReveal: Dispatch<SetStateAction<string>>
  setGatewayTokenPreview: Dispatch<SetStateAction<string>>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  usageHistoryModalOpen: boolean
  setUsageHistoryModalOpen: Dispatch<SetStateAction<boolean>>
  usageHistoryLoading: boolean
  usageHistoryRows: SpendHistoryRow[]
  setUsageHistoryRows: Dispatch<SetStateAction<SpendHistoryRow[]>>
  usageHistoryDrafts: Record<string, UsageHistoryDraft>
  usageHistoryEditCell: string | null
  setUsageHistoryDrafts: Dispatch<SetStateAction<Record<string, UsageHistoryDraft>>>
  setUsageHistoryEditCell: Dispatch<SetStateAction<string | null>>
  historyDraftFromRow: (row: SpendHistoryRow) => UsageHistoryDraft
  historyPerReqDisplayValue: (row: SpendHistoryRow) => number | null
  historyEffectiveDisplayValue: (row: SpendHistoryRow) => number | null
  formatUsdMaybe: (value: number | null | undefined) => string
  fmtHistorySource: (source?: string | null) => string
  queueUsageHistoryAutoSave: (row: SpendHistoryRow, field: 'effective' | 'per_req') => void
  clearAutoSaveTimer: (key: string) => void
  saveUsageHistoryRow: (
    row: SpendHistoryRow,
    options?: { silent?: boolean; keepEditCell?: boolean; field?: 'effective' | 'per_req' },
  ) => Promise<void>
  refreshUsageHistory: (options?: { silent?: boolean; keepEditCell?: boolean }) => Promise<void>
  refreshUsageStatistics: (options?: { silent?: boolean }) => Promise<void>
  usageHistoryTableSurfaceRef: RefObject<HTMLDivElement | null>
  usageHistoryTableWrapRef: RefObject<HTMLDivElement | null>
  usageHistoryScrollbarOverlayRef: RefObject<HTMLDivElement | null>
  usageHistoryScrollbarThumbRef: RefObject<HTMLDivElement | null>
  scheduleUsageHistoryScrollbarSync: () => void
  activateUsageHistoryScrollbarUi: () => void
  onUsageHistoryScrollbarPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onUsageHistoryScrollbarPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onUsageHistoryScrollbarPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onUsageHistoryScrollbarLostPointerCapture: () => void
  usagePricingModalOpen: boolean
  setUsagePricingModalOpen: Dispatch<SetStateAction<boolean>>
  fxRatesDate: string
  usagePricingGroups: UsagePricingGroup[]
  usagePricingProviderNames: string[]
  usagePricingDrafts: Record<string, UsagePricingDraft>
  usagePricingSaveState: Record<string, UsagePricingSaveState>
  setUsagePricingDrafts: Dispatch<SetStateAction<Record<string, UsagePricingDraft>>>
  buildUsagePricingDraft: (providerName: string, providerCfg?: Config['providers'][string]) => UsagePricingDraft
  queueUsagePricingAutoSaveForProviders: (providerNames: string[], draft: UsagePricingDraft) => void
  setUsagePricingSaveStateForProviders: (providerNames: string[], state: UsagePricingSaveState) => void
  saveUsagePricingForProviders: (
    providerNames: string[],
    draft: UsagePricingDraft,
    options?: { silent?: boolean },
  ) => Promise<boolean>
  openUsageScheduleModal: (providerName: string, seedCurrency?: string, options?: { keepVisible?: boolean }) => Promise<void>
  providerPreferredCurrency: (providerName: string) => string
  pricingDraftSignature: (draft: UsagePricingDraft) => string
  usagePricingLastSavedSigRef: MutableRefObject<Record<string, string>>
  usagePricingCurrencyMenu: CurrencyMenuState
  setUsagePricingCurrencyMenu: Dispatch<SetStateAction<CurrencyMenuState>>
  usagePricingCurrencyQuery: string
  setUsagePricingCurrencyQuery: Dispatch<SetStateAction<string>>
  usageCurrencyOptions: string[]
  normalizeCurrencyCode: (code: string) => string
  currencyLabel: (code: string) => string
  usagePricingCurrencyMenuRef: RefObject<HTMLDivElement | null>
  updateUsagePricingCurrency: (providerNames: string[], draft: UsagePricingDraft, nextCurrency: string) => void
  closeUsagePricingCurrencyMenu: () => void
  usageScheduleModalOpen: boolean
  usageScheduleLoading: boolean
  usageScheduleRows: ProviderScheduleDraft[]
  providerDisplayName: (providerName: string) => string
  providerApiKeyLabel: (providerName: string) => string
  usageScheduleCurrencyMenu: ScheduleCurrencyMenuState
  setUsageScheduleCurrencyMenu: Dispatch<SetStateAction<ScheduleCurrencyMenuState>>
  usageScheduleCurrencyQuery: string
  setUsageScheduleCurrencyQuery: Dispatch<SetStateAction<string>>
  setUsageScheduleSaveState: Dispatch<SetStateAction<UsageScheduleSaveState>>
  setUsageScheduleRows: Dispatch<SetStateAction<ProviderScheduleDraft[]>>
  usageScheduleProviderOptions: string[]
  usageScheduleProvider: string
  parsePositiveAmount: (value: string) => number | null
  fxRatesByCurrency: Record<string, number>
  convertCurrencyToUsd: (rates: Record<string, number>, amount: number, currency: string) => number
  linkedProvidersForApiKey: (apiKeyRef: string, fallbackProvider: string) => string[]
  newScheduleDraft: (
    providerName: string,
    seedAmountUsd?: number | null,
    seedCurrency?: string,
    seedMode?: PricingTimelineMode,
    groupProviders?: string[],
  ) => ProviderScheduleDraft
  usageScheduleSaveState: UsageScheduleSaveState
  usageScheduleSaveStatusText: string
  usageScheduleCurrencyMenuRef: RefObject<HTMLDivElement | null>
  updateUsageScheduleCurrency: (rowIndex: number, nextCurrency: string) => void
  closeUsageScheduleCurrencyMenu: () => void
  clearUsageScheduleRowsAutoSave: () => void
  setUsageScheduleSaveError: Dispatch<SetStateAction<string>>
  setUsageScheduleModalOpen: Dispatch<SetStateAction<boolean>>
  isDevPreview: boolean
  listenPort?: number
  codexSwapModalOpen: boolean
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  setCodexSwapDir1: Dispatch<SetStateAction<string>>
  setCodexSwapDir2: Dispatch<SetStateAction<string>>
  setCodexSwapUseWindows: Dispatch<SetStateAction<boolean>>
  setCodexSwapUseWsl: Dispatch<SetStateAction<boolean>>
  setCodexSwapModalOpen: Dispatch<SetStateAction<boolean>>
  toggleCodexSwap: (homes: string[]) => Promise<void>
  resolveCliHomes: (windowsDir: string, wslDir: string, useWindows: boolean, useWsl: boolean) => string[]
}

export function AppModals(props: Props) {
  const [reopenGettingStartedAfterDirs, setReopenGettingStartedAfterDirs] = useState(false)
  const [draftCodexSwapDir1, setDraftCodexSwapDir1] = useState('')
  const [draftCodexSwapDir2, setDraftCodexSwapDir2] = useState('')
  const [draftCodexSwapUseWindows, setDraftCodexSwapUseWindows] = useState(false)
  const [draftCodexSwapUseWsl, setDraftCodexSwapUseWsl] = useState(false)
  const [pendingTrackedRemoval, setPendingTrackedRemoval] = useState<PendingTrackedRemoval>(null)
  const gatewayPort = normalizeGatewayPort(props.listenPort)
  const codexSwapModalWasOpenRef = useRef(false)
  const {
    keyModal,
    setKeyModal,
    saveKey,
    providerBaseUrlModal,
    setProviderBaseUrlModal,
    saveProviderBaseUrl,
    providerEmailModal,
    setProviderEmailModal,
    saveProviderEmail,
    clearProviderEmail,
    usageAuthModal,
    setUsageAuthModal,
    saveUsageAuth,
    clearUsageAuth,
    usageBaseModal,
    setUsageBaseModal,
    saveUsageBaseUrl,
    instructionModalOpen,
    setInstructionModalOpen,
    openRawConfigModal,
    configModalOpen,
    config,
    newProviderName,
    newProviderBaseUrl,
    newProviderKey,
    newProviderKeyStorage,
    nextProviderPlaceholder,
    setNewProviderName,
    setNewProviderBaseUrl,
    setNewProviderKey,
    setNewProviderKeyStorage,
    addProvider,
    followConfigSource,
    clearFollowedConfigSource,
    requestLanPair,
    approveLanPair,
    submitLanPairPin,
    requestLanRemoteUpdateSameVersion,
    requestLanRemoteUpdateRollback,
    lanRemoteUpdatePendingByNode,
    openProviderGroupManager,
    setConfigModalOpen,
    rawConfigModalOpen,
    rawConfigHomeOptions,
    rawConfigHomeLabels,
    rawConfigTexts,
    rawConfigLoadingByHome,
    rawConfigSavingByHome,
    rawConfigDirtyByHome,
    rawConfigLoadedByHome,
    rawConfigDraftByHome,
    onRawConfigTextChange,
    saveRawConfigHome,
    retryRawConfigHome,
    setRawConfigModalOpen,
    providerListRef,
    orderedConfigProviders,
    dragPreviewOrder,
    draggingProvider,
    dragCardHeight,
    renderProviderCard,
    gatewayModalOpen,
    gatewayTokenPreview,
    gatewayTokenReveal,
    setGatewayModalOpen,
    setGatewayTokenReveal,
    setGatewayTokenPreview,
    flashToast,
    usageHistoryModalOpen,
    setUsageHistoryModalOpen,
    usageHistoryLoading,
    usageHistoryRows,
    setUsageHistoryRows,
    usageHistoryDrafts,
    usageHistoryEditCell,
    setUsageHistoryDrafts,
    setUsageHistoryEditCell,
    historyDraftFromRow,
    historyPerReqDisplayValue,
    historyEffectiveDisplayValue,
    formatUsdMaybe,
    fmtHistorySource,
    queueUsageHistoryAutoSave,
    clearAutoSaveTimer,
    saveUsageHistoryRow,
    refreshUsageHistory,
    refreshUsageStatistics,
    usageHistoryTableSurfaceRef,
    usageHistoryTableWrapRef,
    usageHistoryScrollbarOverlayRef,
    usageHistoryScrollbarThumbRef,
    scheduleUsageHistoryScrollbarSync,
    activateUsageHistoryScrollbarUi,
    onUsageHistoryScrollbarPointerDown,
    onUsageHistoryScrollbarPointerMove,
    onUsageHistoryScrollbarPointerUp,
    onUsageHistoryScrollbarLostPointerCapture,
    usagePricingModalOpen,
    setUsagePricingModalOpen,
    fxRatesDate,
    usagePricingGroups,
    usagePricingProviderNames,
    usagePricingDrafts,
    usagePricingSaveState,
    setUsagePricingDrafts,
    buildUsagePricingDraft,
    queueUsagePricingAutoSaveForProviders,
    setUsagePricingSaveStateForProviders,
    saveUsagePricingForProviders,
    openUsageScheduleModal,
    providerPreferredCurrency,
    pricingDraftSignature,
    usagePricingLastSavedSigRef,
    usagePricingCurrencyMenu,
    setUsagePricingCurrencyMenu,
    usagePricingCurrencyQuery,
    setUsagePricingCurrencyQuery,
    usageCurrencyOptions,
    normalizeCurrencyCode,
    currencyLabel,
    usagePricingCurrencyMenuRef,
    updateUsagePricingCurrency,
    closeUsagePricingCurrencyMenu,
    usageScheduleModalOpen,
    usageScheduleLoading,
    usageScheduleRows,
    providerDisplayName,
    providerApiKeyLabel,
    usageScheduleCurrencyMenu,
    setUsageScheduleCurrencyMenu,
    usageScheduleCurrencyQuery,
    setUsageScheduleCurrencyQuery,
    setUsageScheduleSaveState,
    setUsageScheduleRows,
    usageScheduleProviderOptions,
    usageScheduleProvider,
    parsePositiveAmount,
    fxRatesByCurrency,
    convertCurrencyToUsd,
    linkedProvidersForApiKey,
    newScheduleDraft,
    usageScheduleSaveState,
    usageScheduleSaveStatusText,
    usageScheduleCurrencyMenuRef,
    updateUsageScheduleCurrency,
    closeUsageScheduleCurrencyMenu,
    clearUsageScheduleRowsAutoSave,
    setUsageScheduleSaveError,
    setUsageScheduleModalOpen,
    isDevPreview,
    codexSwapModalOpen,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
    setCodexSwapDir1,
    setCodexSwapDir2,
    setCodexSwapUseWindows,
    setCodexSwapUseWsl,
    setCodexSwapModalOpen,
    toggleCodexSwap,
    resolveCliHomes,
  } = props

  useEffect(() => {
    const justOpened = codexSwapModalOpen && !codexSwapModalWasOpenRef.current
    codexSwapModalWasOpenRef.current = codexSwapModalOpen
    if (!justOpened) return
    setDraftCodexSwapDir1(codexSwapDir1)
    setDraftCodexSwapDir2(codexSwapDir2)
    setDraftCodexSwapUseWindows(codexSwapUseWindows)
    setDraftCodexSwapUseWsl(codexSwapUseWsl)
  }, [codexSwapModalOpen, codexSwapDir1, codexSwapDir2, codexSwapUseWindows, codexSwapUseWsl])

  return (
    <>
      <KeyModal
        open={keyModal.open}
        provider={keyModal.provider}
        value={keyModal.value}
        storage={keyModal.storage}
        loading={keyModal.loading}
        loadFailed={keyModal.loadFailed}
        onChange={(value) => setKeyModal((m) => ({ ...m, value }))}
        onChangeStorage={(storage) => setKeyModal((m) => ({ ...m, storage }))}
        onCancel={() =>
          setKeyModal({ open: false, provider: '', value: '', storage: 'auth_json', loading: false, loadFailed: false })
        }
        onSave={() => void saveKey()}
      />

      <ProviderBaseUrlModal
        open={providerBaseUrlModal.open}
        provider={providerBaseUrlModal.provider}
        value={providerBaseUrlModal.value}
        onChange={(value) => setProviderBaseUrlModal((modal) => ({ ...modal, value }))}
        onCancel={() => setProviderBaseUrlModal({ open: false, provider: '', value: '' })}
        onSave={() => void saveProviderBaseUrl()}
      />

      <ProviderEmailModal
        open={providerEmailModal.open}
        provider={providerEmailModal.provider}
        value={providerEmailModal.value}
        onChange={(value) => setProviderEmailModal((modal) => ({ ...modal, value }))}
        onCancel={() => setProviderEmailModal({ open: false, provider: '', value: '' })}
        onClear={() => {
          void clearProviderEmail(providerEmailModal.provider)
          setProviderEmailModal({ open: false, provider: '', value: '' })
        }}
        onSave={() => void saveProviderEmail()}
      />

      <UsageBaseModal
        open={usageBaseModal.open}
        provider={usageBaseModal.provider}
        value={usageBaseModal.value}
        effectiveValue={usageBaseModal.effectiveValue}
        username={usageBaseModal.username}
        password={usageBaseModal.password}
        showAuthFields={usageBaseModal.showAuthFields}
        loadFailed={usageBaseModal.loadFailed}
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
            baseUrl: '',
            showUrlInput: true,
            showAuthFields: false,
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
        }
        onChangeUsername={(username) => setUsageBaseModal((m) => ({ ...m, username }))}
        onChangePassword={(password) => setUsageBaseModal((m) => ({ ...m, password }))}
        onClear={() =>
          setUsageBaseModal((m) => ({
            ...m,
            value: '',
            auto: false,
            explicitValue: '',
            token: '',
            username: '',
            password: '',
          }))
        }
        onSave={() => void saveUsageBaseUrl()}
      />

      <UsageAuthModal
        open={usageAuthModal.open}
        provider={usageAuthModal.provider}
        baseUrl={usageAuthModal.baseUrl}
        token={usageAuthModal.token}
        username={usageAuthModal.username}
        password={usageAuthModal.password}
        loading={usageAuthModal.loading}
        loadFailed={usageAuthModal.loadFailed}
        onChangeUsername={(username) => setUsageAuthModal((m) => ({ ...m, username }))}
        onChangePassword={(password) => setUsageAuthModal((m) => ({ ...m, password }))}
        onCancel={() =>
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
        }
        onClear={() => {
          void clearUsageAuth(usageAuthModal.provider)
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
        }}
        onSave={() => void saveUsageAuth()}
      />

      <InstructionModal
        open={instructionModalOpen}
        onClose={() => setInstructionModalOpen(false)}
        flashToast={flashToast}
        isDevPreview={isDevPreview}
        listenPort={gatewayPort}
        onOpenConfigureDirs={() => {
          setReopenGettingStartedAfterDirs(true)
          setInstructionModalOpen(false)
          setCodexSwapModalOpen(true)
        }}
        onOpenRawConfig={() => {
          setInstructionModalOpen(false)
          void openRawConfigModal({ reopenGettingStartedOnFail: true })
        }}
        codeText={`model_provider = "${GATEWAY_MODEL_PROVIDER_ID}"

[model_providers.${GATEWAY_MODEL_PROVIDER_ID}]
name = "API Router"
base_url = "${buildGatewayBaseUrl(GATEWAY_WINDOWS_HOST, gatewayPort)}"
wire_api = "responses"
requires_openai_auth = true`}
      />

      <ConfigModal
        open={configModalOpen}
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
        onAddProvider={() => void addProvider()}
        onFollowSource={(nodeId) => void followConfigSource(nodeId)}
        onClearFollowSource={() => void clearFollowedConfigSource()}
        onRequestPair={requestLanPair}
        onApprovePair={approveLanPair}
        onSubmitPairPin={submitLanPairPin}
        onSyncPeerVersion={(nodeId) => void requestLanRemoteUpdateSameVersion(nodeId)}
        onRollbackPeerVersion={(nodeId) => void requestLanRemoteUpdateRollback(nodeId)}
        remoteUpdatePendingByNode={lanRemoteUpdatePendingByNode}
        onOpenGroupManager={() => openProviderGroupManager()}
        onClose={() => setConfigModalOpen(false)}
        providerListRef={providerListRef}
        orderedConfigProviders={orderedConfigProviders}
        dragPreviewOrder={dragPreviewOrder}
        draggingProvider={draggingProvider}
        dragCardHeight={dragCardHeight}
        renderProviderCard={renderProviderCard}
      />

      <RawConfigModal
        open={rawConfigModalOpen}
        homeOptions={rawConfigHomeOptions}
        homeLabels={rawConfigHomeLabels}
        valuesByHome={rawConfigTexts}
        loadingByHome={rawConfigLoadingByHome}
        savingByHome={rawConfigSavingByHome}
        dirtyByHome={rawConfigDirtyByHome}
        loadedByHome={rawConfigLoadedByHome}
        draftByHome={rawConfigDraftByHome}
        onChangeHome={onRawConfigTextChange}
        onSaveHome={(home) => void saveRawConfigHome(home)}
        onRetryHome={(home) => void retryRawConfigHome(home)}
        onClose={() => setRawConfigModalOpen(false)}
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
          const cliHomes = resolveCliHomes(
            codexSwapDir1,
            codexSwapDir2,
            codexSwapUseWindows,
            codexSwapUseWsl,
          )
          const res = await invoke<RotateGatewayTokenResult>('rotate_gateway_token', { cliHomes })
          setGatewayTokenReveal(res.token)
          const p = await invoke<string>('get_gateway_token_preview')
          setGatewayTokenPreview(p)
          const failed = (res.failed_targets ?? []).filter(Boolean)
          if (failed.length) {
            const shown = failed.slice(0, 2).join(' ; ')
            const more = failed.length > 2 ? ` ; +${failed.length - 2} more` : ''
            flashToast(
              `Gateway token rotated. Failed to sync: ${shown}${more}. Check Provider Switchboard -> Edit config.toml for those targets.`,
              'error',
            )
          } else {
            flashToast('Gateway token rotated')
          }
        }}
      />

      <UsageHistoryModal
        open={usageHistoryModalOpen}
        onClose={() => setUsageHistoryModalOpen(false)}
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
        formatHistorySource={fmtHistorySource}
        queueUsageHistoryAutoSave={queueUsageHistoryAutoSave}
        clearAutoSaveTimer={clearAutoSaveTimer}
        saveUsageHistoryRow={saveUsageHistoryRow}
        onClearRow={async (row) => {
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
        }}
        onRemoveTrackedRow={async (row) => {
          setPendingTrackedRemoval({ row })
        }}
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
      />
      {pendingTrackedRemoval ? (
        <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={() => setPendingTrackedRemoval(null)}>
          <div className="aoModal aoTrackedRemovalConfirmModal" onClick={(e) => e.stopPropagation()}>
            <div className="aoTrackedRemovalConfirmTitle">Remove tracked row?</div>
            <div className="aoTrackedRemovalConfirmText">
              {pendingTrackedRemoval.row.provider} {pendingTrackedRemoval.row.day_key}
            </div>
            <div className="aoTrackedRemovalConfirmSub">This removes all tracked entries merged into this daily row.</div>
            <div className="aoTrackedRemovalConfirmSummary" aria-label="Tracked row summary">
              <div className="aoTrackedRemovalConfirmSummaryRow">
                <span className="aoTrackedRemovalConfirmSummaryItem">
                  <span className="aoTrackedRemovalConfirmSummaryLabel">Req</span>
                  <span className="aoTrackedRemovalConfirmSummaryValue">
                    {(pendingTrackedRemoval.row.req_count ?? 0).toLocaleString()}
                  </span>
                </span>
                <span className="aoTrackedRemovalConfirmSummaryItem">
                  <span className="aoTrackedRemovalConfirmSummaryLabel">Tokens</span>
                  <span className="aoTrackedRemovalConfirmSummaryValue">
                    {(pendingTrackedRemoval.row.total_tokens ?? 0).toLocaleString()}
                  </span>
                </span>
              </div>
              <div className="aoTrackedRemovalConfirmSummaryRow">
                <span className="aoTrackedRemovalConfirmSummaryItem">
                  <span className="aoTrackedRemovalConfirmSummaryLabel">Tracked $</span>
                  <span className="aoTrackedRemovalConfirmSummaryValue">
                    {formatUsdMaybe(pendingTrackedRemoval.row.tracked_total_usd ?? null)}
                  </span>
                </span>
                <span className="aoTrackedRemovalConfirmSummaryItem">
                  <span className="aoTrackedRemovalConfirmSummaryLabel">Effective $</span>
                  <span className="aoTrackedRemovalConfirmSummaryValue">
                    {formatUsdMaybe(pendingTrackedRemoval.row.effective_total_usd ?? null)}
                  </span>
                </span>
              </div>
            </div>
            <div className="aoTrackedRemovalConfirmActions">
              <button className="aoBtn" onClick={() => setPendingTrackedRemoval(null)}>
                Cancel
              </button>
              <button
                className="aoBtn aoBtnDanger"
                onClick={async () => {
                  const { row } = pendingTrackedRemoval
                  try {
                    setUsageHistoryEditCell(null)
                    const key = `${row.provider}|${row.day_key}`
                    if (isDevPreview) {
                      setUsageHistoryRows((prev) =>
                        prev.filter((entry) => !(entry.provider === row.provider && entry.day_key === row.day_key)),
                      )
                      setUsageHistoryDrafts((prev) => {
                        const next = { ...prev }
                        delete next[key]
                        return next
                      })
                      flashToast(`Removed tracked row: ${row.provider} ${row.day_key}`)
                    } else {
                      const removed = await invoke<number>('remove_tracked_spend_history_entries', {
                        provider: row.provider,
                        dayKey: row.day_key,
                      })
                      await refreshUsageHistory({ silent: true })
                      await refreshUsageStatistics({ silent: true })
                      flashToast(`Removed ${removed} tracked entry(s): ${row.provider} ${row.day_key}`)
                    }
                    setPendingTrackedRemoval(null)
                  } catch (e) {
                    flashToast(String(e), 'error')
                  }
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </ModalBackdrop>
      ) : null}

      <UsagePricingModal
        open={usagePricingModalOpen}
        onClose={() => setUsagePricingModalOpen(false)}
        fxRatesDate={fxRatesDate}
        usagePricingGroups={usagePricingGroups}
        usagePricingProviderNames={usagePricingProviderNames}
        config={config}
        usagePricingDrafts={usagePricingDrafts}
        usagePricingSaveState={usagePricingSaveState}
        setUsagePricingDrafts={setUsagePricingDrafts}
        buildUsagePricingDraft={buildUsagePricingDraft}
        queueUsagePricingAutoSaveForProviders={queueUsagePricingAutoSaveForProviders}
        clearAutoSaveTimer={clearAutoSaveTimer}
        setUsagePricingSaveStateForProviders={setUsagePricingSaveStateForProviders}
        saveUsagePricingForProviders={saveUsagePricingForProviders}
        openUsageScheduleModal={openUsageScheduleModal}
        providerPreferredCurrency={providerPreferredCurrency}
        pricingDraftSignature={pricingDraftSignature}
        onMarkPricingSaved={(providerNames, signature) => {
          providerNames.forEach((name) => {
            usagePricingLastSavedSigRef.current[name] = signature
          })
        }}
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
      />

      <UsageScheduleModal
        open={usageScheduleModalOpen}
        onClose={() => {
          closeUsageScheduleCurrencyMenu()
          clearUsageScheduleRowsAutoSave()
          setUsageScheduleSaveState('idle')
          setUsageScheduleSaveError('')
          setUsageScheduleModalOpen(false)
        }}
        usageScheduleLoading={usageScheduleLoading}
        usageScheduleRows={usageScheduleRows}
        providerDisplayName={providerDisplayName}
        providerApiKeyLabel={providerApiKeyLabel}
        usageScheduleCurrencyMenu={usageScheduleCurrencyMenu}
        setUsageScheduleCurrencyMenu={setUsageScheduleCurrencyMenu}
        usageScheduleCurrencyQuery={usageScheduleCurrencyQuery}
        setUsageScheduleCurrencyQuery={setUsageScheduleCurrencyQuery}
        currencyLabel={currencyLabel}
        normalizeCurrencyCode={normalizeCurrencyCode}
        setUsageScheduleSaveState={setUsageScheduleSaveState}
        setUsageScheduleRows={setUsageScheduleRows}
        usageScheduleProviderOptions={usageScheduleProviderOptions}
        usageScheduleProvider={usageScheduleProvider}
        parsePositiveAmount={parsePositiveAmount}
        providerPreferredCurrency={providerPreferredCurrency}
        config={config}
        fxRatesByCurrency={fxRatesByCurrency}
        convertCurrencyToUsd={convertCurrencyToUsd}
        linkedProvidersForApiKey={linkedProvidersForApiKey}
        newScheduleDraft={newScheduleDraft}
        usageScheduleSaveState={usageScheduleSaveState}
        usageScheduleSaveStatusText={usageScheduleSaveStatusText}
        usageCurrencyOptions={usageCurrencyOptions}
        usageScheduleCurrencyMenuRef={usageScheduleCurrencyMenuRef}
        updateUsageScheduleCurrency={updateUsageScheduleCurrency}
        closeUsageScheduleCurrencyMenu={closeUsageScheduleCurrencyMenu}
      />

      <CodexSwapModal
        open={codexSwapModalOpen}
        windowsDir={draftCodexSwapDir1}
        wslDir={draftCodexSwapDir2}
        useWindows={draftCodexSwapUseWindows}
        useWsl={draftCodexSwapUseWsl}
        flashToast={flashToast}
        isDevPreview={isDevPreview}
        onChangeWindowsDir={setDraftCodexSwapDir1}
        onChangeWslDir={setDraftCodexSwapDir2}
        onChangeUseWindows={setDraftCodexSwapUseWindows}
        onChangeUseWsl={setDraftCodexSwapUseWsl}
        onCancel={() => {
          setCodexSwapModalOpen(false)
          if (reopenGettingStartedAfterDirs) {
            setInstructionModalOpen(true)
            setReopenGettingStartedAfterDirs(false)
          }
        }}
        onApply={() => {
          void (async () => {
            try {
              const windowsDir = draftCodexSwapDir1.trim()
              const wslDir = draftCodexSwapDir2.trim()
              if (!draftCodexSwapUseWindows && !draftCodexSwapUseWsl) {
                throw new Error('Enable Windows and/or WSL2.')
              }
              if (draftCodexSwapUseWindows && !isValidWindowsCodexPath(windowsDir)) {
                throw new Error('Windows path is invalid. Use an absolute Windows path ending with \\.codex')
              }
              if (draftCodexSwapUseWsl && !isValidWslCodexPath(wslDir)) {
                throw new Error('WSL2 path is invalid. Use \\\\wsl.localhost\\...\\.codex')
              }
              if (
                draftCodexSwapUseWindows &&
                draftCodexSwapUseWsl &&
                windowsDir &&
                wslDir &&
                normalizePathForCompare(windowsDir) === normalizePathForCompare(wslDir)
              ) {
                throw new Error('Windows and WSL2 paths must be different')
              }
              setCodexSwapDir1(windowsDir)
              setCodexSwapDir2(wslDir)
              setCodexSwapUseWindows(draftCodexSwapUseWindows)
              setCodexSwapUseWsl(draftCodexSwapUseWsl)
              if (!isDevPreview) {
                await invoke('codex_cli_directories_set', {
                  windowsEnabled: draftCodexSwapUseWindows,
                  windowsHome: windowsDir,
                  wsl2Enabled: draftCodexSwapUseWsl,
                  wsl2Home: wslDir,
                })
              }
              setCodexSwapModalOpen(false)
              if (reopenGettingStartedAfterDirs) {
                setInstructionModalOpen(true)
                setReopenGettingStartedAfterDirs(false)
              }
              if (!isDevPreview) {
                const homes = resolveCliHomes(
                  windowsDir,
                  wslDir,
                  draftCodexSwapUseWindows,
                  draftCodexSwapUseWsl,
                )
                await toggleCodexSwap(homes)
              } else {
                flashToast('[TEST] Applied directories in preview mode.')
              }
            } catch (e) {
              flashToast(String(e), 'error')
            }
          })()
        }}
        listenPort={gatewayPort}
      />
    </>
  )
}
