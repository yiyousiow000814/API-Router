import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { SpendHistoryRow } from '../devMockData'
import type { Config } from '../types'
import type {
  PricingTimelineMode,
  ProviderScheduleDraft,
  ProviderSchedulePeriod,
  ProviderScheduleSaveInput,
  UsageHistoryDraft,
  UsagePricingDraft,
} from '../types/usage'
import { fetchLatestFxUsdRates } from '../utils/fx'
import {
  convertAmountBetweenCurrencies,
  convertCurrencyToUsd,
  convertUsdToCurrency,
  formatDraftAmount,
  fromDateTimeLocalValue,
  normalizeCurrencyCode,
  parsePositiveAmount,
  toDateTimeLocalValue,
} from '../utils/currency'
import {
  persistPreferredCurrency as savePreferredCurrency,
  readPreferredCurrency as loadPreferredCurrency,
} from '../utils/currencyPrefs'
import {
  buildUsagePricingDraft as createUsagePricingDraft,
  pricingDraftSignature as buildPricingDraftSignature,
} from '../utils/usagePricing'
import {
  fmtHistorySource as formatHistorySourceLabel,
  historyDraftFromRow as buildHistoryDraftFromRow,
  historyEffectiveDisplayValue as computeHistoryEffectiveDisplayValue,
  historyPerReqDisplayValue as computeHistoryPerReqDisplayValue,
  newScheduleDraft as buildNewScheduleDraft,
  parseScheduleRowsForSave as parseUsageScheduleRowsForSave,
  scheduleDraftFromPeriod as buildScheduleDraftFromPeriod,
  scheduleRowsSignature as buildScheduleRowsSignature,
  scheduleSignaturesByProvider as buildScheduleSignaturesByProvider,
} from '../utils/usageSchedule'

const FX_RATES_CACHE_KEY = 'ao.fx.usd.daily.v1'
const FX_CURRENCY_PREF_KEY_PREFIX = 'ao.usagePricing.currency.'

type UsagePricingCurrencyMenuState = {
  provider: string
  providers: string[]
  left: number
  top: number
  width: number
} | null

type UsageScheduleCurrencyMenuState = {
  rowIndex: number
  left: number
  top: number
  width: number
} | null

type Params = {
  config: Config | null
  fxRatesByCurrency: Record<string, number>
  setFxRatesByCurrency: Dispatch<SetStateAction<Record<string, number>>>
  setFxRatesDate: Dispatch<SetStateAction<string>>
  setUsagePricingDrafts: Dispatch<SetStateAction<Record<string, UsagePricingDraft>>>
  queueUsagePricingAutoSaveForProviders: (providerNames: string[], draft: UsagePricingDraft) => void
  usageScheduleRows: ProviderScheduleDraft[]
  setUsageScheduleRows: Dispatch<SetStateAction<ProviderScheduleDraft[]>>
  setUsageScheduleCurrencyMenu: Dispatch<SetStateAction<UsageScheduleCurrencyMenuState>>
  setUsageScheduleCurrencyQuery: Dispatch<SetStateAction<string>>
  setUsageScheduleProvider: Dispatch<SetStateAction<string>>
  setUsageScheduleModalOpen: Dispatch<SetStateAction<boolean>>
  setUsageScheduleLoading: Dispatch<SetStateAction<boolean>>
  setUsageScheduleSaveState: Dispatch<SetStateAction<'idle' | 'saving' | 'saved' | 'invalid' | 'error'>>
  setUsageScheduleSaveError: Dispatch<SetStateAction<string>>
  setUsageScheduleSaving: Dispatch<SetStateAction<boolean>>
  usageScheduleModalOpen: boolean
  usageScheduleProviderOptions: string[]
  usageScheduleLastSavedSigRef: MutableRefObject<string>
  usageScheduleLastSavedByProviderRef: MutableRefObject<Record<string, string>>
  setUsagePricingCurrencyMenu: Dispatch<SetStateAction<UsagePricingCurrencyMenuState>>
  setUsagePricingCurrencyQuery: Dispatch<SetStateAction<string>>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  refreshConfig: () => Promise<void>
  refreshUsageStatistics: (options?: { silent?: boolean }) => Promise<void>
  usageHistoryModalOpen: boolean
  refreshUsageHistory: (options?: { silent?: boolean; keepEditCell?: boolean }) => Promise<void>
}

export function useUsageScheduleCore(params: Params) {
  const {
    config,
    fxRatesByCurrency,
    setFxRatesByCurrency,
    setFxRatesDate,
    setUsagePricingDrafts,
    queueUsagePricingAutoSaveForProviders,
    usageScheduleRows,
    setUsageScheduleRows,
    setUsageScheduleCurrencyMenu,
    setUsageScheduleCurrencyQuery,
    setUsageScheduleProvider,
    setUsageScheduleModalOpen,
    setUsageScheduleLoading,
    setUsageScheduleSaveState,
    setUsageScheduleSaveError,
    setUsageScheduleSaving,
    usageScheduleModalOpen,
    usageScheduleProviderOptions,
    usageScheduleLastSavedSigRef,
    usageScheduleLastSavedByProviderRef,
    setUsagePricingCurrencyMenu,
    setUsagePricingCurrencyQuery,
    flashToast,
    refreshConfig,
    refreshUsageStatistics,
    usageHistoryModalOpen,
    refreshUsageHistory,
  } = params

  function providerApiKeyLabel(providerName: string): string {
    const keyPreview = config?.providers?.[providerName]?.key_preview?.trim()
    if (keyPreview) return keyPreview
    if (config?.providers?.[providerName]?.has_key) return 'set'
    return '-'
  }

  function readPreferredCurrency(providerName: string, apiKeyRef?: string): string {
    return loadPreferredCurrency(providerName, apiKeyRef, {
      prefix: FX_CURRENCY_PREF_KEY_PREFIX,
      getProviderApiKeyLabel: providerApiKeyLabel,
      normalizeCurrencyCode,
    })
  }

  function persistPreferredCurrency(providerNames: string[], currency: string, options?: { apiKeyRef?: string }) {
    return savePreferredCurrency(providerNames, currency, options?.apiKeyRef, {
      prefix: FX_CURRENCY_PREF_KEY_PREFIX,
      getProviderApiKeyLabel: providerApiKeyLabel,
      normalizeCurrencyCode,
    })
  }

  function providerPreferredCurrency(providerName: string): string {
    return readPreferredCurrency(providerName, providerApiKeyLabel(providerName))
  }

  function linkedProvidersForApiKey(apiKeyRef: string, fallbackProvider: string): string[] {
    const normalized = String(apiKeyRef ?? '').trim()
    if (!normalized || normalized === '-' || normalized === 'set') return [fallbackProvider]
    const names = Object.keys(config?.providers ?? {}).filter((name) => providerApiKeyLabel(name) === normalized)
    if (!names.length) return [fallbackProvider]
    names.sort((a, b) => a.localeCompare(b))
    if (!names.includes(fallbackProvider)) names.unshift(fallbackProvider)
    return Array.from(new Set(names))
  }

  function updateUsagePricingCurrency(providerNames: string[], draft: UsagePricingDraft, nextCurrency: string) {
    const raw = normalizeCurrencyCode(nextCurrency)
    const nextProviders = providerNames.filter((providerName) => Boolean(config?.providers?.[providerName]))
    if (!nextProviders.length) return
    let nextDraftForAutoSave: UsagePricingDraft | null = null
    setUsagePricingDrafts((prev: Record<string, UsagePricingDraft>) => {
      const cur = prev[nextProviders[0]] ?? draft
      const amountRaw = Number(cur.amountText)
      const oldCurrency = normalizeCurrencyCode(cur.currency)
      const nextAmount =
        Number.isFinite(amountRaw) && amountRaw > 0
          ? formatDraftAmount(convertAmountBetweenCurrencies(fxRatesByCurrency, amountRaw, oldCurrency, raw))
          : cur.amountText
      const nextDraft = { ...cur, currency: raw, amountText: nextAmount }
      nextDraftForAutoSave = nextDraft
      const next = { ...prev }
      nextProviders.forEach((providerName) => {
        next[providerName] = nextDraft
      })
      return next
    })
    if (nextDraftForAutoSave && typeof queueUsagePricingAutoSaveForProviders === 'function') {
      queueUsagePricingAutoSaveForProviders(nextProviders, nextDraftForAutoSave)
    }
    persistPreferredCurrency(nextProviders, raw, { apiKeyRef: providerApiKeyLabel(nextProviders[0]) })
  }

  function closeUsageScheduleCurrencyMenu() {
    setUsageScheduleCurrencyMenu(null)
    setUsageScheduleCurrencyQuery('')
  }

  const closeUsagePricingCurrencyMenu = useCallback(() => {
    setUsagePricingCurrencyMenu(null)
    setUsagePricingCurrencyQuery('')
  }, [])

  function updateUsageScheduleCurrency(rowIndex: number, nextCurrency: string) {
    const raw = normalizeCurrencyCode(nextCurrency)
    const row = usageScheduleRows[rowIndex]
    if (row) {
      persistPreferredCurrency([row.provider, ...(row.groupProviders ?? [])], raw, { apiKeyRef: row.apiKeyRef })
    }
    setUsageScheduleSaveState('idle')
    setUsageScheduleRows((prev: ProviderScheduleDraft[]) =>
      prev.map((row, index) => {
        if (index !== rowIndex) return row
        const amountRaw = Number(row.amountText)
        const oldCurrency = normalizeCurrencyCode(row.currency)
        const nextAmount =
          Number.isFinite(amountRaw) && amountRaw > 0
            ? formatDraftAmount(convertAmountBetweenCurrencies(fxRatesByCurrency, amountRaw, oldCurrency, raw))
            : row.amountText
        return { ...row, currency: raw, amountText: nextAmount }
      }),
    )
  }

  function scheduleRowsSignature(rows: ProviderScheduleDraft[]): string {
    return buildScheduleRowsSignature(rows, normalizeCurrencyCode)
  }

  function scheduleSignaturesByProvider(rows: ProviderScheduleDraft[], providerNames?: string[]): Record<string, string> {
    return buildScheduleSignaturesByProvider(rows, normalizeCurrencyCode, providerNames)
  }

  function parseScheduleRowsForSave(rows: ProviderScheduleDraft[]): { ok: true; periodsByProvider: Record<string, ProviderScheduleSaveInput[]> } | { ok: false; reason: string } {
    return parseUsageScheduleRowsForSave(rows, {
      fromDateTimeLocalValue,
      parsePositiveAmount,
      providerApiKeyLabel,
      convertCurrencyToUsd: (amount, currency) => convertCurrencyToUsd(fxRatesByCurrency, amount, currency),
    })
  }

  function scheduleDraftFromPeriod(providerName: string, period: ProviderSchedulePeriod, fallbackCurrency?: string, groupProviders?: string[]): ProviderScheduleDraft {
    return buildScheduleDraftFromPeriod(
      providerName,
      period,
      {
        providerApiKeyLabel,
        readPreferredCurrency,
        toDateTimeLocalValue,
        normalizeCurrencyCode,
        convertUsdToCurrency: (amount, currency) => convertUsdToCurrency(fxRatesByCurrency, amount, currency),
        formatDraftAmount,
      },
      fallbackCurrency,
      groupProviders,
    )
  }

  function newScheduleDraft(providerName: string, seedAmountUsd?: number | null, seedCurrency?: string, seedMode: PricingTimelineMode = 'package_total', groupProviders?: string[]): ProviderScheduleDraft {
    return buildNewScheduleDraft(
      providerName,
      {
        providerApiKeyLabel,
        readPreferredCurrency,
        toDateTimeLocalValue,
        normalizeCurrencyCode,
        convertUsdToCurrency: (amount, currency) => convertUsdToCurrency(fxRatesByCurrency, amount, currency),
        formatDraftAmount,
      },
      seedAmountUsd,
      seedCurrency,
      seedMode,
      groupProviders,
    )
  }

  function historyEffectiveDisplayValue(row: SpendHistoryRow): number | null {
    return computeHistoryEffectiveDisplayValue(row)
  }

  function historyPerReqDisplayValue(row: SpendHistoryRow): number | null {
    return computeHistoryPerReqDisplayValue(row)
  }

  function historyDraftFromRow(row: SpendHistoryRow): UsageHistoryDraft {
    return buildHistoryDraftFromRow(row, formatDraftAmount)
  }

  function fmtHistorySource(source?: string | null): string {
    return formatHistorySourceLabel(source)
  }

  function pricingDraftSignature(draft: UsagePricingDraft): string {
    return buildPricingDraftSignature(draft, normalizeCurrencyCode)
  }

  function buildUsagePricingDraft(providerName: string, providerCfg?: Config['providers'][string]): UsagePricingDraft {
    return createUsagePricingDraft(providerName, providerCfg, {
      readPreferredCurrency,
      normalizeCurrencyCode,
      convertUsdToCurrency: (amount, currency) => convertUsdToCurrency(fxRatesByCurrency, amount, currency),
      formatDraftAmount,
    })
  }

  async function refreshFxRatesDaily(force = false) {
    const today = new Date().toISOString().slice(0, 10)
    if (!force && typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(FX_RATES_CACHE_KEY)
        if (raw) {
          const cached = JSON.parse(raw) as { date?: string; rates?: Record<string, number> }
          if (cached?.date === today && cached.rates && Number.isFinite(cached.rates.USD)) {
            setFxRatesByCurrency(cached.rates)
            setFxRatesDate(cached.date)
            return
          }
        }
      } catch (e) {
        console.warn('Failed to read FX cache', e)
      }
    }
    const latest = await fetchLatestFxUsdRates(today)
    if (latest) {
      const { date, rates } = latest
      setFxRatesByCurrency(rates)
      setFxRatesDate(date)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(FX_RATES_CACHE_KEY, JSON.stringify({ date, rates }))
      }
    }
  }

  async function openUsageScheduleModal(providerName: string, seedCurrency?: string, options?: { keepVisible?: boolean }) {
    if (!providerName) return
    const keepVisible = options?.keepVisible === true && usageScheduleModalOpen
    closeUsagePricingCurrencyMenu()
    closeUsageScheduleCurrencyMenu()
    setUsageScheduleProvider(providerName)
    setUsageScheduleModalOpen(true)
    if (!keepVisible) setUsageScheduleLoading(true)
    setUsageScheduleSaveState('idle')
    setUsageScheduleSaveError('')
    try {
      const providers = Array.from(
        new Set([providerName, ...usageScheduleProviderOptions].filter((name) => Boolean(name) && Boolean(config?.providers?.[name]))),
      )
      const chunks = await Promise.all(
        providers.map(async (provider) => {
          const res = await invoke<{ ok: boolean; periods?: ProviderSchedulePeriod[] }>('get_provider_timeline', { provider })
          const periods = Array.isArray(res?.periods) ? res.periods : []
          return { provider, periods }
        }),
      )
      const rowsByKey = new Map<string, ProviderScheduleDraft>()
      chunks.forEach(({ provider, periods }) => {
        const preferredCurrency = provider === providerName && seedCurrency ? seedCurrency : providerPreferredCurrency(provider)
        periods
          .sort((a, b) => a.started_at_unix_ms - b.started_at_unix_ms)
          .forEach((period) => {
            const apiKeyRef = (period.api_key_ref ?? providerApiKeyLabel(provider)).trim() || providerApiKeyLabel(provider)
            const linked = linkedProvidersForApiKey(apiKeyRef, provider)
            const canonicalProvider = linked[0] ?? provider
            const endMs = period.ended_at_unix_ms ?? null
            const dedupeKey = [apiKeyRef, period.mode ?? 'package_total', String(period.started_at_unix_ms), String(endMs ?? 'open'), Number.isFinite(period.amount_usd) ? period.amount_usd.toFixed(8) : String(period.amount_usd)].join('|')
            const existing = rowsByKey.get(dedupeKey)
            if (existing) {
              const mergedProviders = Array.from(new Set([...existing.groupProviders, ...linked, provider].filter(Boolean)))
              rowsByKey.set(dedupeKey, { ...existing, groupProviders: mergedProviders })
              return
            }
            rowsByKey.set(dedupeKey, scheduleDraftFromPeriod(canonicalProvider, period, preferredCurrency, linked))
          })
      })
      const rows = Array.from(rowsByKey.values()).sort((a, b) =>
        a.provider.localeCompare(b.provider) || a.startText.localeCompare(b.startText) || a.endText.localeCompare(b.endText),
      )
      setUsageScheduleRows(rows)
      usageScheduleLastSavedSigRef.current = scheduleRowsSignature(rows)
      usageScheduleLastSavedByProviderRef.current = scheduleSignaturesByProvider(rows, providers)
      setUsageScheduleSaveState(rows.length > 0 ? 'saved' : 'idle')
      setUsageScheduleSaveError('')
    } catch (e) {
      flashToast(String(e), 'error')
      if (!keepVisible) {
        setUsageScheduleRows([])
        usageScheduleLastSavedSigRef.current = scheduleRowsSignature([])
        usageScheduleLastSavedByProviderRef.current = {}
      }
      setUsageScheduleSaveState('idle')
      setUsageScheduleSaveError('')
    } finally {
      setUsageScheduleLoading(false)
    }
  }

  async function autoSaveUsageScheduleRows(rows: ProviderScheduleDraft[], signature: string) {
    const parsed = parseScheduleRowsForSave(rows)
    if (!parsed.ok) {
      setUsageScheduleSaveState('invalid')
      setUsageScheduleSaveError(parsed.reason)
      return
    }
    setUsageScheduleSaving(true)
    setUsageScheduleSaveState('saving')
    setUsageScheduleSaveError('')
    try {
      const prevByProvider = usageScheduleLastSavedByProviderRef.current
      const nextByProvider = scheduleSignaturesByProvider(rows)
      const providerNames = Array.from(new Set([...Object.keys(prevByProvider), ...Object.keys(nextByProvider)]))
      for (const provider of providerNames) {
        if (!config?.providers?.[provider]) continue
        const prevSig = prevByProvider[provider] ?? '[]'
        const nextSig = nextByProvider[provider] ?? '[]'
        if (prevSig === nextSig) continue
        await invoke('set_provider_timeline', { provider, periods: parsed.periodsByProvider[provider] ?? [] })
      }
      usageScheduleLastSavedByProviderRef.current = nextByProvider
      usageScheduleLastSavedSigRef.current = signature
      setUsageScheduleSaveState('saved')
      setUsageScheduleSaveError('')
      await refreshConfig()
      await refreshUsageStatistics({ silent: true })
      if (usageHistoryModalOpen) {
        await refreshUsageHistory({ silent: true })
      }
    } catch (e) {
      setUsageScheduleSaveState('error')
      const msg = String(e)
      setUsageScheduleSaveError(msg)
      flashToast(`Scheduled auto-save failed: ${msg}`, 'error')
    } finally {
      setUsageScheduleSaving(false)
    }
  }

  return {
    providerApiKeyLabel,
    providerPreferredCurrency,
    updateUsagePricingCurrency,
    closeUsageScheduleCurrencyMenu,
    updateUsageScheduleCurrency,
    scheduleRowsSignature,
    parseScheduleRowsForSave,
    newScheduleDraft,
    historyEffectiveDisplayValue,
    historyPerReqDisplayValue,
    historyDraftFromRow,
    fmtHistorySource,
    closeUsagePricingCurrencyMenu,
    pricingDraftSignature,
    buildUsagePricingDraft,
    refreshFxRatesDaily,
    openUsageScheduleModal,
    autoSaveUsageScheduleRows,
  }
}
