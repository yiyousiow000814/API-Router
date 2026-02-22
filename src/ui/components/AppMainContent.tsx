import { DashboardPanel } from './DashboardPanel'
import { EventLogPanel, type EventLogFocusRequest } from './EventLogPanel'
import { ProviderSwitchboardPanel } from './ProviderSwitchboardPanel'
import { UsageAnalyticsPanel } from './UsageAnalyticsPanel'
import { UsageRequestsPanel } from './UsageRequestsPanel'
import type { LastErrorJump } from './ProvidersTable'

type Props = {
  activePage: 'dashboard' | 'usage_statistics' | 'usage_requests' | 'provider_switchboard' | 'event_log'
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
  override: string
  onOverrideChange: (next: string) => void
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
        override={override}
        onOverrideChange={onOverrideChange}
        onPreferredChange={onPreferredChange}
        onOpenConfigModal={onOpenConfigModal}
        refreshingProviders={refreshingProviders}
        onRefreshQuota={onRefreshQuota}
        onOpenLastErrorInEventLog={onOpenLastErrorInEventLog}
        clientSessions={clientSessions ?? []}
        updatingSessionPref={updatingSessionPref}
        onSetSessionPreferred={onSetSessionPreferred}
      />
    </>
  )
}
