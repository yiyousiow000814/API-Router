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
import type { Config } from '../types'
import type {
  PricingTimelineMode,
  ProviderScheduleDraft,
  UsageHistoryDraft,
  UsagePricingDraft,
  UsagePricingGroup,
  UsagePricingSaveState,
  UsageScheduleSaveState,
} from '../types/usage'
import type { KeyModalState, UsageBaseModalState } from '../hooks/providerActions/types'
import { KeyModal } from './KeyModal'
import { UsageBaseModal } from './UsageBaseModal'
import { UsageHistoryModal } from './UsageHistoryModal'
import { UsagePricingModal } from './UsagePricingModal'
import { UsageScheduleModal } from './UsageScheduleModal'
import { InstructionModal } from './InstructionModal'
import { GatewayTokenModal } from './GatewayTokenModal'
import { ConfigModal } from './ConfigModal'
import { RawConfigModal } from './RawConfigModal'
import { CodexSwapModal } from './CodexSwapModal'

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

type Props = {
  keyModal: KeyModalState
  setKeyModal: Dispatch<SetStateAction<KeyModalState>>
  saveKey: () => Promise<void>
  usageBaseModal: UsageBaseModalState
  setUsageBaseModal: Dispatch<SetStateAction<UsageBaseModalState>>
  clearUsageBaseUrl: (name: string) => Promise<void>
  saveUsageBaseUrl: () => Promise<void>
  instructionModalOpen: boolean
  setInstructionModalOpen: Dispatch<SetStateAction<boolean>>
  openRawConfigModal: (options?: { reopenGettingStartedOnFail?: boolean }) => Promise<void>
  configModalOpen: boolean
  config: Config | null
  allProviderPanelsOpen: boolean
  setAllProviderPanels: (open: boolean) => void
  newProviderName: string
  newProviderBaseUrl: string
  nextProviderPlaceholder: string
  setNewProviderName: Dispatch<SetStateAction<string>>
  setNewProviderBaseUrl: Dispatch<SetStateAction<string>>
  addProvider: () => Promise<void>
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
  const codexSwapModalWasOpenRef = useRef(false)
  const {
    keyModal,
    setKeyModal,
    saveKey,
    usageBaseModal,
    setUsageBaseModal,
    clearUsageBaseUrl,
    saveUsageBaseUrl,
    instructionModalOpen,
    setInstructionModalOpen,
    openRawConfigModal,
    configModalOpen,
    config,
    allProviderPanelsOpen,
    setAllProviderPanels,
    newProviderName,
    newProviderBaseUrl,
    nextProviderPlaceholder,
    setNewProviderName,
    setNewProviderBaseUrl,
    addProvider,
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
        flashToast={flashToast}
        isDevPreview={isDevPreview}
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
base_url = "http://${GATEWAY_WINDOWS_HOST}:4000/v1"
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
          const res = await invoke<RotateGatewayTokenResult>('rotate_gateway_token')
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
              setCodexSwapModalOpen(false)
              if (reopenGettingStartedAfterDirs) {
                setInstructionModalOpen(true)
                setReopenGettingStartedAfterDirs(false)
              }
            } catch (e) {
              flashToast(String(e), 'error')
            }
          })()
        }}
      />
    </>
  )
}
