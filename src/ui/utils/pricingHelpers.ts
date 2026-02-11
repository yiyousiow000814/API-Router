import type {
  PricingTimelineMode,
  ProviderScheduleDraft,
  ProviderSchedulePeriod,
  ProviderScheduleSaveInput,
} from '../appTypes'

export function normalizeCurrencyCode(code: string): string {
  const raw = code.trim().toUpperCase()
  const next = raw === 'RMB' ? 'CNY' : raw
  return /^[A-Z]{3}$/.test(next) ? next : 'USD'
}

export function currencyLabel(code: string): string {
  return code === 'CNY' ? 'RMB' : code
}

export function pricingCurrencyRate(fxRatesByCurrency: Record<string, number>, code: string): number {
  const norm = normalizeCurrencyCode(code)
  const rate = fxRatesByCurrency[norm]
  if (!Number.isFinite(rate) || rate <= 0) return 1
  return rate
}

export function convertUsdToCurrency(
  fxRatesByCurrency: Record<string, number>,
  usdAmount: number,
  currency: string,
): number {
  return usdAmount * pricingCurrencyRate(fxRatesByCurrency, currency)
}

export function convertCurrencyToUsd(
  fxRatesByCurrency: Record<string, number>,
  amount: number,
  currency: string,
): number {
  return amount / pricingCurrencyRate(fxRatesByCurrency, currency)
}

export function formatDraftAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const fixed = value.toFixed(4)
  return fixed.replace(/\.?0+$/, '')
}

export function toDateTimeLocalValue(unixMs?: number | null): string {
  if (!unixMs || !Number.isFinite(unixMs) || unixMs <= 0) return ''
  const d = new Date(unixMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const min = pad(d.getMinutes())
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}

export function fromDateTimeLocalValue(value: string): number | null {
  const raw = value.trim()
  if (!raw) return null
  const unixMs = Date.parse(raw)
  if (!Number.isFinite(unixMs) || unixMs <= 0) return null
  return unixMs
}

export function parsePositiveAmount(value: string): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

export function scheduleRowsSignature(rows: ProviderScheduleDraft[]): string {
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
  providerNames?: string[],
): Record<string, string> {
  const grouped: Record<string, ProviderScheduleDraft[]> = {}
  for (const row of rows) {
    const targets = Array.from(
      new Set([row.provider, ...(row.groupProviders ?? [])].map((name) => name.trim()).filter(Boolean)),
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

export function parseScheduleRowsForSaveWithResolver(
  rows: ProviderScheduleDraft[],
  fxRatesByCurrency: Record<string, number>,
  resolveProviderApiKeyLabel: (providerName: string) => string,
):
  | { ok: true; periodsByProvider: Record<string, ProviderScheduleSaveInput[]> }
  | { ok: false; reason: string } {
  const grouped: Record<string, ProviderScheduleSaveInput[]> = {}
  const dedupeByProvider: Record<string, Set<string>> = {}
  const apiKeyPeriodSet = new Set<string>()

  for (const row of rows) {
    const providers = Array.from(
      new Set([row.provider, ...(row.groupProviders ?? [])].map((name) => name.trim()).filter(Boolean)),
    )
    if (!providers.length) return { ok: false, reason: 'provider is required' }
    if (row.mode !== 'package_total' && row.mode !== 'per_request') {
      return { ok: false, reason: 'mode must be monthly fee or $/request' }
    }
    const start = fromDateTimeLocalValue(row.startText)
    const end = fromDateTimeLocalValue(row.endText)
    const amount = parsePositiveAmount(row.amountText)
    if (!start || !amount) {
      return { ok: false, reason: 'complete each row with valid start and amount' }
    }
    if (row.mode === 'package_total' && !end) {
      return { ok: false, reason: 'monthly fee row requires expires time' }
    }
    if (end != null && start >= end) {
      return { ok: false, reason: 'each row start must be earlier than expires' }
    }
    const apiKeyLabel = row.apiKeyRef.trim() || resolveProviderApiKeyLabel(providers[0])
    const endKey = end == null ? 'open' : String(end)
    const apiKeyPeriodKey = `${apiKeyLabel}|${start}|${endKey}`
    if (apiKeyLabel !== '-' && apiKeyPeriodSet.has(apiKeyPeriodKey)) {
      return { ok: false, reason: `duplicate start/expires for API key ${apiKeyLabel}` }
    }
    apiKeyPeriodSet.add(apiKeyPeriodKey)
    const amountUsd = convertCurrencyToUsd(fxRatesByCurrency, amount, row.currency)
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
    for (let index = 1; index < periods.length; index += 1) {
      const prevEnd = periods[index - 1].ended_at_unix_ms
      if (prevEnd == null || prevEnd > periods[index].started_at_unix_ms) {
        return { ok: false, reason: `periods overlap for ${provider}` }
      }
    }
  }
  return { ok: true, periodsByProvider: grouped }
}

export function scheduleDraftFromPeriod(
  providerName: string,
  period: ProviderSchedulePeriod,
  fallbackCurrency: string | undefined,
  groupProviders: string[] | undefined,
  resolveProviderApiKeyLabel: (providerName: string) => string,
  readPreferredCurrency: (providerName: string, apiKeyRef?: string) => string,
  fxRatesByCurrency: Record<string, number>,
): ProviderScheduleDraft {
  const resolvedApiKeyRef = resolveProviderApiKeyLabel(providerName)
  const apiKeyRef = (period.api_key_ref ?? resolvedApiKeyRef).trim() || resolvedApiKeyRef
  const currency = fallbackCurrency ? normalizeCurrencyCode(fallbackCurrency) : readPreferredCurrency(providerName, apiKeyRef)
  const mode: PricingTimelineMode = period.mode === 'per_request' ? 'per_request' : 'package_total'
  const fallbackEndMs = mode === 'package_total' ? period.started_at_unix_ms + 30 * 24 * 60 * 60 * 1000 : undefined
  const endMs = period.ended_at_unix_ms ?? fallbackEndMs
  return {
    provider: providerName,
    groupProviders: (groupProviders?.length ? groupProviders : [providerName]).filter(Boolean),
    id: period.id,
    mode,
    apiKeyRef,
    startText: toDateTimeLocalValue(period.started_at_unix_ms),
    endText: toDateTimeLocalValue(endMs),
    amountText: formatDraftAmount(convertUsdToCurrency(fxRatesByCurrency, period.amount_usd, currency)),
    currency,
  }
}

export function newScheduleDraft(
  providerName: string,
  seedAmountUsd: number | null | undefined,
  seedCurrency: string | undefined,
  seedMode: PricingTimelineMode,
  groupProviders: string[] | undefined,
  resolveProviderApiKeyLabel: (providerName: string) => string,
  readPreferredCurrency: (providerName: string, apiKeyRef?: string) => string,
  fxRatesByCurrency: Record<string, number>,
): ProviderScheduleDraft {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
  const end = start + 30 * 24 * 60 * 60 * 1000
  const apiKeyRef = resolveProviderApiKeyLabel(providerName)
  const currency = seedCurrency ? normalizeCurrencyCode(seedCurrency) : readPreferredCurrency(providerName, apiKeyRef)
  return {
    provider: providerName,
    groupProviders: (groupProviders?.length ? groupProviders : [providerName]).filter(Boolean),
    id: '',
    mode: seedMode,
    apiKeyRef,
    startText: toDateTimeLocalValue(start),
    endText: toDateTimeLocalValue(end),
    amountText:
      seedAmountUsd && seedAmountUsd > 0
        ? formatDraftAmount(convertUsdToCurrency(fxRatesByCurrency, seedAmountUsd, currency))
        : '',
    currency,
  }
}
