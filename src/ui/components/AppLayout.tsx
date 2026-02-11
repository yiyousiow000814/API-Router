import { invoke } from '@tauri-apps/api/core'

import { AppBody } from './AppBody'
import { AppCoreModals } from './AppCoreModals'
import { AppUsageModals } from './AppUsageModals'
import { CodexSwapModal } from './CodexSwapModal'

type Props = any

export function AppLayout(props: Props) {
  return (
    <>
      <AppBody
        containerRef={props.containerRef}
        contentRef={props.contentRef}
        mainAreaRef={props.mainAreaRef}
        toast={props.toast}
        activePage={props.activePage}
        switchPage={props.switchPage}
        setInstructionModalOpen={props.setInstructionModalOpen}
        usageWindowHours={props.usageWindowHours}
        usageStatisticsLoading={props.usageStatisticsLoading}
        usageFilterProviders={props.usageFilterProviders}
        usageProviderFilterOptions={props.usageProviderFilterOptions}
        usageFilterModels={props.usageFilterModels}
        usageModelFilterOptions={props.usageModelFilterOptions}
        usageAnomalyMessages={props.usageAnomalies.messages}
        usageSummary={props.usageSummary}
        usageTopModel={props.usageTopModel}
        usageDedupedTotalUsedUsd={props.usageDedupedTotalUsedUsd}
        usageTotalInputTokens={props.usageTotalInputTokens}
        usageTotalOutputTokens={props.usageTotalOutputTokens}
        usageAvgTokensPerRequest={props.usageAvgTokensPerRequest}
        usageActiveWindowHours={props.usageActiveWindowHours}
        usagePricedRequestCount={props.usagePricedRequestCount}
        usagePricedCoveragePct={props.usagePricedCoveragePct}
        usageAvgRequestsPerHour={props.usageAvgRequestsPerHour}
        usageAvgTokensPerHour={props.usageAvgTokensPerHour}
        usageWindowLabel={props.usageWindowLabel}
        usageGeneratedAtUnixMs={props.usageStatistics?.generated_at_unix_ms}
        setUsageWindowHours={props.setUsageWindowHours}
        setUsageFilterProviders={props.setUsageFilterProviders}
        toggleUsageProviderFilter={props.toggleUsageProviderFilter}
        setUsageFilterModels={props.setUsageFilterModels}
        toggleUsageModelFilter={props.toggleUsageModelFilter}
        fmtKpiTokens={props.fmtKpiTokens}
        fmtUsdMaybe={props.fmtUsdMaybe}
        fmtWhen={props.fmtWhen}
        usageChart={props.usageChart}
        usageChartHover={props.usageChartHover}
        setUsageChartHover={props.setUsageChartHover}
        showUsageChartHover={props.showUsageChartHover}
        fmtUsageBucketLabel={props.fmtUsageBucketLabel}
        usageByProvider={props.usageByProvider}
        usageProviderDisplayGroups={props.usageProviderDisplayGroups}
        usageProviderShowDetails={props.usageProviderShowDetails}
        usageAnomalyRowKeys={props.usageAnomalies.highCostRowKeys}
        usageProviderTotalsAndAverages={props.usageProviderTotalsAndAverages}
        usageScheduleProviderOptions={props.usageScheduleProviderOptions}
        config={props.config}
        openUsageScheduleModal={props.openUsageScheduleModal}
        providerPreferredCurrency={props.providerPreferredCurrency}
        setUsageProviderShowDetails={props.setUsageProviderShowDetails}
        usageProviderRowKey={props.usageProviderRowKey}
        fmtPricingSource={props.fmtPricingSource}
        setUsageHistoryModalOpen={props.setUsageHistoryModalOpen}
        setUsagePricingModalOpen={props.setUsagePricingModalOpen}
        switchboardModeLabel={props.switchboardModeLabel}
        switchboardModelProviderLabel={props.switchboardModelProviderLabel}
        switchboardTargetDirsLabel={props.switchboardTargetDirsLabel}
        providerSwitchStatus={props.providerSwitchStatus}
        providerSwitchBusy={props.providerSwitchBusy}
        switchboardProviderCards={props.switchboardProviderCards}
        setProviderSwitchTarget={props.setProviderSwitchTarget}
        setCodexSwapModalOpen={props.setCodexSwapModalOpen}
        status={props.status}
        providers={props.providers}
        gatewayTokenPreview={props.gatewayTokenPreview}
        codexRefreshing={props.codexRefreshing}
        override={props.override}
        refreshingProviders={props.refreshingProviders}
        clientSessions={props.clientSessions}
        updatingSessionPref={props.updatingSessionPref}
        visibleEvents={props.visibleEvents}
        canClearErrors={props.canClearErrors}
        codexSwapBadge={props.codexSwapBadge}
        flashToast={props.flashToast}
        setGatewayModalOpen={props.setGatewayModalOpen}
        setGatewayTokenReveal={props.setGatewayTokenReveal}
        refreshStatus={props.refreshStatus}
        setCodexRefreshing={props.setCodexRefreshing}
        resolveCliHomes={props.resolveCliHomes}
        codexSwapDir1={props.codexSwapDir1}
        codexSwapDir2={props.codexSwapDir2}
        codexSwapApplyBoth={props.codexSwapApplyBoth}
        toggleCodexSwap={props.toggleCodexSwap}
        setOverride={props.setOverride}
        overrideDirtyRef={props.overrideDirtyRef}
        applyOverride={props.applyOverride}
        setPreferred={props.setPreferred}
        refreshQuota={props.refreshQuota}
        setSessionPreferred={props.setSessionPreferred}
        clearErrors={props.clearErrors}
        setConfigModalOpen={props.setConfigModalOpen}
      />

      <AppCoreModals
        keyModal={props.keyModal}
        usageBaseModal={props.usageBaseModal}
        instructionModalOpen={props.instructionModalOpen}
        configModalOpen={props.configModalOpen}
        gatewayModalOpen={props.gatewayModalOpen}
        gatewayTokenPreview={props.gatewayTokenPreview}
        gatewayTokenReveal={props.gatewayTokenReveal}
        config={props.config}
        allProviderPanelsOpen={props.allProviderPanelsOpen}
        newProviderName={props.newProviderName}
        newProviderBaseUrl={props.newProviderBaseUrl}
        nextProviderPlaceholder={props.nextProviderPlaceholder}
        providerListRef={props.providerListRef}
        orderedConfigProviders={props.orderedConfigProviders}
        dragPreviewOrder={props.dragPreviewOrder}
        draggingProvider={props.draggingProvider}
        dragCardHeight={props.dragCardHeight}
        setKeyModal={props.setKeyModal}
        setUsageBaseModal={props.setUsageBaseModal}
        setInstructionModalOpen={props.setInstructionModalOpen}
        setConfigModalOpen={props.setConfigModalOpen}
        setGatewayModalOpen={props.setGatewayModalOpen}
        setGatewayTokenReveal={props.setGatewayTokenReveal}
        setAllProviderPanels={props.setAllProviderPanels}
        setNewProviderName={props.setNewProviderName}
        setNewProviderBaseUrl={props.setNewProviderBaseUrl}
        onSaveKey={props.saveKey}
        onClearUsageBaseUrl={props.clearUsageBaseUrl}
        onSaveUsageBaseUrl={props.saveUsageBaseUrl}
        onAddProvider={props.addProvider}
        renderProviderCard={props.renderProviderCard}
        onGatewayReveal={async () => {
          const token = await invoke<string>('get_gateway_token')
          props.setGatewayTokenReveal(token)
        }}
        onGatewayRotate={async () => {
          const token = await invoke<string>('rotate_gateway_token')
          props.setGatewayTokenReveal(token)
          const preview = await invoke<string>('get_gateway_token_preview')
          props.setGatewayTokenPreview(preview)
          props.flashToast('Gateway token rotated')
        }}
      />

      <AppUsageModals
        usageHistoryModalOpen={props.usageHistoryModalOpen}
        usageHistoryLoading={props.usageHistoryLoading}
        usageHistoryRows={props.usageHistoryRows}
        usageHistoryTableSurfaceRef={props.usageHistoryTableSurfaceRef}
        usageHistoryTableWrapRef={props.usageHistoryTableWrapRef}
        usageHistoryScrollbarOverlayRef={props.usageHistoryScrollbarOverlayRef}
        usageHistoryScrollbarThumbRef={props.usageHistoryScrollbarThumbRef}
        renderUsageHistoryColGroup={props.renderUsageHistoryColGroup}
        setUsageHistoryModalOpen={props.setUsageHistoryModalOpen}
        scheduleUsageHistoryScrollbarSync={props.scheduleUsageHistoryScrollbarSync}
        activateUsageHistoryScrollbarUi={props.activateUsageHistoryScrollbarUi}
        usageHistoryDrafts={props.usageHistoryDrafts}
        usageHistoryEditCell={props.usageHistoryEditCell}
        setUsageHistoryEditCell={props.setUsageHistoryEditCell}
        setUsageHistoryDrafts={props.setUsageHistoryDrafts}
        historyDraftFromRow={props.historyDraftFromRow}
        formatDraftAmount={props.formatDraftAmount}
        historyPerReqDisplayValue={props.historyPerReqDisplayValue}
        historyEffectiveDisplayValue={props.historyEffectiveDisplayValue}
        queueUsageHistoryAutoSave={props.queueUsageHistoryAutoSave}
        clearAutoSaveTimer={props.clearAutoSaveTimer}
        saveUsageHistoryRow={props.saveUsageHistoryRow}
        refreshUsageHistory={props.refreshUsageHistory}
        refreshUsageStatistics={props.refreshUsageStatistics}
        flashToast={props.flashToast}
        fmtUsdMaybe={props.fmtUsdMaybe}
        fmtHistorySource={props.fmtHistorySource}
        onUsageHistoryScrollbarPointerDown={props.onUsageHistoryScrollbarPointerDown}
        onUsageHistoryScrollbarPointerMove={props.onUsageHistoryScrollbarPointerMove}
        onUsageHistoryScrollbarPointerUp={props.onUsageHistoryScrollbarPointerUp}
        onUsageHistoryScrollbarLostPointerCapture={props.onUsageHistoryScrollbarLostPointerCapture}
        usagePricingModalOpen={props.usagePricingModalOpen}
        setUsagePricingModalOpen={props.setUsagePricingModalOpen}
        fxRatesDate={props.fxRatesDate}
        config={props.config}
        usagePricingGroups={props.usagePricingGroups}
        usagePricingDrafts={props.usagePricingDrafts}
        usagePricingSaveState={props.usagePricingSaveState}
        usagePricingProviderNames={props.usagePricingProviderNames}
        usagePricingCurrencyMenu={props.usagePricingCurrencyMenu}
        usagePricingCurrencyQuery={props.usagePricingCurrencyQuery}
        usageCurrencyOptions={props.usageCurrencyOptions}
        usagePricingCurrencyMenuRef={props.usagePricingCurrencyMenuRef}
        usagePricingLastSavedSigRef={props.usagePricingLastSavedSigRef}
        setUsagePricingCurrencyMenu={props.setUsagePricingCurrencyMenu}
        setUsagePricingCurrencyQuery={props.setUsagePricingCurrencyQuery}
        setUsagePricingDrafts={props.setUsagePricingDrafts}
        setUsagePricingSaveStateForProviders={props.setUsagePricingSaveStateForProviders}
        buildUsagePricingDraft={props.buildUsagePricingDraft}
        queueUsagePricingAutoSaveForProviders={props.queueUsagePricingAutoSaveForProviders}
        saveUsagePricingForProviders={props.saveUsagePricingForProviders}
        openUsageScheduleModal={props.openUsageScheduleModal}
        providerPreferredCurrency={props.providerPreferredCurrency}
        pricingDraftSignature={props.pricingDraftSignature}
        normalizeCurrencyCode={props.normalizeCurrencyCode}
        currencyLabel={props.currencyLabel}
        updateUsagePricingCurrency={props.updateUsagePricingCurrency}
        closeUsagePricingCurrencyMenu={props.closeUsagePricingCurrencyMenu}
        usageScheduleModalOpen={props.usageScheduleModalOpen}
        usageScheduleLoading={props.usageScheduleLoading}
        usageScheduleRows={props.usageScheduleRows}
        usageScheduleProvider={props.usageScheduleProvider}
        usageScheduleProviderOptions={props.usageScheduleProviderOptions}
        usageScheduleSaveState={props.usageScheduleSaveState}
        usageScheduleSaveStatusText={props.usageScheduleSaveStatusText}
        usageScheduleCurrencyMenu={props.usageScheduleCurrencyMenu}
        usageScheduleCurrencyMenuRef={props.usageScheduleCurrencyMenuRef}
        usageScheduleCurrencyQuery={props.usageScheduleCurrencyQuery}
        setUsageScheduleCurrencyQuery={props.setUsageScheduleCurrencyQuery}
        setUsageScheduleRows={props.setUsageScheduleRows}
        setUsageScheduleSaveState={props.setUsageScheduleSaveState}
        setUsageScheduleSaveError={props.setUsageScheduleSaveError}
        closeUsageScheduleCurrencyMenu={props.closeUsageScheduleCurrencyMenu}
        setUsageScheduleModalOpen={props.setUsageScheduleModalOpen}
        providerDisplayName={props.providerDisplayName}
        providerApiKeyLabel={props.providerApiKeyLabel}
        updateUsageScheduleCurrency={props.updateUsageScheduleCurrency}
        setUsageScheduleCurrencyMenu={props.setUsageScheduleCurrencyMenu}
        parsePositiveAmount={props.parsePositiveAmount}
        convertCurrencyToUsd={props.convertCurrencyToUsd}
        configProviders={props.config?.providers ?? {}}
        linkedProvidersForApiKey={props.linkedProvidersForApiKey}
        buildNewScheduleDraft={props.buildNewScheduleDraft}
        readPreferredCurrency={props.readPreferredCurrency}
        fxRatesByCurrency={props.fxRatesByCurrency}
      />

      <CodexSwapModal
        open={props.codexSwapModalOpen}
        dir1={props.codexSwapDir1}
        dir2={props.codexSwapDir2}
        applyBoth={props.codexSwapApplyBoth}
        onChangeDir1={(v) => {
          props.setCodexSwapDir1(v)
          const d1 = v.trim()
          const d2 = props.codexSwapDir2.trim()
          if (d1 && d2 && props.normalizePathForCompare(d1) === props.normalizePathForCompare(d2)) {
            props.setCodexSwapApplyBoth(false)
          }
        }}
        onChangeDir2={(v) => {
          props.setCodexSwapDir2(v)
          if (!v.trim()) props.setCodexSwapApplyBoth(false)
          const d1 = props.codexSwapDir1.trim()
          const d2 = v.trim()
          if (d1 && d2 && props.normalizePathForCompare(d1) === props.normalizePathForCompare(d2)) {
            props.setCodexSwapApplyBoth(false)
          }
        }}
        onChangeApplyBoth={(v) => {
          const d1 = props.codexSwapDir1.trim()
          const d2 = props.codexSwapDir2.trim()
          if (v && d1 && d2 && props.normalizePathForCompare(d1) === props.normalizePathForCompare(d2)) {
            props.flashToast('Dir 2 must be different from Dir 1', 'error')
            props.setCodexSwapApplyBoth(false)
            return
          }
          props.setCodexSwapApplyBoth(v)
        }}
        onCancel={() => props.setCodexSwapModalOpen(false)}
        onApply={() => {
          void (async () => {
            try {
              const dir1 = props.codexSwapDir1.trim()
              const dir2 = props.codexSwapDir2.trim()
              if (!dir1) throw new Error('Dir 1 is required')
              if (props.codexSwapApplyBoth && !dir2) throw new Error('Dir 2 is empty')
              if (
                props.codexSwapApplyBoth &&
                dir2 &&
                props.normalizePathForCompare(dir1) === props.normalizePathForCompare(dir2)
              ) {
                throw new Error('Dir 2 must be different from Dir 1')
              }

              const homes = props.resolveCliHomes(dir1, dir2, props.codexSwapApplyBoth)
              await props.toggleCodexSwap(homes)
              props.setCodexSwapModalOpen(false)
            } catch (e) {
              props.flashToast(String(e), 'error')
            }
          })()
        }}
      />
    </>
  )
}
