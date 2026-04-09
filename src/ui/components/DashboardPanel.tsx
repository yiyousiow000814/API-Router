import { useEffect, useState } from 'react'
import { HeroCodexCard, HeroRoutingCard, HeroStatusCard } from './HeroCards'
import { DashboardProvidersSection } from './DashboardProvidersSection'
import { DashboardSessionsSection } from './DashboardSessionsSection'
import { LoadingSurface } from './LoadingSurface'
import type { LastErrorJump } from './ProvidersTable'
import type { Config, Status, UsageStatisticsOverview } from '../types'
import './DashboardPanel.css'

type Props = {
  status: Status
  config: Config | null
  providers: string[]
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
  onRefreshQuota: (provider: string) => void
  onOpenLastErrorInEventLog: (payload: LastErrorJump) => void
  usageOverview?: UsageStatisticsOverview | null
  clientSessions: NonNullable<Status['client_sessions']>
  updatingSessionPref: Record<string, boolean>
  onSetSessionPreferred: (sessionId: string, provider: string | null) => void
}

export function DashboardPanel({
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
  onOpenLastErrorInEventLog,
  usageOverview,
  clientSessions,
  updatingSessionPref,
  onSetSessionPreferred,
}: Props) {
  const [showDeferredSections, setShowDeferredSections] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timeoutId: number | null = null
    let idleId: number | null = null
    const rafId = window.requestAnimationFrame(() => {
      const reveal = () => {
        if (cancelled) return
        setShowDeferredSections(true)
      }
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(reveal, { timeout: 900 })
        return
      }
      timeoutId = window.setTimeout(reveal, 90)
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(rafId)
      if (idleId != null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId)
      }
      if (timeoutId != null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [])

  return (
    <>
      <div className='aoHero'>
        <HeroStatusCard
          status={status}
          gatewayTokenPreview={gatewayTokenPreview}
          onCopyToken={onCopyToken}
          onShowRotate={onShowGatewayRotate}
        />
        <HeroCodexCard
          status={status}
          onLoginLogout={onCodexLoginLogout}
          onRefresh={onCodexRefresh}
          refreshing={codexRefreshing}
          onSwapAuthConfig={onCodexSwapAuthConfig}
          onSwapOptions={onOpenCodexSwapOptions}
          swapTarget={codexSwapTarget}
          swapTargetWindowsEnabled={codexSwapUseWindows}
          swapTargetWslEnabled={codexSwapUseWsl}
          onChangeSwapTarget={onChangeCodexSwapTarget}
          swapBadgeText={codexSwapBadgeText}
          swapBadgeTitle={codexSwapBadgeTitle}
        />
        <HeroRoutingCard
          config={config}
          providers={providers}
          routeMode={routeMode}
          onRouteModeChange={onRouteModeChange}
          override={override}
          onOverrideChange={onOverrideChange}
          onPreferredChange={onPreferredChange}
        />
      </div>

      {showDeferredSections ? (
        <>
          <DashboardProvidersSection
            providers={providers}
            status={status}
            config={config}
            refreshingProviders={refreshingProviders}
            onRefreshQuota={onRefreshQuota}
            onOpenConfigModal={onOpenConfigModal}
            onOpenLastErrorInEventLog={onOpenLastErrorInEventLog}
            usageOverview={usageOverview ?? null}
          />

          <DashboardSessionsSection
            clientSessions={clientSessions}
            providers={providers}
            globalPreferred={status.preferred_provider}
            routeMode={routeMode}
            wslGatewayHost={status.wsl_gateway_host}
            updatingSessionPref={updatingSessionPref}
            onSetSessionPreferred={onSetSessionPreferred}
          />
        </>
      ) : (
        <LoadingSurface
          compact
          eyebrow="Dashboard"
          title="Finishing the control surface"
          detail="Provider tables and session routing controls are loading in the background."
        />
      )}
    </>
  )
}
