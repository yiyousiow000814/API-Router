import type { Config } from '../types'
import type { UsagePricingDraft, UsagePricingMode } from '../types/usage'

type BuildDraftOptions = {
  readPreferredCurrency: (providerName: string, apiKeyRef?: string) => string
  normalizeCurrencyCode: (code: string) => string
  convertUsdToCurrency: (usdAmount: number, currency: string) => number
  formatDraftAmount: (value: number) => string
}

export function pricingDraftSignature(
  draft: UsagePricingDraft,
  normalizeCurrencyCode: (code: string) => string,
): string {
  return JSON.stringify({
    mode: draft.mode,
    amountText: draft.amountText.trim(),
    currency: normalizeCurrencyCode(draft.currency),
  })
}

export function buildUsagePricingDraft(
  providerName: string,
  providerCfg: Config['providers'][string] | undefined,
  options: BuildDraftOptions,
): UsagePricingDraft {
  const mode = (providerCfg?.manual_pricing_mode ?? 'none') as UsagePricingMode
  const cachedCurrency = options.readPreferredCurrency(
    providerName,
    providerCfg?.key_preview?.trim() || (providerCfg?.has_key ? 'set' : '-'),
  )
  const currency = options.normalizeCurrencyCode(cachedCurrency)
  const amountUsd = providerCfg?.manual_pricing_amount_usd
  const amountText =
    amountUsd != null && Number.isFinite(amountUsd) && amountUsd > 0
      ? options.formatDraftAmount(options.convertUsdToCurrency(amountUsd, currency))
      : ''
  return { mode, amountText, currency }
}

export function resolvePricingAmountUsd(
  draft: UsagePricingDraft,
  fallbackAmountUsd: number | null | undefined,
  convertCurrencyToUsd: (amount: number, currency: string) => number,
): number | null {
  const amountRaw = Number(draft.amountText)
  if (Number.isFinite(amountRaw) && amountRaw > 0) {
    return convertCurrencyToUsd(amountRaw, draft.currency)
  }
  if (fallbackAmountUsd != null && Number.isFinite(fallbackAmountUsd) && fallbackAmountUsd > 0) {
    return fallbackAmountUsd
  }
  return null
}
