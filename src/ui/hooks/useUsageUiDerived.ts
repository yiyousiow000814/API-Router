import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useMemo } from 'react'
import type { UsageScheduleSaveState } from '../types/usage'
import { sanitizeSelectedFilterValues } from '../utils/usageStatisticsView'

type Params = {
  providerGroupLabelByName: Record<string, string>
  usageScheduleSaveState: UsageScheduleSaveState
  usageScheduleSaveError: string
  setUsageFilterProviders: Dispatch<SetStateAction<string[]>>
  usageProviderFilterOptions: string[]
  setUsageFilterModels: Dispatch<SetStateAction<string[]>>
  usageModelFilterOptions: string[]
}

export function useUsageUiDerived(params: Params) {
  const {
    providerGroupLabelByName,
    usageScheduleSaveState,
    usageScheduleSaveError,
    setUsageFilterProviders,
    usageProviderFilterOptions,
    setUsageFilterModels,
    usageModelFilterOptions,
  } = params

  function providerDisplayName(providerName: string): string {
    return providerGroupLabelByName[providerName] ?? providerName
  }

  const usageScheduleSaveStatusText = useMemo(() => {
    if (usageScheduleSaveState === 'saving') return 'Auto-saving...'
    if (usageScheduleSaveState === 'saved') return 'Auto-saved'
    if (usageScheduleSaveState === 'invalid') {
      return usageScheduleSaveError
        ? `Auto-save paused: ${usageScheduleSaveError}`
        : 'Auto-save paused (complete row to save)'
    }
    if (usageScheduleSaveState === 'error') {
      return usageScheduleSaveError ? `Auto-save failed: ${usageScheduleSaveError}` : 'Auto-save failed'
    }
    return 'Auto-save'
  }, [usageScheduleSaveError, usageScheduleSaveState])

  useEffect(() => {
    setUsageFilterProviders((prev: string[]) => {
      const next = sanitizeSelectedFilterValues(prev, usageProviderFilterOptions)
      if (next.length === prev.length && next.every((value, index) => value === prev[index])) {
        return prev
      }
      return next
    })
  }, [usageProviderFilterOptions])

  useEffect(() => {
    setUsageFilterModels((prev: string[]) => {
      const next = sanitizeSelectedFilterValues(prev, usageModelFilterOptions)
      if (next.length === prev.length && next.every((value, index) => value === prev[index])) {
        return prev
      }
      return next
    })
  }, [usageModelFilterOptions])

  return { providerDisplayName, usageScheduleSaveStatusText }
}
