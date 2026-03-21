import { lazy, Suspense } from 'react'
import { DashboardPanel } from './DashboardPanel'
import type { EventLogFocusRequest } from './EventLogPanel'
import type { LastErrorJump } from './ProvidersTable'

const EventLogPanel = lazy(async () => {
  const module = await import('./EventLogPanel')
  return { default: module.EventLogPanel }
})

const ProviderSwitchboardPanel = lazy(async () => {
  const module = await import('./ProviderSwitchboardPanel')
  return { default: module.ProviderSwitchboardPanel }
})

const UsageAnalyticsPanel = lazy(async () => {
  const module = await import('./UsageAnalyticsPanel')
  return { default: module.UsageAnalyticsPanel }
})

const UsageRequestsPanel = lazy(async () => {
  const module = await import('./UsageRequestsPanel')
  return { default: module.UsageRequestsPanel }
})

const WebCodexPanel = lazy(async () => {
  const module = await import('./WebCodexPanel')
  return { default: module.WebCodexPanel }
})

type Props = {
  activePage: 'dashboard' | 'usage_statistics' | 'usage_requests' | 'provider_switchboard' | 'event_log' | 'web_codex'
  status: any
  config: any
  providers: any[]
  gatewayTokenPreview: string
  onCopyToken: () => void
  onShowGatewayRotate: () => void
  onCodexLoginLogout: () => void
  onCodexRefresh: () => void
  codexRefreshing: boolean
  onCodexSwapAuthConfig: () => void
  onOpenCodexSwapOptions: () => void
  codexSwapTarget: 'windows' | 'wsl2' | 'both'
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  onChangeCodexSwapTarget: (target: 'windows' | 'wsl2' | 'both') => void
  codexSwapBadgeText: string
  codexSwapBadgeTitle: string
  routeMode: 'follow_preferred_auto' | 'balanced_auto'
  onRouteModeChange: (next: 'follow_preferred_auto' | 'balanced_auto') => Promise<boolean>
  override: string
  onOverrideChange: (next: string) => Promise<boolean>
  onPreferredChange: (next: string) => void
  onOpenConfigModal: () => void
  refreshingProviders: Record<string, boolean>
  onRefreshQuota: (name: string) => void
  clientSessions: any[]
  updatingSessionPref: Record<string, boolean>
  onSetSessionPreferred: (sessionId: string, provider: string | null) => void
  onOpenLastErrorInEventLog: (payload: LastErrorJump) => void
  eventLogSeedEvents: any[]
  eventLogSeedDailyStats: any[]
  eventLogFocusRequest: EventLogFocusRequest | null
  onEventLogFocusRequestHandled: (nonce: number) => void
  usageProps: any
  switchboardProps: any
  usageStatistics?: any
}

export function AppMainContent(props: Props) {
  const {
    activePage,
    status,
    config,
    providers,
    gatewayTokenPreview,
    onCopyToken,
    onShowGatewayRotate,
    onCodexLoginLogout,
    onCodexRefresh,
    codexRefreshing,
    onCodexSwapAuthConfig,
    onOpenCodexSwapOptions,
    codexSwapTarget,
    codexSwapUseWindows,
    codexSwapUseWsl,
    onChangeCodexSwapTarget,
    codexSwapBadgeText,
    codexSwapBadgeTitle,
    routeMode,
    onRouteModeChange,
    override,
    onOverrideChange,
    onPreferredChange,
    onOpenConfigModal,
    refreshingProviders,
    onRefreshQuota,
    clientSessions,
    updatingSessionPref,
    onSetSessionPreferred,
    onOpenLastErrorInEventLog,
    eventLogSeedEvents,
    eventLogSeedDailyStats,
    eventLogFocusRequest,
    onEventLogFocusRequestHandled,
    usageProps,
    switchboardProps,
    usageStatistics,
  } = props
  const pageFallback = <div className="aoHint">Loading...</div>
  if (activePage === 'usage_statistics') {
    return (
      <Suspense fallback={pageFallback}>
        <UsageAnalyticsPanel usageProps={usageProps} />
      </Suspense>
    )
  }

  if (activePage === 'usage_requests') {
    return (
      <Suspense fallback={pageFallback}>
        <UsageRequestsPanel usageProps={usageProps} />
      </Suspense>
    )
  }

  if (activePage === 'provider_switchboard') {
    return (
      <Suspense fallback={pageFallback}>
        <ProviderSwitchboardPanel {...switchboardProps} />
      </Suspense>
    )
  }

  if (activePage === 'event_log') {
    return (
      <Suspense fallback={pageFallback}>
        <EventLogPanel
          events={eventLogSeedEvents}
          dailyStatsSeed={eventLogSeedDailyStats}
          focusRequest={eventLogFocusRequest}
          onFocusRequestHandled={onEventLogFocusRequestHandled}
        />
      </Suspense>
    )
  }

  if (activePage === 'web_codex') {
    return (
      <Suspense fallback={pageFallback}>
        <WebCodexPanel listenPort={status?.listen?.port} />
      </Suspense>
    )
  }

  if (!status) {
    return <div className="aoHint">Loading...</div>
  }

  return (
    <>
      <DashboardPanel
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
        onChangeCodexSwapTarget={onChangeCodexSwapTarget}
        codexSwapBadgeText={codexSwapBadgeText}
        codexSwapBadgeTitle={codexSwapBadgeTitle}
        routeMode={routeMode}
        onRouteModeChange={onRouteModeChange}
        override={override}
        onOverrideChange={onOverrideChange}
        onPreferredChange={onPreferredChange}
        onOpenConfigModal={onOpenConfigModal}
        refreshingProviders={refreshingProviders}
        onRefreshQuota={onRefreshQuota}
        onOpenLastErrorInEventLog={onOpenLastErrorInEventLog}
        usageStatistics={usageStatistics}
        clientSessions={clientSessions ?? []}
        updatingSessionPref={updatingSessionPref}
        onSetSessionPreferred={onSetSessionPreferred}
      />
    </>
  )
}
