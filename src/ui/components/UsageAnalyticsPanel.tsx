import { memo } from 'react'
import { fmtWhen } from '../utils/format'
import { UsageStatisticsPanel } from './UsageStatisticsPanel'

type Props = {
  usageProps: any
}

export const UsageAnalyticsPanel = memo(function UsageAnalyticsPanel({ usageProps }: Props) {
  return (
    <UsageStatisticsPanel
      {...usageProps}
      fmtWhen={fmtWhen}
      forceDetailsTab="analytics"
      showFilters
    />
  )
})
