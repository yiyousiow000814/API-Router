import type { CodexSwapStatus, Config, ProviderSwitchboardStatus, Status } from '../types'
import { GATEWAY_MODEL_PROVIDER_ID } from '../constants'
import { normalizePathForCompare } from './path'

export function resolveCliHomes(dir1: string, dir2: string, applyBoth: boolean): string[] {
  const first = dir1.trim()
  const second = dir2.trim()
  if (!first) return []
  if (!applyBoth || !second) return [first]
  if (normalizePathForCompare(first) === normalizePathForCompare(second)) return [first]
  return [first, second]
}

export function buildCodexSwapBadge(
  codexSwapStatus: CodexSwapStatus | null,
  providerSwitchStatus: ProviderSwitchboardStatus | null,
): { badgeText: string; badgeTitle: string } {
  if (!codexSwapStatus && !providerSwitchStatus) {
    return { badgeText: '', badgeTitle: 'Codex CLI swap status: loading' }
  }
  const mode = providerSwitchStatus?.mode
  const switchboardLabel =
    mode === 'provider'
      ? 'DP' + (providerSwitchStatus?.model_provider ? ':' + providerSwitchStatus.model_provider : '')
      : mode === 'official'
        ? 'Auth'
        : mode === 'gateway'
          ? 'API'
          : mode === 'mixed'
            ? 'Mixed'
            : null
  const overall = codexSwapStatus?.overall
  const swapFallbackLabel =
    overall === 'swapped'
      ? 'Auth'
      : overall === 'original'
        ? 'API'
        : overall === 'mixed'
          ? 'Mixed'
          : overall === 'error'
            ? 'Error'
            : 'Loading'
  const badgeText = switchboardLabel ?? swapFallbackLabel
  const parts =
    providerSwitchStatus?.dirs?.length
      ? providerSwitchStatus.dirs.map((d) => {
          const modeText = d.mode === 'provider' ? 'provider:' + (d.model_provider ?? '-') : d.mode
          return d.cli_home + ': ' + modeText
        })
      : codexSwapStatus?.dirs?.length
        ? codexSwapStatus.dirs.map((d) => d.cli_home + ': ' + d.state)
        : []
  const badgeTitle = parts.length
    ? 'Codex CLI swap status: ' + badgeText + '. ' + parts.join(' | ')
    : 'Codex CLI swap status: ' + badgeText
  return { badgeText, badgeTitle }
}

export function buildManagedProviderNames(
  config: Config | null,
  orderedConfigProviders: string[],
  providerSwitchStatus: ProviderSwitchboardStatus | null,
  status: Status | null,
): string[] {
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
}

export function buildProviderGroupLabelByName(
  managedProviderNames: string[],
  providerApiKeyLabel: (providerName: string) => string,
): Record<string, string> {
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
}

export function buildProviderNamesByKeyLabel(
  managedProviderNames: string[],
  providerApiKeyLabel: (providerName: string) => string,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  managedProviderNames.forEach((providerName) => {
    const keyLabel = providerApiKeyLabel(providerName).trim()
    if (!keyLabel || keyLabel === '-' || keyLabel === 'set') return
    const names = grouped.get(keyLabel) ?? []
    names.push(providerName)
    grouped.set(keyLabel, names)
  })
  return grouped
}

export function linkedProvidersForApiKey(
  providerNamesByKeyLabel: Map<string, string[]>,
  apiKeyRef: string,
  fallbackProvider: string,
): string[] {
  const key = apiKeyRef.trim()
  if (!key || key === '-' || key === 'set') return [fallbackProvider]
  const linked = providerNamesByKeyLabel.get(key) ?? []
  const unique = Array.from(new Set([...linked, fallbackProvider].filter(Boolean)))
  return unique.length ? unique : [fallbackProvider]
}

type SwitchboardCard = {
  name: string
  baseUrl: string
  hasKey: boolean
  usageHeadline: string
  usageDetail: string
  usageSub: string | null
  usagePct: number | null
}

export function buildSwitchboardProviderCards(
  managedProviderNames: string[],
  config: Config | null,
  status: Status | null,
  options: {
    fmtPct: (value: number | null) => string
    fmtAmount: (value: number | null) => string
    fmtUsd: (value: number | null) => string
    pctOf: (value: number | null, total: number | null) => number | null
  },
): SwitchboardCard[] {
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
      const remainingPct = options.pctOf(remaining ?? null, total)
      const usedPct = options.pctOf(used ?? null, total)
      usageHeadline = `Remaining ${options.fmtPct(remainingPct)}`
      usageDetail = `Today ${options.fmtAmount(used)} / ${options.fmtAmount(total)}`
      usageSub = usedPct == null ? null : `Used ${options.fmtPct(usedPct)}`
      usagePct = remainingPct
    } else if (kind === 'budget_info') {
      const dailySpent = quota?.daily_spent_usd ?? null
      const dailyBudget = quota?.daily_budget_usd ?? null
      const dailyLeft = dailySpent != null && dailyBudget != null ? Math.max(0, dailyBudget - dailySpent) : null
      const dailyLeftPct = options.pctOf(dailyLeft, dailyBudget)
      usageHeadline = `Remaining ${options.fmtPct(dailyLeftPct)} (Daily)`
      usageDetail = `Daily $${options.fmtUsd(dailySpent)} / $${options.fmtUsd(dailyBudget)}`
      const hasWeekly = quota?.weekly_spent_usd != null && quota?.weekly_budget_usd != null
      const hasMonthly = quota?.monthly_spent_usd != null || quota?.monthly_budget_usd != null
      if (hasWeekly) {
        usageSub = `Weekly $${options.fmtUsd(quota?.weekly_spent_usd ?? null)} / $${options.fmtUsd(quota?.weekly_budget_usd ?? null)}`
      } else if (hasMonthly) {
        usageSub = `Monthly $${options.fmtUsd(quota?.monthly_spent_usd ?? null)} / $${options.fmtUsd(quota?.monthly_budget_usd ?? null)}`
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
}

export function buildSwitchboardModelProviderLabel(
  providerSwitchStatus: ProviderSwitchboardStatus | null,
): string {
  const mode = providerSwitchStatus?.mode
  const raw = (providerSwitchStatus?.model_provider ?? '').trim()
  if (mode === 'gateway') return GATEWAY_MODEL_PROVIDER_ID
  if (mode === 'official') return 'official default'
  if (mode === 'provider') return raw || '-'
  if (mode === 'mixed') return raw ? `mixed (${raw})` : 'mixed'
  return '-'
}
