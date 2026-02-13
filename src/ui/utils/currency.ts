export function normalizeCurrencyCode(code: string): string {
  const raw = code.trim().toUpperCase()
  const next = raw === 'RMB' ? 'CNY' : raw
  return /^[A-Z]{3}$/.test(next) ? next : 'USD'
}

export function currencyLabel(code: string): string {
  return code === 'CNY' ? 'RMB' : code
}

export function buildUsageCurrencyOptions(fxRatesByCurrency: Record<string, number>): string[] {
  const all = Object.keys(fxRatesByCurrency)
    .map((code) => code.toUpperCase())
    .filter((code) => /^[A-Z]{3}$/.test(code))
  const unique = Array.from(new Set(all))
  const preferred = ['USD', 'CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD', 'MYR']
  const sorted = unique.sort((a, b) => a.localeCompare(b))
  const head = preferred.filter((code) => sorted.includes(code))
  const tail = sorted.filter((code) => !head.includes(code))
  return [...head, ...tail]
}

export function currencyRate(fxRatesByCurrency: Record<string, number>, code: string): number {
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
  return usdAmount * currencyRate(fxRatesByCurrency, currency)
}

export function convertCurrencyToUsd(
  fxRatesByCurrency: Record<string, number>,
  amount: number,
  currency: string,
): number {
  return amount / currencyRate(fxRatesByCurrency, currency)
}

export function convertAmountBetweenCurrencies(
  fxRatesByCurrency: Record<string, number>,
  amount: number,
  fromCurrency: string,
  toCurrency: string,
): number {
  return convertUsdToCurrency(
    fxRatesByCurrency,
    convertCurrencyToUsd(fxRatesByCurrency, amount, fromCurrency),
    toCurrency,
  )
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
