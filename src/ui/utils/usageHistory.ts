import type { SpendHistoryRow } from '../types'

export type UsageHistoryDraft = {
  effectiveText: string
  perReqText: string
}

export function historyEffectiveDisplayValue(row: SpendHistoryRow): number | null {
  if (row.effective_total_usd != null && Number.isFinite(row.effective_total_usd) && row.effective_total_usd > 0) {
    return row.effective_total_usd
  }
  const tracked = row.tracked_total_usd ?? 0
  const scheduled = row.scheduled_total_usd ?? 0
  const manual = row.manual_total_usd ?? 0
  const total = tracked + scheduled + manual
  return total > 0 ? total : null
}

export function historyPerReqDisplayValue(row: SpendHistoryRow): number | null {
  if (row.effective_usd_per_req != null && Number.isFinite(row.effective_usd_per_req) && row.effective_usd_per_req > 0) {
    return row.effective_usd_per_req
  }
  if (row.manual_usd_per_req != null && Number.isFinite(row.manual_usd_per_req) && row.manual_usd_per_req > 0) {
    return row.manual_usd_per_req
  }
  return null
}

export function historyDraftFromRow(
  row: SpendHistoryRow,
  formatDraftAmount: (value: number) => string,
): UsageHistoryDraft {
  const effective = historyEffectiveDisplayValue(row)
  const perReq = historyPerReqDisplayValue(row)
  return {
    effectiveText: effective != null ? formatDraftAmount(effective) : '',
    perReqText: perReq != null ? formatDraftAmount(perReq) : '',
  }
}

export function fmtHistorySource(source?: string | null): string {
  if (!source || source === 'none') return 'none'
  if (source === 'manual_per_request' || source === 'manual_total') return 'manual'
  if (source === 'tracked+manual_per_request' || source === 'tracked+manual_total') return 'tracked+manual'
  if (source === 'scheduled_package_total') return 'scheduled'
  return source
}
