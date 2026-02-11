import { useCallback } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'

import type {
  FxUsdPayload,
  ProviderScheduleDraft,
  ProviderSchedulePeriod,
  UsagePricingDraft,
  UsagePricingSaveState,
  UsagePricingMode,
} from '../appTypes'
import type { Config } from '../types'

type Args = {
  FX_RATES_CACHE_KEY: string
  isDevPreview: boolean
  config: Config | null
  fxRatesByCurrency: Record<string, number>
  usagePricingModalOpen: boolean
  usageScheduleModalOpen: boolean
  usageHistoryModalOpen: boolean
  usageScheduleProviderOptions: string[]
  usagePricingDrafts: Record<string, UsagePricingDraft>
  usagePricingLastSavedSigRef: MutableRefObject<Record<string, string>>
  usageScheduleLastSavedSigRef: MutableRefObject<string>
  usageScheduleLastSavedByProviderRef: MutableRefObject<Record<string, string>>
  setFxRatesByCurrency: Dispatch<SetStateAction<Record<string, number>>>
  setFxRatesDate: Dispatch<SetStateAction<string>>
  setUsageScheduleProvider: Dispatch<SetStateAction<string>>
  setUsageScheduleModalOpen: Dispatch<SetStateAction<boolean>>
  setUsageScheduleLoading: Dispatch<SetStateAction<boolean>>
  setUsageScheduleRows: Dispatch<SetStateAction<ProviderScheduleDraft[]>>
  setUsageScheduleSaving: Dispatch<SetStateAction<boolean>>
  setUsageScheduleSaveState: Dispatch<SetStateAction<'idle' | 'saving' | 'saved' | 'invalid' | 'error'>>
  setUsageScheduleSaveError: Dispatch<SetStateAction<string>>
  setUsagePricingSaveState: Dispatch<SetStateAction<Record<string, UsagePricingSaveState>>>
  clearAutoSaveTimer: (key: string) => void
  queueAutoSaveTimer: (key: string, callback: () => void, delayMs?: number) => void
  closeUsagePricingCurrencyMenu: () => void
  closeUsageScheduleCurrencyMenu: () => void
  refreshConfig: () => Promise<void>
  refreshUsageStatistics: (options?: { silent?: boolean }) => Promise<void>
  refreshUsageHistory: (options?: { silent?: boolean; keepEditCell?: boolean }) => Promise<void>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  normalizeCurrencyCode: (value: string) => string
  readPreferredCurrency: (providerName: string, apiKeyRef?: string) => string
  providerPreferredCurrency: (providerName: string) => string
  providerApiKeyLabel: (providerName: string) => string
  linkedProvidersForApiKey: (apiKeyRef: string, fallbackProvider: string) => string[]
  convertUsdToCurrency: (usdAmount: number, currency: string) => number
  convertCurrencyToUsd: (amount: number, currency: string) => number
  formatDraftAmount: (value: number) => string
  buildScheduleDraftFromPeriod: (...args: any[]) => ProviderScheduleDraft
  scheduleRowsSignature: (rows: ProviderScheduleDraft[]) => string
  scheduleSignaturesByProvider: (rows: ProviderScheduleDraft[], providers?: string[]) => Record<string, string>
  parseScheduleRowsForSaveWithResolver: (...args: any[]) => any
}

export function useUsagePricingScheduleActions(args: Args) {
  const pricingDraftSignature = useCallback(
    (draft: UsagePricingDraft): string => {
      return JSON.stringify({
        mode: draft.mode,
        amountText: draft.amountText.trim(),
        currency: args.normalizeCurrencyCode(draft.currency),
      })
    },
    [args],
  )

  const buildUsagePricingDraft = useCallback(
    (providerName: string, providerCfg?: Config['providers'][string]): UsagePricingDraft => {
      const mode = (providerCfg?.manual_pricing_mode ?? 'none') as UsagePricingMode
      const cachedCurrency = args.readPreferredCurrency(
        providerName,
        providerCfg?.key_preview?.trim() || (providerCfg?.has_key ? 'set' : '-'),
      )
      const currency = args.normalizeCurrencyCode(cachedCurrency)
      const amountUsd = providerCfg?.manual_pricing_amount_usd
      const amountText =
        amountUsd != null && Number.isFinite(amountUsd) && amountUsd > 0
          ? args.formatDraftAmount(args.convertUsdToCurrency(amountUsd, currency))
          : ''
      return { mode, amountText, currency }
    },
    [args],
  )

  const refreshFxRatesDaily = useCallback(
    async (force = false) => {
      const today = new Date().toISOString().slice(0, 10)
      if (!force && typeof window !== 'undefined') {
        try {
          const raw = window.localStorage.getItem(args.FX_RATES_CACHE_KEY)
          if (raw) {
            const cached = JSON.parse(raw) as { date?: string; rates?: Record<string, number> }
            if (cached?.date === today && cached.rates && Number.isFinite(cached.rates.USD)) {
              args.setFxRatesByCurrency(cached.rates)
              args.setFxRatesDate(cached.date)
              return
            }
          }
        } catch (error) {
          console.warn('Failed to read FX cache', error)
        }
      }
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
          args.setFxRatesByCurrency(rates)
          args.setFxRatesDate(date)
          if (typeof window !== 'undefined') {
            window.localStorage.setItem(args.FX_RATES_CACHE_KEY, JSON.stringify({ date, rates }))
          }
          return
        } catch (error) {
          console.warn('FX fetch failed', endpoint, error)
        }
      }
    },
    [args],
  )

  const openUsageScheduleModal = useCallback(
    async (providerName: string, seedCurrency?: string, options?: { keepVisible?: boolean }) => {
      if (!providerName) return
      const keepVisible = options?.keepVisible === true && args.usageScheduleModalOpen
      args.closeUsagePricingCurrencyMenu()
      args.closeUsageScheduleCurrencyMenu()
      args.setUsageScheduleProvider(providerName)
      args.setUsageScheduleModalOpen(true)
      if (!keepVisible) args.setUsageScheduleLoading(true)
      args.setUsageScheduleSaveState('idle')
      args.setUsageScheduleSaveError('')
      try {
        const providers = Array.from(
          new Set(
            [providerName, ...args.usageScheduleProviderOptions].filter(
              (name) => Boolean(name) && Boolean(args.config?.providers?.[name]),
            ),
          ),
        )
        const chunks = await Promise.all(
          providers.map(async (provider) => {
            const res = await invoke<{ ok: boolean; periods?: ProviderSchedulePeriod[] }>('get_provider_timeline', {
              provider,
            })
            const periods = Array.isArray(res?.periods) ? res.periods : []
            return { provider, periods }
          }),
        )
        const rowsByKey = new Map<string, ProviderScheduleDraft>()
        chunks.forEach(({ provider, periods }) => {
          const preferredCurrency =
            provider === providerName && seedCurrency ? seedCurrency : args.providerPreferredCurrency(provider)
          periods
            .sort((a, b) => a.started_at_unix_ms - b.started_at_unix_ms)
            .forEach((period) => {
              const apiKeyRef = (period.api_key_ref ?? args.providerApiKeyLabel(provider)).trim() || args.providerApiKeyLabel(provider)
              const linkedProviders = args.linkedProvidersForApiKey(apiKeyRef, provider)
              const canonicalProvider = linkedProviders[0] ?? provider
              const endMs = period.ended_at_unix_ms ?? null
              const dedupeKey = [
                apiKeyRef,
                period.mode ?? 'package_total',
                String(period.started_at_unix_ms),
                String(endMs ?? 'open'),
                Number.isFinite(period.amount_usd) ? period.amount_usd.toFixed(8) : String(period.amount_usd),
              ].join('|')
              const existing = rowsByKey.get(dedupeKey)
              if (existing) {
                const mergedProviders = Array.from(
                  new Set([...existing.groupProviders, ...linkedProviders, provider].filter(Boolean)),
                )
                rowsByKey.set(dedupeKey, { ...existing, groupProviders: mergedProviders })
                return
              }
              rowsByKey.set(
                dedupeKey,
                args.buildScheduleDraftFromPeriod(
                  canonicalProvider,
                  period,
                  preferredCurrency,
                  linkedProviders,
                  args.providerApiKeyLabel,
                  args.readPreferredCurrency,
                  args.fxRatesByCurrency,
                ),
              )
            })
        })
        const rows = Array.from(rowsByKey.values()).sort((a, b) =>
          a.provider.localeCompare(b.provider) ||
          a.startText.localeCompare(b.startText) ||
          a.endText.localeCompare(b.endText),
        )
        args.setUsageScheduleRows(rows)
        args.usageScheduleLastSavedSigRef.current = args.scheduleRowsSignature(rows)
        args.usageScheduleLastSavedByProviderRef.current = args.scheduleSignaturesByProvider(rows, providers)
        args.setUsageScheduleSaveState(rows.length > 0 ? 'saved' : 'idle')
        args.setUsageScheduleSaveError('')
      } catch (error) {
        args.flashToast(String(error), 'error')
        if (!keepVisible) {
          args.setUsageScheduleRows([])
          args.usageScheduleLastSavedSigRef.current = args.scheduleRowsSignature([])
          args.usageScheduleLastSavedByProviderRef.current = {}
        }
        args.setUsageScheduleSaveState('idle')
        args.setUsageScheduleSaveError('')
      } finally {
        args.setUsageScheduleLoading(false)
      }
    },
    [args],
  )

  const setUsagePricingSaveStateForProviders = useCallback(
    (providerNames: string[], state: UsagePricingSaveState) => {
      args.setUsagePricingSaveState((prev) => {
        const next = { ...prev }
        providerNames.forEach((providerName) => {
          next[providerName] = state
        })
        return next
      })
    },
    [args],
  )

  const resolvePricingAmountUsd = useCallback(
    (draft: UsagePricingDraft, fallbackAmountUsd?: number | null): number | null => {
      const amountRaw = Number(draft.amountText)
      if (Number.isFinite(amountRaw) && amountRaw > 0) {
        return args.convertCurrencyToUsd(amountRaw, draft.currency)
      }
      if (fallbackAmountUsd != null && Number.isFinite(fallbackAmountUsd) && fallbackAmountUsd > 0) {
        return fallbackAmountUsd
      }
      return null
    },
    [args],
  )

  const autoSaveUsageScheduleRows = useCallback(
    async (rows: ProviderScheduleDraft[], signature: string) => {
      const parsed = args.parseScheduleRowsForSaveWithResolver(rows, args.fxRatesByCurrency, args.providerApiKeyLabel)
      if (!parsed.ok) {
        args.setUsageScheduleSaveState('invalid')
        args.setUsageScheduleSaveError(parsed.reason)
        return
      }
      args.setUsageScheduleSaving(true)
      args.setUsageScheduleSaveState('saving')
      args.setUsageScheduleSaveError('')
      try {
        const prevByProvider = args.usageScheduleLastSavedByProviderRef.current
        const nextByProvider = args.scheduleSignaturesByProvider(rows)
        const providerNames = Array.from(new Set([...Object.keys(prevByProvider), ...Object.keys(nextByProvider)]))
        for (const provider of providerNames) {
          if (!args.config?.providers?.[provider]) continue
          const prevSig = prevByProvider[provider] ?? '[]'
          const nextSig = nextByProvider[provider] ?? '[]'
          if (prevSig === nextSig) continue
          await invoke('set_provider_timeline', {
            provider,
            periods: parsed.periodsByProvider[provider] ?? [],
          })
        }
        args.usageScheduleLastSavedByProviderRef.current = nextByProvider
        args.usageScheduleLastSavedSigRef.current = signature
        args.setUsageScheduleSaveState('saved')
        args.setUsageScheduleSaveError('')
        await args.refreshConfig()
        await args.refreshUsageStatistics({ silent: true })
        if (args.usageHistoryModalOpen) {
          await args.refreshUsageHistory({ silent: true })
        }
      } catch (error) {
        args.setUsageScheduleSaveState('error')
        const msg = String(error)
        args.setUsageScheduleSaveError(msg)
        args.flashToast(`Scheduled auto-save failed: ${msg}`, 'error')
      } finally {
        args.setUsageScheduleSaving(false)
      }
    },
    [args],
  )

  const activatePackageTotalMode = useCallback(
    async (
      providerName: string,
      draft: UsagePricingDraft,
      options?: { skipRefresh?: boolean; silentError?: boolean },
    ): Promise<boolean> => {
      const skipRefresh = options?.skipRefresh === true
      const silentError = options?.silentError === true
      const providerCfg = args.config?.providers?.[providerName]
      if (!providerCfg) return false
      const now = Date.now()
      let timelinePeriods: ProviderSchedulePeriod[] = []
      try {
        const res = await invoke<{ ok: boolean; periods?: ProviderSchedulePeriod[] }>('get_provider_timeline', {
          provider: providerName,
        })
        timelinePeriods = Array.isArray(res?.periods) ? res.periods : []
      } catch {
        timelinePeriods = []
      }

      const packagePeriods = timelinePeriods
        .filter((period) => (period.mode ?? 'package_total') === 'package_total')
        .filter((period) => Number.isFinite(period.amount_usd) && period.amount_usd > 0)
        .sort((a, b) => b.started_at_unix_ms - a.started_at_unix_ms)
      const activePackage = packagePeriods.find((period) => {
        const starts = period.started_at_unix_ms <= now
        const notEnded = period.ended_at_unix_ms == null || now < period.ended_at_unix_ms
        return starts && notEnded
      })
      const upcomingPackage = packagePeriods.find((period) => period.started_at_unix_ms > now)

      let amountUsd = resolvePricingAmountUsd(draft, providerCfg.manual_pricing_amount_usd ?? null)
      if (amountUsd == null && packagePeriods.length > 0) amountUsd = packagePeriods[0].amount_usd
      if (amountUsd == null) {
        args.setUsagePricingSaveState((prev) => ({ ...prev, [providerName]: 'idle' }))
        return false
      }
      args.setUsagePricingSaveState((prev) => ({ ...prev, [providerName]: 'saving' }))
      try {
        if (activePackage || upcomingPackage) {
          const rewrittenPeriods = timelinePeriods.map((period) => {
            const mode = (period.mode ?? 'package_total') as 'per_request' | 'package_total'
            const inActiveOrUpcomingWindow =
              mode === 'package_total' &&
              (period.started_at_unix_ms >= now ||
                (period.started_at_unix_ms <= now &&
                  (period.ended_at_unix_ms == null || now < period.ended_at_unix_ms)))
            return {
              id: period.id,
              mode,
              amount_usd: inActiveOrUpcomingWindow ? amountUsd : period.amount_usd,
              api_key_ref: period.api_key_ref ?? args.providerApiKeyLabel(providerName),
              started_at_unix_ms: period.started_at_unix_ms,
              ended_at_unix_ms: period.ended_at_unix_ms ?? undefined,
            }
          })
          await invoke('set_provider_timeline', {
            provider: providerName,
            periods: rewrittenPeriods,
          })
        } else {
          await invoke('set_provider_manual_pricing', {
            provider: providerName,
            mode: 'package_total',
            amountUsd,
            packageExpiresAtUnixMs: null,
          })
        }
        await invoke('set_provider_gap_fill', {
          provider: providerName,
          mode: 'none',
          amountUsd: null,
        })
        args.usagePricingLastSavedSigRef.current[providerName] = pricingDraftSignature({
          ...draft,
          amountText: args.formatDraftAmount(args.convertUsdToCurrency(amountUsd, draft.currency)),
        })
        args.setUsagePricingSaveState((prev) => ({ ...prev, [providerName]: 'saved' }))
        if (!skipRefresh) {
          await args.refreshConfig()
          await args.refreshUsageStatistics({ silent: true })
        }
        return true
      } catch (error) {
        args.setUsagePricingSaveState((prev) => ({ ...prev, [providerName]: 'error' }))
        if (!silentError) args.flashToast(String(error), 'error')
        return false
      }
    },
    [args, pricingDraftSignature, resolvePricingAmountUsd],
  )

  const saveUsagePricingRow = useCallback(
    async (
      providerName: string,
      options?: { silent?: boolean; draftOverride?: UsagePricingDraft; skipRefresh?: boolean },
    ): Promise<boolean> => {
      const silent = options?.silent === true
      const skipRefresh = options?.skipRefresh === true
      const draft = options?.draftOverride ?? args.usagePricingDrafts[providerName]
      if (!draft) return false
      const mode = draft.mode
      if (mode === 'package_total') {
        const activated = await activatePackageTotalMode(providerName, draft, {
          skipRefresh,
          silentError: silent,
        })
        if (silent || !activated) return activated
        await openUsageScheduleModal(providerName, draft.currency)
        return true
      }
      try {
        if (mode === 'none') {
          await invoke('set_provider_manual_pricing', {
            provider: providerName,
            mode: 'none',
            amountUsd: null,
            packageExpiresAtUnixMs: null,
          })
        } else {
          const amountRaw = Number(draft.amountText)
          if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
            if (!silent) args.flashToast('Pricing amount must be > 0', 'error')
            return false
          }
          const amountUsd = args.convertCurrencyToUsd(amountRaw, draft.currency)
          await invoke('set_provider_manual_pricing', {
            provider: providerName,
            mode,
            amountUsd,
            packageExpiresAtUnixMs: null,
          })
        }
        await invoke('set_provider_gap_fill', {
          provider: providerName,
          mode: 'none',
          amountUsd: null,
        })
        if (!silent) args.flashToast(`Pricing saved: ${providerName}`)
        if (!skipRefresh) {
          await args.refreshConfig()
          await args.refreshUsageStatistics({ silent })
        }
        return true
      } catch (error) {
        if (!silent) args.flashToast(String(error), 'error')
        return false
      }
    },
    [activatePackageTotalMode, args, openUsageScheduleModal],
  )

  const saveUsagePricingForProviders = useCallback(
    async (providerNames: string[], draft: UsagePricingDraft, options?: { silent?: boolean }): Promise<boolean> => {
      const silent = options?.silent === true
      const targets = providerNames.filter((providerName) => Boolean(args.config?.providers?.[providerName]))
      if (!targets.length) return false
      let draftForSave = draft
      if (draft.mode === 'package_total') {
        let sharedAmountUsd = resolvePricingAmountUsd(draft, null)
        if (sharedAmountUsd == null) {
          for (const providerName of targets) {
            try {
              const res = await invoke<{ ok: boolean; periods?: ProviderSchedulePeriod[] }>('get_provider_timeline', {
                provider: providerName,
              })
              const periods = Array.isArray(res?.periods) ? res.periods : []
              const latest = periods
                .filter((period) => (period.mode ?? 'package_total') === 'package_total')
                .filter((period) => Number.isFinite(period.amount_usd) && period.amount_usd > 0)
                .sort((a, b) => b.started_at_unix_ms - a.started_at_unix_ms)[0]
              if (latest) {
                sharedAmountUsd = latest.amount_usd
                break
              }
            } catch {
              // Ignore read failure and continue other providers.
            }
          }
        }
        if (sharedAmountUsd != null) {
          draftForSave = {
            ...draft,
            amountText: args.formatDraftAmount(args.convertUsdToCurrency(sharedAmountUsd, draft.currency)),
          }
        }
      }
      let allOk = true
      for (const providerName of targets) {
        const ok = await saveUsagePricingRow(providerName, {
          silent: true,
          draftOverride: draftForSave,
          skipRefresh: true,
        })
        if (!ok) allOk = false
      }
      if (allOk) {
        await args.refreshConfig()
        await args.refreshUsageStatistics({ silent: true })
        return true
      }
      if (!silent) args.flashToast('Failed to save linked pricing row', 'error')
      return false
    },
    [args, resolvePricingAmountUsd, saveUsagePricingRow],
  )

  const queueUsagePricingAutoSaveForProviders = useCallback(
    (providerNames: string[], draft: UsagePricingDraft) => {
      if (!args.usagePricingModalOpen) return
      const targets = providerNames.filter((providerName) => Boolean(args.config?.providers?.[providerName]))
      if (!targets.length) return
      if (draft.mode === 'package_total') {
        setUsagePricingSaveStateForProviders(targets, 'idle')
        return
      }
      const signature = pricingDraftSignature(draft)
      if (targets.every((providerName) => args.usagePricingLastSavedSigRef.current[providerName] === signature)) {
        setUsagePricingSaveStateForProviders(targets, 'saved')
        return
      }
      const timerKey = `pricing:${targets.join('|')}`
      args.clearAutoSaveTimer(timerKey)
      setUsagePricingSaveStateForProviders(targets, 'idle')
      args.queueAutoSaveTimer(timerKey, () => {
        void (async () => {
          setUsagePricingSaveStateForProviders(targets, 'saving')
          const ok = await saveUsagePricingForProviders(targets, draft, { silent: true })
          if (ok) {
            targets.forEach((providerName) => {
              args.usagePricingLastSavedSigRef.current[providerName] = signature
            })
            setUsagePricingSaveStateForProviders(targets, 'saved')
          } else {
            setUsagePricingSaveStateForProviders(targets, 'error')
          }
        })()
      })
    },
    [args, pricingDraftSignature, saveUsagePricingForProviders, setUsagePricingSaveStateForProviders],
  )

  return {
    pricingDraftSignature,
    buildUsagePricingDraft,
    refreshFxRatesDaily,
    openUsageScheduleModal,
    setUsagePricingSaveStateForProviders,
    resolvePricingAmountUsd,
    autoSaveUsageScheduleRows,
    activatePackageTotalMode,
    saveUsagePricingRow,
    saveUsagePricingForProviders,
    queueUsagePricingAutoSaveForProviders,
  }
}
