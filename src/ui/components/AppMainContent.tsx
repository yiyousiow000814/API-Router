import { DashboardPanel } from './DashboardPanel'
import { EventLogPanel, type EventLogFocusRequest } from './EventLogPanel'
import { ProviderSwitchboardPanel } from './ProviderSwitchboardPanel'
import { UsageAnalyticsPanel } from './UsageAnalyticsPanel'
import { UsageRequestsPanel } from './UsageRequestsPanel'
import { WebCodexPanel } from './WebCodexPanel'
import type { LastErrorJump } from './ProvidersTable'

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
  if (activePage === 'usage_statistics') {
    return <UsageAnalyticsPanel usageProps={usageProps} />
  }

  if (activePage === 'usage_requests') {
    return <UsageRequestsPanel usageProps={usageProps} />
  }

  if (activePage === 'provider_switchboard') {
    return <ProviderSwitchboardPanel {...switchboardProps} />
  }

  if (activePage === 'event_log') {
    return (
      <EventLogPanel
        events={eventLogSeedEvents}
        dailyStatsSeed={eventLogSeedDailyStats}
        focusRequest={eventLogFocusRequest}
        onFocusRequestHandled={onEventLogFocusRequestHandled}
      />
    )
  }

  if (activePage === 'web_codex') {
    return <WebCodexPanel listenPort={status?.listen?.port} />
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
