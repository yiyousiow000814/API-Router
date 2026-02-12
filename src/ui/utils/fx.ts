import type { FxUsdPayload } from '../types/usage'

export async function fetchLatestFxUsdRates(today: string): Promise<{ date: string; rates: Record<string, number> } | null> {
  const endpoints = [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
  ]
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, { cache: 'no-store' })
      if (!res.ok) continue
      const payload = (await res.json()) as FxUsdPayload
      const usdMap = payload?.usd ?? {}
      const rates: Record<string, number> = { USD: 1 }
      Object.entries(usdMap).forEach(([code, value]) => {
        const norm = code.trim().toUpperCase()
        if (!/^[A-Z]{3}$/.test(norm)) return
        if (!Number.isFinite(value) || value <= 0) return
        rates[norm] = value
      })
      if (!Object.keys(rates).length) continue
      const date = (payload?.date ?? today).slice(0, 10)
      return { date, rates }
    } catch (e) {
      console.warn('FX fetch failed', endpoint, e)
    }
  }
  return null
}
