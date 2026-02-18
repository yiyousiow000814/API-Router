import { HeroCodexCard, HeroRoutingCard, HeroStatusCard } from './HeroCards'
import { DashboardProvidersSection } from './DashboardProvidersSection'
import { DashboardSessionsSection } from './DashboardSessionsSection'
import type { LastErrorJump } from './ProvidersTable'
import type { Config, Status } from '../types'
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
  override: string
  onOverrideChange: (next: string) => void
  onPreferredChange: (next: string) => void
  onOpenConfigModal: () => void
  refreshingProviders: Record<string, boolean>
  onRefreshQuota: (provider: string) => void
  onOpenLastErrorInEventLog: (payload: LastErrorJump) => void
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
  override,
  onOverrideChange,
  onPreferredChange,
  onOpenConfigModal,
  refreshingProviders,
  onRefreshQuota,
  onOpenLastErrorInEventLog,
  clientSessions,
  updatingSessionPref,
  onSetSessionPreferred,
}: Props) {
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
          override={override}
          onOverrideChange={onOverrideChange}
          onPreferredChange={onPreferredChange}
        />
      </div>

      <DashboardProvidersSection
        providers={providers}
        status={status}
        refreshingProviders={refreshingProviders}
        onRefreshQuota={onRefreshQuota}
        onOpenConfigModal={onOpenConfigModal}
        onOpenLastErrorInEventLog={onOpenLastErrorInEventLog}
      />

      <DashboardSessionsSection
        clientSessions={clientSessions}
        providers={providers}
        globalPreferred={status.preferred_provider}
        wslGatewayHost={status.wsl_gateway_host}
        updatingSessionPref={updatingSessionPref}
        onSetSessionPreferred={onSetSessionPreferred}
      />
    </>
  )
}
