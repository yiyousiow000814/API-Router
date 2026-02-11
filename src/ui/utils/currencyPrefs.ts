import { normalizeCurrencyCode } from './pricingHelpers'

export function currencyPrefKeyByApiKey(prefix: string, apiKeyRef: string): string | null {
  const key = apiKeyRef.trim()
  if (!key || key === '-' || key === 'set') return null
  return `${prefix}key:${key}`
}

export function readPreferredCurrency(
  prefix: string,
  providerName: string,
  apiKeyRef: string | undefined,
  resolveProviderApiKeyLabel: (providerName: string) => string,
): string {
  if (typeof window === 'undefined') return 'USD'
  const keys: string[] = []
  const byApiKey = currencyPrefKeyByApiKey(prefix, apiKeyRef?.trim() ?? '')
  if (byApiKey) keys.push(byApiKey)
  const keyLabel = resolveProviderApiKeyLabel(providerName).trim()
  const byProviderApiKey = currencyPrefKeyByApiKey(prefix, keyLabel)
  if (byProviderApiKey) keys.push(byProviderApiKey)
  keys.push(`${prefix}${providerName}`)
  for (const key of keys) {
    const cached = window.localStorage.getItem(key)
    if (cached?.trim()) return normalizeCurrencyCode(cached)
  }
  return 'USD'
}

export function persistPreferredCurrency(
  prefix: string,
  providerNames: string[],
  currency: string,
  options: { apiKeyRef?: string } | undefined,
  resolveProviderApiKeyLabel: (providerName: string) => string,
) {
  if (typeof window === 'undefined') return
  const normalized = normalizeCurrencyCode(currency)
  const keys = new Set<string>()
  const byApiKey = currencyPrefKeyByApiKey(prefix, options?.apiKeyRef?.trim() ?? '')
  if (byApiKey) keys.add(byApiKey)
  providerNames.forEach((providerName) => {
    const keyLabel = resolveProviderApiKeyLabel(providerName).trim()
    const byProviderApiKey = currencyPrefKeyByApiKey(prefix, keyLabel)
    if (byProviderApiKey) keys.add(byProviderApiKey)
    keys.add(`${prefix}${providerName}`)
  })
  keys.forEach((key) => window.localStorage.setItem(key, normalized))
}
