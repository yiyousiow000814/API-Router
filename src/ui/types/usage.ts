export type UsagePricingMode = 'none' | 'per_request' | 'package_total'
export type PricingTimelineMode = 'per_request' | 'package_total'

export type UsagePricingDraft = {
  mode: UsagePricingMode
  amountText: string
  currency: string
}

export type UsagePricingGroup = {
  id: string
  providers: string[]
  primaryProvider: string
  displayName: string
  keyLabel: string
}

export type UsageHistoryDraft = {
  effectiveText: string
  perReqText: string
}

export type ProviderSchedulePeriod = {
  id: string
  mode?: PricingTimelineMode
  amount_usd: number
  api_key_ref?: string
  started_at_unix_ms: number
  ended_at_unix_ms?: number | null
}

export type ProviderScheduleDraft = {
  provider: string
  groupProviders: string[]
  id: string
  mode: PricingTimelineMode
  apiKeyRef: string
  startText: string
  endText: string
  amountText: string
  currency: string
}

export type ProviderScheduleSaveInput = {
  id: string | null
  mode: PricingTimelineMode
  amount_usd: number
  api_key_ref: string
  started_at_unix_ms: number
  ended_at_unix_ms?: number
}

export type UsageScheduleSaveState = 'idle' | 'saving' | 'saved' | 'invalid' | 'error'
export type UsagePricingSaveState = 'idle' | 'saving' | 'saved' | 'error'

export type FxUsdPayload = {
  date?: string
  usd?: Record<string, number>
}
