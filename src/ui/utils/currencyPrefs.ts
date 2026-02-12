type PrefOptions = {
  prefix: string
  getProviderApiKeyLabel: (providerName: string) => string
  normalizeCurrencyCode: (code: string) => string
}

export function currencyPrefKeyByApiKey(prefix: string, apiKeyRef: string): string | null {
  const key = apiKeyRef.trim()
  if (!key || key === '-' || key === 'set') return null
  return `${prefix}key:${key}`
}

export function currencyPrefKeyByProvider(prefix: string, providerName: string): string {
  return `${prefix}${providerName}`
}

export function readPreferredCurrency(
  providerName: string,
  apiKeyRef: string | undefined,
  options: PrefOptions,
): string {
  if (typeof window === 'undefined') return 'USD'
  const keys: string[] = []
  const byApiKey = currencyPrefKeyByApiKey(options.prefix, apiKeyRef?.trim() ?? '')
  if (byApiKey) keys.push(byApiKey)
  const providerKeyLabel = options.getProviderApiKeyLabel(providerName).trim()
  const byProviderApiKey = currencyPrefKeyByApiKey(options.prefix, providerKeyLabel)
  if (byProviderApiKey) keys.push(byProviderApiKey)
  keys.push(currencyPrefKeyByProvider(options.prefix, providerName))
  for (const key of keys) {
    const cached = window.localStorage.getItem(key)
    if (cached?.trim()) return options.normalizeCurrencyCode(cached)
  }
  return 'USD'
}

export function persistPreferredCurrency(
  providerNames: string[],
  currency: string,
  apiKeyRef: string | undefined,
  options: PrefOptions,
) {
  if (typeof window === 'undefined') return
  const normalized = options.normalizeCurrencyCode(currency)
  const keys = new Set<string>()
  const byApiKey = currencyPrefKeyByApiKey(options.prefix, apiKeyRef?.trim() ?? '')
  if (byApiKey) keys.add(byApiKey)
  providerNames.forEach((providerName) => {
    const providerKeyLabel = options.getProviderApiKeyLabel(providerName).trim()
    const byProviderApiKey = currencyPrefKeyByApiKey(options.prefix, providerKeyLabel)
    if (byProviderApiKey) keys.add(byProviderApiKey)
    keys.add(currencyPrefKeyByProvider(options.prefix, providerName))
  })
  keys.forEach((key) => {
    window.localStorage.setItem(key, normalized)
  })
}
