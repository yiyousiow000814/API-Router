import type { Config, Status } from '../types'
import type { ProviderCapsMenuState } from '../components/ProviderCapsMenuPortal'
import { getVisibleBudgetHardCapPeriods, isBudgetInfoQuota } from './providerBudgetWindows'

export type ProviderCapsMenuData = {
  provider: string
  left: number
  top: number
  editable: boolean
  quotaHardCap: { daily: boolean; weekly: boolean; monthly: boolean }
  periods: ReturnType<typeof getVisibleBudgetHardCapPeriods>
} | null

export function buildProviderCapsMenuData(
  configModalOpen: boolean,
  config: Config | null,
  status: Status | null,
  menu: ProviderCapsMenuState,
): ProviderCapsMenuData {
  if (!configModalOpen || !menu) return null

  const provider = config?.providers?.[menu.provider]
  const quota = status?.quota?.[menu.provider]
  if (!provider || !isBudgetInfoQuota(quota)) return null

  return {
    ...menu,
    editable: provider.editable !== false,
    quotaHardCap: provider.quota_hard_cap ?? { daily: true, weekly: true, monthly: true },
    periods: getVisibleBudgetHardCapPeriods(quota),
  }
}
