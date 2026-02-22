import { fmtWhen } from '../utils/format'
import { UsageStatisticsPanel } from './UsageStatisticsPanel'

type Props = {
  usageProps: any
}

export function UsageRequestsPanel({ usageProps }: Props) {
  return (
    <UsageStatisticsPanel
      {...usageProps}
      fmtWhen={fmtWhen}
      forceDetailsTab="requests"
      showFilters={false}
    />
  )
}

