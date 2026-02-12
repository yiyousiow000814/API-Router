import { invoke } from '@tauri-apps/api/core'
import { normalizePathForCompare } from '../utils/path'
import { GATEWAY_MODEL_PROVIDER_ID } from '../constants'
import { KeyModal } from './KeyModal'
import { UsageBaseModal } from './UsageBaseModal'
import { UsageHistoryModal } from './UsageHistoryModal'
import { UsagePricingModal } from './UsagePricingModal'
import { UsageScheduleModal } from './UsageScheduleModal'
import { InstructionModal } from './InstructionModal'
import { GatewayTokenModal } from './GatewayTokenModal'
import { ConfigModal } from './ConfigModal'
import { CodexSwapModal } from './CodexSwapModal'

type Props = Record<string, any>

export function AppModals(props: Props) {
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
    codexSwapModalOpen,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapApplyBoth,
    setCodexSwapDir1,
    setCodexSwapDir2,
    setCodexSwapApplyBoth,
    setCodexSwapModalOpen,
    toggleCodexSwap,
    resolveCliHomes,
  } = props

  return (
    <>
      <KeyModal
        open={keyModal.open}
        provider={keyModal.provider}
        value={keyModal.value}
        onChange={(value) => setKeyModal((m: any) => ({ ...m, value }))}
        onCancel={() => setKeyModal({ open: false, provider: '', value: '' })}
        onSave={() => void saveKey()}
      />

      <UsageBaseModal
        open={usageBaseModal.open}
        provider={usageBaseModal.provider}
        value={usageBaseModal.value}
        explicitValue={usageBaseModal.explicitValue}
        onChange={(value) =>
          setUsageBaseModal((m: any) => ({
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
        codeText={`model_provider = "${GATEWAY_MODEL_PROVIDER_ID}"

[model_providers.${GATEWAY_MODEL_PROVIDER_ID}]
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
    </>
  )
}
