import { fmtWhen } from '../utils/format'
import { UsageStatisticsPanel } from './UsageStatisticsPanel'

type Props = {
  usageProps: any
}

export function UsageAnalyticsPanel({ usageProps }: Props) {
  return (
    <UsageStatisticsPanel
      {...usageProps}
      fmtWhen={fmtWhen}
      forceDetailsTab="analytics"
      showFilters
    />
  )
}

