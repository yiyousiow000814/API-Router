import { ProvidersTable } from './ProvidersTable'
import type { LastErrorJump } from './ProvidersTable'
import type { Config, Status, UsageStatisticsOverview } from '../types'

type Props = {
  providers: string[]
  status: Status
  config: Config | null
  refreshingProviders: Record<string, boolean>
  onRefreshQuota: (provider: string) => void
  onOpenConfigModal: () => void
  onOpenLastErrorInEventLog: (payload: LastErrorJump) => void
  usageOverview: UsageStatisticsOverview | null
}

export function DashboardProvidersSection({
  providers,
  status,
  config,
  refreshingProviders,
  onRefreshQuota,
  onOpenConfigModal,
  onOpenLastErrorInEventLog,
  usageOverview,
}: Props) {
  return (
    <div className="aoSection">
      <div className="aoSectionHeader aoSectionHeaderStack">
        <div className="aoRow">
          <h3 className="aoH3">Providers</h3>
          <button className="aoIconGhost" title="Config" aria-label="Config" onClick={onOpenConfigModal}>
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
        config={config}
        usageStatistics={usageOverview}
        refreshingProviders={refreshingProviders}
        onRefreshQuota={onRefreshQuota}
        onOpenLastErrorInEventLog={onOpenLastErrorInEventLog}
      />
    </div>
  )
}
