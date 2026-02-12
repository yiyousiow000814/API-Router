import { invoke } from '@tauri-apps/api/core'
import { formatDraftAmount, parsePositiveAmount } from '../utils/currency'
import { resolvePricingAmountUsd as computePricingAmountUsd } from '../utils/usagePricing'
import { historyDraftFromRow as buildHistoryDraftFromRow } from '../utils/usageSchedule'
import { buildDevMockHistoryRows } from '../devMockData'

type Params = Record<string, any>

export function useUsagePricingHistoryActions(params: Params) {
  const {
    config,
    fxRatesByCurrency,
    convertCurrencyToUsd,
    convertUsdToCurrency,
    providerApiKeyLabel,
    setUsagePricingSaveState,
    usagePricingLastSavedSigRef,
    pricingDraftSignature,
    refreshConfig,
    refreshUsageStatistics,
    flashToast,
    usagePricingModalOpen,
    clearAutoSaveTimer,
    queueAutoSaveTimer,
    usagePricingDrafts,
    openUsageScheduleModal,
    setUsageHistoryLoading,
    devMockHistoryEnabled,
    isDevPreview,
    setUsageHistoryRows,
    usageHistoryLoadedRef,
    setUsageHistoryDrafts,
    setUsageHistoryEditCell,
    usageHistoryModalOpen,
    usageHistoryDrafts,
    historyDraftFromRow,
    historyEffectiveDisplayValue,
    historyPerReqDisplayValue,
  } = params

  function resolvePricingAmountUsd(draft: any, fallbackAmountUsd?: number | null): number | null {
    return computePricingAmountUsd(
      draft,
      fallbackAmountUsd,
      (amount, currency) => convertCurrencyToUsd(fxRatesByCurrency, amount, currency),
    )
  }

  function setUsagePricingSaveStateForProviders(providerNames: string[], state: any) {
    setUsagePricingSaveState((prev: Record<string, any>) => {
      const next = { ...prev }
      providerNames.forEach((providerName) => {
        next[providerName] = state
      })
      return next
    })
  }

  async function activatePackageTotalMode(providerName: string, draft: any, options?: any): Promise<boolean> {
    const skipRefresh = options?.skipRefresh === true
    const silentError = options?.silentError === true
    const providerCfg = config?.providers?.[providerName]
    if (!providerCfg) return false
    const now = Date.now()
    let timelinePeriods: any[] = []
    try {
      const res = await invoke<{ ok: boolean; periods?: any[] }>('get_provider_timeline', { provider: providerName })
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
      setUsagePricingSaveState((prev: Record<string, any>) => ({ ...prev, [providerName]: 'idle' }))
      return false
    }
    setUsagePricingSaveState((prev: Record<string, any>) => ({ ...prev, [providerName]: 'saving' }))
    try {
      if (activePackage || upcomingPackage) {
        const rewrittenPeriods = timelinePeriods.map((period) => {
          const mode = period.mode ?? 'package_total'
          const inActiveOrUpcomingWindow =
            mode === 'package_total' &&
            (period.started_at_unix_ms >= now ||
              (period.started_at_unix_ms <= now &&
                (period.ended_at_unix_ms == null || now < period.ended_at_unix_ms)))
          return {
            id: period.id,
            mode,
            amount_usd: inActiveOrUpcomingWindow ? amountUsd : period.amount_usd,
            api_key_ref: period.api_key_ref ?? providerApiKeyLabel(providerName),
            started_at_unix_ms: period.started_at_unix_ms,
            ended_at_unix_ms: period.ended_at_unix_ms ?? undefined,
          }
        })
        await invoke('set_provider_timeline', { provider: providerName, periods: rewrittenPeriods })
      } else {
        await invoke('set_provider_manual_pricing', {
          provider: providerName,
          mode: 'package_total',
          amountUsd,
          packageExpiresAtUnixMs: null,
        })
      }
      await invoke('set_provider_gap_fill', { provider: providerName, mode: 'none', amountUsd: null })
      usagePricingLastSavedSigRef.current[providerName] = pricingDraftSignature({
        ...draft,
        amountText: formatDraftAmount(convertUsdToCurrency(fxRatesByCurrency, amountUsd, draft.currency)),
      })
      setUsagePricingSaveState((prev: Record<string, any>) => ({ ...prev, [providerName]: 'saved' }))
      if (!skipRefresh) {
        await refreshConfig()
        await refreshUsageStatistics({ silent: true })
      }
      return true
    } catch (e) {
      setUsagePricingSaveState((prev: Record<string, any>) => ({ ...prev, [providerName]: 'error' }))
      if (!silentError) flashToast(String(e), 'error')
      return false
    }
  }

  async function saveUsagePricingRow(providerName: string, options?: any): Promise<boolean> {
    const silent = options?.silent === true
    const skipRefresh = options?.skipRefresh === true
    const draft = options?.draftOverride ?? usagePricingDrafts[providerName]
    if (!draft) return false
    const mode = draft.mode
    if (mode === 'package_total') {
      const activated = await activatePackageTotalMode(providerName, draft, { skipRefresh, silentError: silent })
      if (silent || !activated) return activated
      await openUsageScheduleModal(providerName, draft.currency)
      return true
    }
    try {
      if (mode === 'none') {
        await invoke('set_provider_manual_pricing', { provider: providerName, mode: 'none', amountUsd: null, packageExpiresAtUnixMs: null })
      } else {
        const amountRaw = Number(draft.amountText)
        if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
          if (!silent) flashToast('Pricing amount must be > 0', 'error')
          return false
        }
        const amountUsd = convertCurrencyToUsd(fxRatesByCurrency, amountRaw, draft.currency)
        await invoke('set_provider_manual_pricing', { provider: providerName, mode, amountUsd, packageExpiresAtUnixMs: null })
      }
      await invoke('set_provider_gap_fill', { provider: providerName, mode: 'none', amountUsd: null })
      if (!silent) flashToast(`Pricing saved: ${providerName}`)
      if (!skipRefresh) {
        await refreshConfig()
        await refreshUsageStatistics({ silent })
      }
      return true
    } catch (e) {
      if (!silent) flashToast(String(e), 'error')
      return false
    }
  }

  async function saveUsagePricingForProviders(providerNames: string[], draft: any, options?: any): Promise<boolean> {
    const silent = options?.silent === true
    const targets = providerNames.filter((providerName) => Boolean(config?.providers?.[providerName]))
    if (!targets.length) return false
    let draftForSave = draft
    if (draft.mode === 'package_total') {
      let sharedAmountUsd = resolvePricingAmountUsd(draft, null)
      if (sharedAmountUsd == null) {
        for (const providerName of targets) {
          try {
            const res = await invoke<{ ok: boolean; periods?: any[] }>('get_provider_timeline', { provider: providerName })
            const periods = Array.isArray(res?.periods) ? res.periods : []
            const latest = periods
              .filter((period) => (period.mode ?? 'package_total') === 'package_total')
              .filter((period) => Number.isFinite(period.amount_usd) && period.amount_usd > 0)
              .sort((a, b) => b.started_at_unix_ms - a.started_at_unix_ms)[0]
            if (latest) {
              sharedAmountUsd = latest.amount_usd
              break
            }
          } catch {}
        }
      }
      if (sharedAmountUsd != null) {
        draftForSave = {
          ...draft,
          amountText: formatDraftAmount(convertUsdToCurrency(fxRatesByCurrency, sharedAmountUsd, draft.currency)),
        }
      }
    }
    let allOk = true
    for (const providerName of targets) {
      const ok = await saveUsagePricingRow(providerName, { silent: true, draftOverride: draftForSave, skipRefresh: true })
      if (!ok) allOk = false
    }
    if (allOk) {
      await refreshConfig()
      await refreshUsageStatistics({ silent: true })
      return true
    }
    if (!silent) flashToast('Failed to save linked pricing row', 'error')
    return false
  }

  function queueUsagePricingAutoSaveForProviders(providerNames: string[], draft: any) {
    if (!usagePricingModalOpen) return
    const targets = providerNames.filter((providerName) => Boolean(config?.providers?.[providerName]))
    if (!targets.length) return
    if (draft.mode === 'package_total') {
      setUsagePricingSaveStateForProviders(targets, 'idle')
      return
    }
    const signature = pricingDraftSignature(draft)
    if (targets.every((providerName) => usagePricingLastSavedSigRef.current[providerName] === signature)) {
      setUsagePricingSaveStateForProviders(targets, 'saved')
      return
    }
    const timerKey = `pricing:${targets.join('|')}`
    clearAutoSaveTimer(timerKey)
    setUsagePricingSaveStateForProviders(targets, 'idle')
    queueAutoSaveTimer(timerKey, () => {
      void (async () => {
        setUsagePricingSaveStateForProviders(targets, 'saving')
        const ok = await saveUsagePricingForProviders(targets, draft, { silent: true })
        if (ok) {
          targets.forEach((providerName) => {
            usagePricingLastSavedSigRef.current[providerName] = signature
          })
          setUsagePricingSaveStateForProviders(targets, 'saved')
        } else {
          setUsagePricingSaveStateForProviders(targets, 'error')
        }
      })()
    })
  }

  async function refreshUsageHistory(options?: { silent?: boolean; keepEditCell?: boolean }) {
    const silent = options?.silent === true
    const keepEditCell = options?.keepEditCell === true
    if (!silent) setUsageHistoryLoading(true)
    try {
      let rows: any[] = []
      if (devMockHistoryEnabled) rows = buildDevMockHistoryRows(120)
      else if (isDevPreview) rows = []
      else {
        const res = await invoke<{ ok: boolean; rows: any[] }>('get_spend_history', { provider: null, days: 180, compactOnly: true })
        rows = Array.isArray(res?.rows) ? res.rows : []
      }
      setUsageHistoryRows(rows)
      usageHistoryLoadedRef.current = true
      setUsageHistoryDrafts(() => {
        const next: Record<string, any> = {}
        for (const row of rows) {
          const key = `${row.provider}|${row.day_key}`
          next[key] = buildHistoryDraftFromRow(row, formatDraftAmount)
        }
        return next
      })
      if (!keepEditCell) setUsageHistoryEditCell(null)
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      if (!silent) setUsageHistoryLoading(false)
    }
  }

  function queueUsageHistoryAutoSave(row: any, field: 'effective' | 'per_req') {
    if (!usageHistoryModalOpen) return
    queueAutoSaveTimer('history:edit', () => {
      void saveUsageHistoryRow(row, { silent: true, keepEditCell: true, field })
    })
  }

  async function saveUsageHistoryRow(row: any, options?: { silent?: boolean; keepEditCell?: boolean; field?: 'effective' | 'per_req' }) {
    const silent = options?.silent === true
    const keepEditCell = options?.keepEditCell === true
    const field = options?.field ?? 'effective'
    const key = `${row.provider}|${row.day_key}`
    const draft = usageHistoryDrafts[key] ?? historyDraftFromRow(row)
    const effectiveDraft = parsePositiveAmount(draft.effectiveText)
    const effectiveNow = historyEffectiveDisplayValue(row)
    const perReqDraft = parsePositiveAmount(draft.perReqText)
    const perReqNow = historyPerReqDisplayValue(row)
    const trackedBase = row.tracked_total_usd ?? 0
    const scheduledBase = row.scheduled_total_usd ?? 0
    const closeEnough = (a: number, b: number) => Math.abs(a - b) < 0.0005
    const effectiveChanged = effectiveDraft != null && (effectiveNow == null || !closeEnough(effectiveDraft, effectiveNow))
    const perReqChanged = perReqDraft != null && (perReqNow == null || !closeEnough(perReqDraft, perReqNow))
    let totalUsedUsd: number | null = null
    let usdPerReq: number | null = null

    if (field === 'per_req' && perReqChanged) {
      totalUsedUsd = null
      usdPerReq = perReqDraft
    } else if (field === 'effective' && effectiveChanged) {
      const minimum = trackedBase + scheduledBase
      if (effectiveDraft < minimum - 0.0005) {
        if (!silent) flashToast('Effective $ cannot be lower than tracked + scheduled', 'error')
        return
      }
      const delta = effectiveDraft - minimum
      totalUsedUsd = delta > 0.0005 ? delta : null
      usdPerReq = null
    } else {
      if (!silent) flashToast('No history change to save')
      return
    }
    try {
      await invoke('set_spend_history_entry', { provider: row.provider, dayKey: row.day_key, totalUsedUsd, usdPerReq })
      if (!silent) flashToast(`History saved: ${row.provider} ${row.day_key}`)
      await refreshUsageHistory({ silent: true, keepEditCell })
      await refreshUsageStatistics({ silent: true })
    } catch (e) {
      if (!silent) flashToast(String(e), 'error')
    }
  }

  return {
    setUsagePricingSaveStateForProviders,
    saveUsagePricingForProviders,
    queueUsagePricingAutoSaveForProviders,
    refreshUsageHistory,
    queueUsageHistoryAutoSave,
    saveUsageHistoryRow,
  }
}
