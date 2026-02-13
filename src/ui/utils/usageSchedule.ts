import type { SpendHistoryRow } from '../devMockData'
import type {
  PricingTimelineMode,
  ProviderScheduleDraft,
  ProviderSchedulePeriod,
  ProviderScheduleSaveInput,
  UsageHistoryDraft,
} from '../types/usage'

type ParseScheduleOptions = {
  fromDateTimeLocalValue: (value: string) => number | null
  parsePositiveAmount: (value: string) => number | null
  providerApiKeyLabel: (providerName: string) => string
  convertCurrencyToUsd: (amount: number, currency: string) => number
}

type ScheduleDraftOptions = {
  providerApiKeyLabel: (providerName: string) => string
  readPreferredCurrency: (providerName: string, apiKeyRef?: string) => string
  toDateTimeLocalValue: (unixMs?: number | null) => string
  normalizeCurrencyCode: (code: string) => string
  convertUsdToCurrency: (usdAmount: number, currency: string) => number
  formatDraftAmount: (value: number) => string
}

export function scheduleRowsSignature(
  rows: ProviderScheduleDraft[],
  normalizeCurrencyCode: (code: string) => string,
): string {
  return JSON.stringify(
    rows.map((row) => ({
      provider: row.provider.trim(),
      groupProviders: Array.from(new Set((row.groupProviders ?? []).map((name) => name.trim()).filter(Boolean))).sort(),
      id: row.id.trim(),
      mode: row.mode,
      apiKeyRef: row.apiKeyRef.trim(),
      start: row.startText.trim(),
      end: row.endText.trim(),
      amount: row.amountText.trim(),
      currency: normalizeCurrencyCode(row.currency),
    })),
  )
}

export function scheduleSignaturesByProvider(
  rows: ProviderScheduleDraft[],
  normalizeCurrencyCode: (code: string) => string,
  providerNames?: string[],
): Record<string, string> {
  const grouped: Record<string, ProviderScheduleDraft[]> = {}
  for (const row of rows) {
    const targets = Array.from(
      new Set(
        [row.provider, ...(row.groupProviders ?? [])]
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    )
    if (!targets.length) continue
    targets.forEach((provider) => {
      if (!grouped[provider]) grouped[provider] = []
      grouped[provider].push(row)
    })
  }
  const providers = providerNames?.length ? Array.from(new Set(providerNames)) : Object.keys(grouped)
  const out: Record<string, string> = {}
  providers.forEach((provider) => {
    const providerRows = (grouped[provider] ?? [])
      .map((row) => ({
        id: row.id.trim(),
        mode: row.mode,
        apiKeyRef: row.apiKeyRef.trim(),
        start: row.startText.trim(),
        end: row.endText.trim(),
        amount: row.amountText.trim(),
        currency: normalizeCurrencyCode(row.currency),
      }))
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id))
    out[provider] = JSON.stringify(providerRows)
  })
  return out
}

export function parseScheduleRowsForSave(
  rows: ProviderScheduleDraft[],
  options: ParseScheduleOptions,
): { ok: true; periodsByProvider: Record<string, ProviderScheduleSaveInput[]> } | { ok: false; reason: string } {
  const grouped: Record<string, ProviderScheduleSaveInput[]> = {}
  const dedupeByProvider: Record<string, Set<string>> = {}
  const apiKeyPeriodSet = new Set<string>()

  for (const row of rows) {
    const providers = Array.from(
      new Set(
        [row.provider, ...(row.groupProviders ?? [])]
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    )
    if (!providers.length) return { ok: false, reason: 'provider is required' }
    if (row.mode !== 'package_total' && row.mode !== 'per_request') {
      return { ok: false, reason: 'mode must be monthly fee or $/request' }
    }
    const start = options.fromDateTimeLocalValue(row.startText)
    const end = options.fromDateTimeLocalValue(row.endText)
    const amount = options.parsePositiveAmount(row.amountText)
    if (!start || !amount) {
      return { ok: false, reason: 'complete each row with valid start and amount' }
    }
    if (row.mode === 'package_total' && !end) {
      return { ok: false, reason: 'monthly fee row requires expires time' }
    }
    if (end != null && start >= end) {
      return { ok: false, reason: 'each row start must be earlier than expires' }
    }
    const apiKeyLabel = row.apiKeyRef.trim() || options.providerApiKeyLabel(providers[0])
    const endKey = end == null ? 'open' : String(end)
    const apiKeyPeriodKey = `${apiKeyLabel}|${start}|${endKey}`
    if (apiKeyLabel !== '-' && apiKeyPeriodSet.has(apiKeyPeriodKey)) {
      return { ok: false, reason: `duplicate start/expires for API key ${apiKeyLabel}` }
    }
    apiKeyPeriodSet.add(apiKeyPeriodKey)
    const amountUsd = options.convertCurrencyToUsd(amount, row.currency)
    const dedupeKey = `${row.mode}|${apiKeyLabel}|${start}|${endKey}|${amountUsd.toFixed(8)}`
    providers.forEach((provider) => {
      if (!grouped[provider]) grouped[provider] = []
      if (!dedupeByProvider[provider]) dedupeByProvider[provider] = new Set<string>()
      if (dedupeByProvider[provider].has(dedupeKey)) return
      dedupeByProvider[provider].add(dedupeKey)
      grouped[provider].push({
        id: row.id.trim() || null,
        mode: row.mode,
        amount_usd: amountUsd,
        api_key_ref: apiKeyLabel,
        started_at_unix_ms: start,
        ended_at_unix_ms: end ?? undefined,
      })
    })
  }

  for (const provider of Object.keys(grouped)) {
    const periods = grouped[provider]
    periods.sort((a, b) => a.started_at_unix_ms - b.started_at_unix_ms)
    for (let i = 1; i < periods.length; i += 1) {
      const prevEnd = periods[i - 1].ended_at_unix_ms
      if (prevEnd == null || prevEnd > periods[i].started_at_unix_ms) {
        return { ok: false, reason: `periods overlap for ${provider}` }
      }
    }
  }
  return { ok: true, periodsByProvider: grouped }
}

export function scheduleDraftFromPeriod(
  providerName: string,
  period: ProviderSchedulePeriod,
  options: ScheduleDraftOptions,
  fallbackCurrency?: string,
  groupProviders?: string[],
): ProviderScheduleDraft {
  const apiKeyRef =
    (period.api_key_ref ?? options.providerApiKeyLabel(providerName)).trim() || options.providerApiKeyLabel(providerName)
  const currency = fallbackCurrency
    ? options.normalizeCurrencyCode(fallbackCurrency)
    : options.readPreferredCurrency(providerName, apiKeyRef)
  const mode: PricingTimelineMode = period.mode === 'per_request' ? 'per_request' : 'package_total'
  const fallbackEndMs = mode === 'package_total' ? period.started_at_unix_ms + 30 * 24 * 60 * 60 * 1000 : undefined
  const endMs = period.ended_at_unix_ms ?? fallbackEndMs
  return {
    provider: providerName,
    groupProviders: (groupProviders?.length ? groupProviders : [providerName]).filter(Boolean),
    id: period.id,
    mode,
    apiKeyRef,
    startText: options.toDateTimeLocalValue(period.started_at_unix_ms),
    endText: options.toDateTimeLocalValue(endMs),
    amountText: options.formatDraftAmount(options.convertUsdToCurrency(period.amount_usd, currency)),
    currency,
  }
}

export function newScheduleDraft(
  providerName: string,
  options: ScheduleDraftOptions,
  seedAmountUsd?: number | null,
  seedCurrency?: string,
  seedMode: PricingTimelineMode = 'package_total',
  groupProviders?: string[],
): ProviderScheduleDraft {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
  const end = start + 30 * 24 * 60 * 60 * 1000
  const currency = seedCurrency
    ? options.normalizeCurrencyCode(seedCurrency)
    : options.readPreferredCurrency(providerName, options.providerApiKeyLabel(providerName))
  return {
    provider: providerName,
    groupProviders: (groupProviders?.length ? groupProviders : [providerName]).filter(Boolean),
    id: '',
    mode: seedMode,
    apiKeyRef: options.providerApiKeyLabel(providerName),
    startText: options.toDateTimeLocalValue(start),
    endText: options.toDateTimeLocalValue(end),
    amountText:
      seedAmountUsd && seedAmountUsd > 0
        ? options.formatDraftAmount(options.convertUsdToCurrency(seedAmountUsd, currency))
        : '',
    currency,
  }
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
  if (!row.req_count || row.req_count <= 0) return null
  const total = historyEffectiveDisplayValue(row)
  if (!total || !Number.isFinite(total) || total <= 0) return null
  return total / row.req_count
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
