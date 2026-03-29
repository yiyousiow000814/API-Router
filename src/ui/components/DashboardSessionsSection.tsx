import { SessionsTable } from './SessionsTable'
import type { Status } from '../types'

type Props = {
  clientSessions: NonNullable<Status['client_sessions']>
  providers: string[]
  globalPreferred: Status['preferred_provider']
  routeMode: 'follow_preferred_auto' | 'balanced_auto'
  wslGatewayHost?: string
  updatingSessionPref: Record<string, boolean>
  onSetSessionPreferred: (sessionId: string, provider: string | null) => void
}

export function DashboardSessionsSection({
  clientSessions,
  providers,
  globalPreferred,
  routeMode,
  wslGatewayHost,
  updatingSessionPref,
  onSetSessionPreferred,
}: Props) {
  return (
    <div className="aoSection">
      <div className="aoSectionHeader">
        <div className="aoRow">
          <h3 className="aoH3">Sessions</h3>
        </div>
      </div>
      <SessionsTable
        sessions={clientSessions}
        providers={providers}
        globalPreferred={globalPreferred}
        routeMode={routeMode}
        wslGatewayHost={wslGatewayHost}
        updating={updatingSessionPref}
        onSetPreferred={onSetSessionPreferred}
      />
    </div>
  )
}
