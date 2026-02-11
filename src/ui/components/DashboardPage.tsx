import type { Config, Status } from '../types'
import { EventsTable } from './EventsTable'
import { HeroCodexCard, HeroRoutingCard, HeroStatusCard } from './HeroCards'
import { ProvidersTable } from './ProvidersTable'
import { SessionsTable } from './SessionsTable'

type Props = {
  status: Status
  config: Config | null
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
  onCopyToken: () => void
  onShowRotate: () => void
  onLoginLogout: () => void
  onRefreshCodex: () => void
  onSwapAuthConfig: () => void
  onSwapOptions: () => void
  onOverrideChange: (next: string) => void
  onPreferredChange: (next: string) => void
  onRefreshQuota: (provider: string) => void
  onSetSessionPreferred: (sessionId: string, provider: string | null) => void
  onClearErrors: () => void
  onOpenConfig: () => void
}

export function DashboardPage({
  status,
  config,
  providers,
  gatewayTokenPreview,
  codexRefreshing,
  override,
  refreshingProviders,
  clientSessions,
  updatingSessionPref,
  visibleEvents,
  canClearErrors,
  codexSwapBadge,
  onCopyToken,
  onShowRotate,
  onLoginLogout,
  onRefreshCodex,
  onSwapAuthConfig,
  onSwapOptions,
  onOverrideChange,
  onPreferredChange,
  onRefreshQuota,
  onSetSessionPreferred,
  onClearErrors,
  onOpenConfig,
}: Props) {
  return (
    <>
      <div className="aoHero">
        <HeroStatusCard
          status={status}
          gatewayTokenPreview={gatewayTokenPreview}
          onCopyToken={onCopyToken}
          onShowRotate={onShowRotate}
        />
        <HeroCodexCard
          status={status}
          onLoginLogout={onLoginLogout}
          onRefresh={onRefreshCodex}
          refreshing={codexRefreshing}
          onSwapAuthConfig={onSwapAuthConfig}
          onSwapOptions={onSwapOptions}
          swapBadgeText={codexSwapBadge.badgeText}
          swapBadgeTitle={codexSwapBadge.badgeTitle}
        />
        <HeroRoutingCard
          config={config}
          providers={providers}
          override={override}
          onOverrideChange={onOverrideChange}
          onPreferredChange={onPreferredChange}
        />
      </div>

      <div className="aoSection">
        <div className="aoSectionHeader aoSectionHeaderStack">
          <div className="aoRow">
            <h3 className="aoH3">Providers</h3>
            <button className="aoIconGhost" title="Config" aria-label="Config" onClick={onOpenConfig}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
              </svg>
            </button>
          </div>
        </div>
        <ProvidersTable
          providers={providers}
          status={status}
          refreshingProviders={refreshingProviders}
          onRefreshQuota={onRefreshQuota}
        />
      </div>

      <div className="aoSection">
        <div className="aoSectionHeader">
          <div className="aoRow">
            <h3 className="aoH3">Sessions</h3>
          </div>
        </div>
        <SessionsTable
          sessions={clientSessions ?? []}
          providers={providers}
          globalPreferred={status.preferred_provider}
          updating={updatingSessionPref}
          onSetPreferred={onSetSessionPreferred}
        />
      </div>

      <div className="aoSection">
        <div className="aoSectionHeader">
          <div className="aoRow">
            <h3 className="aoH3">Events</h3>
          </div>
        </div>
        <EventsTable events={visibleEvents} canClearErrors={canClearErrors} onClearErrors={onClearErrors} />
      </div>
    </>
  )
}
