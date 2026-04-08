import { lazy, memo, Suspense } from 'react'
import { DashboardPanel } from './DashboardPanel'
import type { EventLogFocusRequest } from './EventLogPanel'
import { LoadingSurface } from './LoadingSurface'
import type { LastErrorJump } from './ProvidersTable'

const loadEventLogPanel = async () => {
  const module = await import('./EventLogPanel')
  return { default: module.EventLogPanel }
}

const loadProviderSwitchboardPanel = async () => {
  const module = await import('./ProviderSwitchboardPanel')
  return { default: module.ProviderSwitchboardPanel }
}

const loadUsageAnalyticsPanel = async () => {
  const module = await import('./UsageAnalyticsPanel')
  return { default: module.UsageAnalyticsPanel }
}

const loadUsageRequestsPanel = async () => {
  const module = await import('./UsageRequestsPanel')
  return { default: module.UsageRequestsPanel }
}

const loadWebCodexPanel = async () => {
  const module = await import('./WebCodexPanel')
  return { default: module.WebCodexPanel }
}

const EventLogPanel = lazy(loadEventLogPanel)
const ProviderSwitchboardPanel = lazy(loadProviderSwitchboardPanel)
const UsageAnalyticsPanel = lazy(loadUsageAnalyticsPanel)
const UsageRequestsPanel = lazy(loadUsageRequestsPanel)
const WebCodexPanel = lazy(loadWebCodexPanel)

let preloadAppMainContentModulesPromise: Promise<unknown> | null = null

export function preloadAppMainContentModules(): Promise<unknown> {
  if (preloadAppMainContentModulesPromise) {
    return preloadAppMainContentModulesPromise
  }
  preloadAppMainContentModulesPromise = Promise.allSettled([
    loadUsageAnalyticsPanel(),
    loadUsageRequestsPanel(),
  ])
  return preloadAppMainContentModulesPromise
}

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
  usageOverview?: any
}

function pageFallbackFor(activePage: Props['activePage']) {
  if (activePage === 'usage_statistics') {
    return (
      <div className="aoUsageStatsWrap">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Provider Statistics</div>
        </div>
        <LoadingSurface
          compact
          eyebrow="Analytics"
          title="Loading provider statistics"
          detail="Preparing usage charts and aggregated cost signals."
        />
      </div>
    )
  }
  if (activePage === 'usage_requests') {
    return (
      <div className="aoUsageStatsWrap">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Request Details</div>
        </div>
        <LoadingSurface
          compact
          eyebrow="Requests"
          title="Loading request history"
          detail="Preparing the latest request timeline, filters, and per-session breakdowns."
        />
      </div>
    )
  }
  if (activePage === 'provider_switchboard') {
    return (
      <div className="aoPagePlaceholder">
        <div className="aoPagePlaceholderTitle">Provider Switchboard</div>
        <LoadingSurface
          compact
          eyebrow="Switchboard"
          title="Loading provider switchboard"
          detail="Restoring provider target snapshots and Codex home routing state."
        />
      </div>
    )
  }
  if (activePage === 'event_log') {
    return (
      <div className="aoEventLogWrap">
        <div className="aoH3">Event Log</div>
        <LoadingSurface
          compact
          eyebrow="Events"
          title="Loading event log"
          detail="Preparing the latest events, daily counts, and focus state."
        />
      </div>
    )
  }
  return (
    <LoadingSurface
      compact
      eyebrow="API Router"
      title="Loading this view"
      detail="Fetching the data and modules needed for this page."
    />
  )
}

function AppMainContentInner(props: Props) {
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
    usageOverview,
  } = props
  const pageFallback = pageFallbackFor(activePage)
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
    return (
      <LoadingSurface
        compact
        eyebrow="Dashboard"
        title="Preparing live status"
        detail="Waiting for the latest gateway state before rendering the dashboard."
      />
    )
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
        usageOverview={usageOverview}
        clientSessions={clientSessions ?? []}
        updatingSessionPref={updatingSessionPref}
        onSetSessionPreferred={onSetSessionPreferred}
      />
    </>
  )
}

function areEqualAppMainContentProps(prev: Props, next: Props): boolean {
  if (prev.activePage !== next.activePage) return false
  switch (next.activePage) {
    case 'usage_statistics':
    case 'usage_requests':
      return prev.usageProps === next.usageProps
    case 'provider_switchboard':
      return prev.switchboardProps === next.switchboardProps
    case 'event_log':
      return (
        prev.eventLogSeedEvents === next.eventLogSeedEvents &&
        prev.eventLogSeedDailyStats === next.eventLogSeedDailyStats &&
        prev.eventLogFocusRequest === next.eventLogFocusRequest &&
        prev.onEventLogFocusRequestHandled === next.onEventLogFocusRequestHandled
      )
    case 'web_codex':
      return prev.status?.listen?.port === next.status?.listen?.port
    case 'dashboard':
    default:
      return (
        prev.status === next.status &&
        prev.config === next.config &&
        prev.providers === next.providers &&
        prev.gatewayTokenPreview === next.gatewayTokenPreview &&
        prev.onCopyToken === next.onCopyToken &&
        prev.onShowGatewayRotate === next.onShowGatewayRotate &&
        prev.onCodexLoginLogout === next.onCodexLoginLogout &&
        prev.onCodexRefresh === next.onCodexRefresh &&
        prev.codexRefreshing === next.codexRefreshing &&
        prev.onCodexSwapAuthConfig === next.onCodexSwapAuthConfig &&
        prev.onOpenCodexSwapOptions === next.onOpenCodexSwapOptions &&
        prev.codexSwapTarget === next.codexSwapTarget &&
        prev.codexSwapUseWindows === next.codexSwapUseWindows &&
        prev.codexSwapUseWsl === next.codexSwapUseWsl &&
        prev.onChangeCodexSwapTarget === next.onChangeCodexSwapTarget &&
        prev.codexSwapBadgeText === next.codexSwapBadgeText &&
        prev.codexSwapBadgeTitle === next.codexSwapBadgeTitle &&
        prev.routeMode === next.routeMode &&
        prev.onRouteModeChange === next.onRouteModeChange &&
        prev.override === next.override &&
        prev.onOverrideChange === next.onOverrideChange &&
        prev.onPreferredChange === next.onPreferredChange &&
        prev.onOpenConfigModal === next.onOpenConfigModal &&
        prev.refreshingProviders === next.refreshingProviders &&
        prev.onRefreshQuota === next.onRefreshQuota &&
        prev.clientSessions === next.clientSessions &&
        prev.updatingSessionPref === next.updatingSessionPref &&
        prev.onSetSessionPreferred === next.onSetSessionPreferred &&
        prev.onOpenLastErrorInEventLog === next.onOpenLastErrorInEventLog &&
        prev.usageOverview === next.usageOverview
      )
  }
}

export const AppMainContent = memo(AppMainContentInner, areEqualAppMainContentProps)
