import { useMemo } from 'react'

import type { Config, ProviderSwitchboardStatus, Status } from '../types'
import { fmtAmount, fmtPct, fmtUsd, pctOf } from '../utils/format'

type Args = {
  config: Config | null
  status: Status | null
  orderedConfigProviders: string[]
  providerSwitchStatus: ProviderSwitchboardStatus | null
  providerApiKeyLabel: (providerName: string) => string
}

export function useSwitchboardView({
  config,
  status,
  orderedConfigProviders,
  providerSwitchStatus,
  providerApiKeyLabel,
}: Args) {
  const managedProviderNames = useMemo(() => {
    if (config?.providers) {
      const fromOrder = orderedConfigProviders.filter((name) => Boolean(config.providers[name]))
      const leftovers = Object.keys(config.providers)
        .filter((name) => !fromOrder.includes(name))
        .sort((a, b) => a.localeCompare(b))
      return [...fromOrder, ...leftovers].filter((name) => name !== 'official')
    }
    const fromSwitchboard = providerSwitchStatus?.provider_options ?? []
    const fromStatus = status?.providers ? Object.keys(status.providers) : []
    return Array.from(new Set([...fromSwitchboard, ...fromStatus])).filter(
      (name) => Boolean(name) && name !== 'official',
    )
  }, [config, orderedConfigProviders, providerSwitchStatus?.provider_options, status?.providers])

  const providerGroupLabelByName = useMemo(() => {
    const grouped = new Map<string, string[]>()
    managedProviderNames.forEach((providerName) => {
      const keyLabel = providerApiKeyLabel(providerName).trim()
      if (!keyLabel || keyLabel === '-' || keyLabel === 'set') return
      const names = grouped.get(keyLabel) ?? []
      names.push(providerName)
      grouped.set(keyLabel, names)
    })
    const labels: Record<string, string> = {}
    grouped.forEach((names) => {
      if (names.length < 2) return
      const merged = names.join(' / ')
      names.forEach((name) => {
        labels[name] = merged
      })
    })
    return labels
  }, [managedProviderNames, providerApiKeyLabel])

  const providerNamesByKeyLabel = useMemo(() => {
    const grouped = new Map<string, string[]>()
    managedProviderNames.forEach((providerName) => {
      const keyLabel = providerApiKeyLabel(providerName).trim()
      if (!keyLabel || keyLabel === '-' || keyLabel === 'set') return
      const names = grouped.get(keyLabel) ?? []
      names.push(providerName)
      grouped.set(keyLabel, names)
    })
    return grouped
  }, [managedProviderNames, providerApiKeyLabel])

  const switchboardProviderCards = useMemo(() => {
    return managedProviderNames.map((name) => {
      const providerCfg = config?.providers?.[name]
      const quota = status?.quota?.[name]
      const kind = (quota?.kind ?? 'none') as 'none' | 'token_stats' | 'budget_info'
      let usageHeadline = 'No usage data'
      let usageDetail = 'Refresh after first request'
      let usageSub: string | null = null
      let usagePct: number | null = null

      if (kind === 'token_stats') {
        const total = quota?.today_added ?? null
        const remaining = quota?.remaining ?? null
        const used = quota?.today_used ?? (total != null && remaining != null ? total - remaining : null)
        const remainingPct = pctOf(remaining ?? null, total)
        const usedPct = pctOf(used ?? null, total)
        usageHeadline = `Remaining ${fmtPct(remainingPct)}`
        usageDetail = `Today ${fmtAmount(used)} / ${fmtAmount(total)}`
        usageSub = usedPct == null ? null : `Used ${fmtPct(usedPct)}`
        usagePct = remainingPct
      } else if (kind === 'budget_info') {
        const dailySpent = quota?.daily_spent_usd ?? null
        const dailyBudget = quota?.daily_budget_usd ?? null
        const dailyLeft = dailySpent != null && dailyBudget != null ? Math.max(0, dailyBudget - dailySpent) : null
        const dailyLeftPct = pctOf(dailyLeft, dailyBudget)
        usageHeadline = `Remaining ${fmtPct(dailyLeftPct)} (Daily)`
        usageDetail = `Daily $${fmtUsd(dailySpent)} / $${fmtUsd(dailyBudget)}`
        const hasWeekly = quota?.weekly_spent_usd != null && quota?.weekly_budget_usd != null
        const hasMonthly = quota?.monthly_spent_usd != null || quota?.monthly_budget_usd != null
        if (hasWeekly) {
          usageSub = `Weekly $${fmtUsd(quota?.weekly_spent_usd)} / $${fmtUsd(quota?.weekly_budget_usd)}`
        } else if (hasMonthly) {
          usageSub = `Monthly $${fmtUsd(quota?.monthly_spent_usd)} / $${fmtUsd(quota?.monthly_budget_usd)}`
        }
        usagePct = dailyLeftPct
      }

      return {
        name,
        baseUrl: providerCfg?.base_url ?? '',
        hasKey: Boolean(providerCfg?.has_key),
        usageHeadline,
        usageDetail,
        usageSub,
        usagePct,
      }
    })
  }, [config, managedProviderNames, status])

  const switchboardModeLabel = providerSwitchStatus?.mode ?? '-'
  const switchboardModelProviderLabel = useMemo(() => {
    const mode = providerSwitchStatus?.mode
    const raw = (providerSwitchStatus?.model_provider ?? '').trim()
    if (mode === 'gateway') return 'api_router'
    if (mode === 'official') return 'official default'
    if (mode === 'provider') return raw || '-'
    if (mode === 'mixed') return raw ? `mixed (${raw})` : 'mixed'
    return '-'
  }, [providerSwitchStatus])
  const switchboardTargetDirsLabel = providerSwitchStatus?.dirs?.map((dir) => dir.cli_home).join(' | ') || '-'

  const providerDisplayName = (providerName: string): string => {
    return providerGroupLabelByName[providerName] ?? providerName
  }

  const linkedProvidersForApiKey = (apiKeyRef: string, fallbackProvider: string): string[] => {
    const key = apiKeyRef.trim()
    if (!key || key === '-' || key === 'set') return [fallbackProvider]
    const linked = providerNamesByKeyLabel.get(key) ?? []
    const unique = Array.from(new Set([...linked, fallbackProvider].filter(Boolean)))
    return unique.length ? unique : [fallbackProvider]
  }

  return {
    managedProviderNames,
    providerDisplayName,
    linkedProvidersForApiKey,
    switchboardProviderCards,
    switchboardModeLabel,
    switchboardModelProviderLabel,
    switchboardTargetDirsLabel,
  }
}
