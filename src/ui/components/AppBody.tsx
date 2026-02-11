import { invoke } from '@tauri-apps/api/core'

import type { Config, ProviderSwitchboardStatus, Status } from '../types'
import { AppHeader } from './AppHeader'
import { DashboardPage } from './DashboardPage'
import { ProviderSwitchboardPage } from './ProviderSwitchboardPage'
import { UsageProviderStatsCard } from './UsageProviderStatsCard'
import { UsageSummaryPanel } from './UsageSummaryPanel'
import { UsageTimelineCard } from './UsageTimelineCard'

type TopPage = 'dashboard' | 'usage_statistics' | 'provider_switchboard'

type Props = {
  containerRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  mainAreaRef: React.RefObject<HTMLDivElement | null>
  toast: string
  activePage: TopPage
  switchPage: (next: TopPage) => void
  setInstructionModalOpen: (open: boolean) => void
  usageWindowHours: number
  usageStatisticsLoading: boolean
  usageFilterProviders: string[]
  usageProviderFilterOptions: string[]
  usageFilterModels: string[]
  usageModelFilterOptions: string[]
  usageAnomalyMessages: string[]
  usageSummary: any
  usageTopModel: any
  usageDedupedTotalUsedUsd: number | null
  usageTotalInputTokens: number
  usageTotalOutputTokens: number
  usageAvgTokensPerRequest: number
  usageActiveWindowHours: number
  usagePricedRequestCount: number
  usagePricedCoveragePct: number
  usageAvgRequestsPerHour: number
  usageAvgTokensPerHour: number
  usageWindowLabel: string
  usageGeneratedAtUnixMs?: number
  setUsageWindowHours: (hours: number) => void
  setUsageFilterProviders: (providers: string[]) => void
  toggleUsageProviderFilter: (name: string) => void
  setUsageFilterModels: (models: string[]) => void
  toggleUsageModelFilter: (name: string) => void
  fmtKpiTokens: (value: number | null | undefined) => string
  fmtUsdMaybe: (value: number | null | undefined) => string
  fmtWhen: (unixMs: number) => string
  usageChart: any
  usageChartHover: any
  setUsageChartHover: (hover: any) => void
  showUsageChartHover: (event: any, bucketUnixMs: number, requests: number, totalTokens: number) => void
  fmtUsageBucketLabel: (unixMs: number) => string
  usageByProvider: any[]
  usageProviderDisplayGroups: any[]
  usageProviderShowDetails: boolean
  usageAnomalyRowKeys: Set<string>
  usageProviderTotalsAndAverages: any
  usageScheduleProviderOptions: string[]
  config: Config | null
  openUsageScheduleModal: (providerName: string, defaultCurrency: string) => Promise<void>
  providerPreferredCurrency: (providerName: string) => string
  setUsageProviderShowDetails: (next: (prev: boolean) => boolean) => void
  usageProviderRowKey: (row: any) => string
  fmtPricingSource: (source?: string | null) => string
  setUsageHistoryModalOpen: (open: boolean) => void
  setUsagePricingModalOpen: (open: boolean) => void
  switchboardModeLabel: string
  switchboardModelProviderLabel: string
  switchboardTargetDirsLabel: string
  providerSwitchStatus: ProviderSwitchboardStatus | null
  providerSwitchBusy: boolean
  switchboardProviderCards: any[]
  setProviderSwitchTarget: (mode: 'gateway' | 'official' | 'provider', providerName?: string) => Promise<void>
  setCodexSwapModalOpen: (open: boolean) => void
  status: Status | null
  providers: string[]
  gatewayTokenPreview: string
  codexRefreshing: boolean
  override: string
  refreshingProviders: Record<string, boolean>
  clientSessions: Status['client_sessions'] | null
  updatingSessionPref: Record<string, boolean>
  visibleEvents: Status['recent_events']
  canClearErrors: boolean
  codexSwapBadge: { badgeText: string; badgeTitle: string }
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  setGatewayModalOpen: (open: boolean) => void
  setGatewayTokenReveal: (token: string) => void
  refreshStatus: () => Promise<void>
  setCodexRefreshing: (refreshing: boolean) => void
  resolveCliHomes: (dir1: string, dir2: string, applyBoth: boolean) => string[]
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapApplyBoth: boolean
  toggleCodexSwap: (homes: string[]) => Promise<void>
  setOverride: (next: string) => void
  overrideDirtyRef: React.MutableRefObject<boolean>
  applyOverride: (next: string) => Promise<void>
  setPreferred: (next: string) => Promise<void>
  refreshQuota: (name: string) => Promise<void>
  setSessionPreferred: (sessionId: string, provider: string | null) => Promise<void>
  clearErrors: () => void | Promise<void>
  setConfigModalOpen: (open: boolean) => void
}

const USAGE_PROVIDER_SHOW_DETAILS_KEY = 'ao.usage.provider.showDetails.v1'

export function AppBody(props: Props) {
  const {
    containerRef,
    contentRef,
    mainAreaRef,
    toast,
    activePage,
    switchPage,
    setInstructionModalOpen,
  } = props

  return (
    <div className="aoRoot" ref={containerRef}>
      <div className="aoScale">
        <div className="aoShell" ref={contentRef}>
          {toast ? (
            <div className="aoToast" role="status" aria-live="polite">
              {toast}
            </div>
          ) : null}
          <AppHeader activePage={activePage} onSwitchPage={switchPage} onOpenInstruction={() => setInstructionModalOpen(true)} />
          <div className={`aoMainArea${activePage === 'dashboard' ? '' : ' aoMainAreaFill'}`} ref={mainAreaRef}>
            {activePage === 'usage_statistics' ? (
              <div className="aoCard aoUsageStatsPage">
                <UsageSummaryPanel
                  usageWindowHours={props.usageWindowHours}
                  usageStatisticsLoading={props.usageStatisticsLoading}
                  usageFilterProviders={props.usageFilterProviders}
                  usageProviderFilterOptions={props.usageProviderFilterOptions}
                  usageFilterModels={props.usageFilterModels}
                  usageModelFilterOptions={props.usageModelFilterOptions}
                  usageAnomalyMessages={props.usageAnomalyMessages}
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
                  usageGeneratedAtUnixMs={props.usageGeneratedAtUnixMs}
                  onSetWindowHours={props.setUsageWindowHours}
                  onSetFilterProviders={props.setUsageFilterProviders}
                  onToggleProviderFilter={props.toggleUsageProviderFilter}
                  onSetFilterModels={props.setUsageFilterModels}
                  onToggleModelFilter={props.toggleUsageModelFilter}
                  fmtKpiTokens={props.fmtKpiTokens}
                  fmtUsdMaybe={props.fmtUsdMaybe}
                  fmtWhen={props.fmtWhen}
                />
                <UsageTimelineCard
                  usageChart={props.usageChart}
                  usageChartHover={props.usageChartHover}
                  usageSummaryTotalRequests={props.usageSummary?.total_requests ?? 0}
                  onClearHover={() => props.setUsageChartHover(null)}
                  onPointHover={props.showUsageChartHover}
                  fmtUsageBucketLabel={props.fmtUsageBucketLabel}
                />
                <UsageProviderStatsCard
                  usageByProviderLength={props.usageByProvider.length}
                  usageProviderDisplayGroups={props.usageProviderDisplayGroups}
                  usageProviderShowDetails={props.usageProviderShowDetails}
                  usageAnomalyRowKeys={props.usageAnomalyRowKeys}
                  usageProviderTotalsAndAverages={props.usageProviderTotalsAndAverages}
                  usageScheduleProviderOptionsLength={props.usageScheduleProviderOptions.length}
                  onOpenHistory={() => props.setUsageHistoryModalOpen(true)}
                  onOpenPricing={() => props.setUsagePricingModalOpen(true)}
                  onOpenSchedule={() => {
                    const providerName =
                      props.usageScheduleProviderOptions.find(
                        (name) => props.config?.providers?.[name]?.manual_pricing_mode === 'package_total',
                      ) ??
                      props.usageScheduleProviderOptions[0] ??
                      props.usageByProvider[0]?.provider
                    if (!providerName) return
                    void props.openUsageScheduleModal(providerName, props.providerPreferredCurrency(providerName))
                  }}
                  onToggleDetails={() => {
                    props.setUsageProviderShowDetails((previous) => {
                      const next = !previous
                      if (typeof window !== 'undefined') {
                        window.localStorage.setItem(USAGE_PROVIDER_SHOW_DETAILS_KEY, next ? '1' : '0')
                      }
                      return next
                    })
                  }}
                  usageProviderRowKey={props.usageProviderRowKey}
                  fmtUsdMaybe={props.fmtUsdMaybe}
                  fmtPricingSource={props.fmtPricingSource}
                />
              </div>
            ) : activePage === 'provider_switchboard' ? (
              <ProviderSwitchboardPage
                switchboardModeLabel={props.switchboardModeLabel}
                switchboardModelProviderLabel={props.switchboardModelProviderLabel}
                switchboardTargetDirsLabel={props.switchboardTargetDirsLabel}
                providerSwitchStatus={props.providerSwitchStatus}
                providerSwitchBusy={props.providerSwitchBusy}
                switchboardProviderCards={props.switchboardProviderCards}
                onSwitchTarget={(mode, providerName) => void props.setProviderSwitchTarget(mode, providerName)}
                onOpenConfigureDirs={() => props.setCodexSwapModalOpen(true)}
              />
            ) : !props.status ? (
              <div className="aoHint">Loading...</div>
            ) : (
              <DashboardPage
                status={props.status}
                config={props.config}
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
                onCopyToken={() => {
                  void (async () => {
                    try {
                      const token = await invoke<string>('get_gateway_token')
                      await navigator.clipboard.writeText(token)
                      props.flashToast('Gateway token copied')
                    } catch (error) {
                      props.flashToast(String(error), 'error')
                    }
                  })()
                }}
                onShowRotate={() => {
                  props.setGatewayModalOpen(true)
                  props.setGatewayTokenReveal('')
                }}
                onLoginLogout={() => {
                  void (async () => {
                    try {
                      if (props.status?.codex_account?.signed_in) {
                        await invoke('codex_account_logout')
                        props.flashToast('Codex logged out')
                      } else {
                        await invoke('codex_account_login')
                        props.flashToast('Codex login opened in browser')
                      }
                    } catch (error) {
                      props.flashToast(String(error), 'error')
                    }
                  })()
                }}
                onRefreshCodex={() => {
                  void (async () => {
                    props.flashToast('Checking...')
                    props.setCodexRefreshing(true)
                    try {
                      await invoke('codex_account_refresh')
                      await props.refreshStatus()
                    } catch (error) {
                      props.flashToast(String(error), 'error')
                    } finally {
                      props.setCodexRefreshing(false)
                    }
                  })()
                }}
                onSwapAuthConfig={() => {
                  void (async () => {
                    try {
                      const homes = props.resolveCliHomes(props.codexSwapDir1, props.codexSwapDir2, props.codexSwapApplyBoth)
                      await props.toggleCodexSwap(homes)
                    } catch (error) {
                      props.flashToast(String(error), 'error')
                    }
                  })()
                }}
                onSwapOptions={() => props.setCodexSwapModalOpen(true)}
                onOverrideChange={(next) => {
                  props.setOverride(next)
                  props.overrideDirtyRef.current = true
                  void props.applyOverride(next)
                }}
                onPreferredChange={(next) => void props.setPreferred(next)}
                onRefreshQuota={(name) => void props.refreshQuota(name)}
                onSetSessionPreferred={(sessionId, provider) => void props.setSessionPreferred(sessionId, provider)}
                onClearErrors={props.clearErrors}
                onOpenConfig={() => props.setConfigModalOpen(true)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
