import { useCallback, useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

type Args = {
  usageProviderFilterOptions: string[]
  usageModelFilterOptions: string[]
  setUsageFilterProviders: Dispatch<SetStateAction<string[]>>
  setUsageFilterModels: Dispatch<SetStateAction<string[]>>
}

export function useUsageFilters({
  usageProviderFilterOptions,
  usageModelFilterOptions,
  setUsageFilterProviders,
  setUsageFilterModels,
}: Args) {
  useEffect(() => {
    setUsageFilterProviders((prev) => {
      const next = prev.filter((name) => usageProviderFilterOptions.includes(name))
      if (next.length === prev.length && next.every((value, index) => value === prev[index])) return prev
      return next
    })
  }, [setUsageFilterProviders, usageProviderFilterOptions])

  useEffect(() => {
    setUsageFilterModels((prev) => {
      const next = prev.filter((name) => usageModelFilterOptions.includes(name))
      if (next.length === prev.length && next.every((value, index) => value === prev[index])) return prev
      return next
    })
  }, [setUsageFilterModels, usageModelFilterOptions])

  const toggleUsageProviderFilter = useCallback((name: string) => {
    setUsageFilterProviders((prev) => (prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]))
  }, [setUsageFilterProviders])

  const toggleUsageModelFilter = useCallback((name: string) => {
    setUsageFilterModels((prev) => (prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]))
  }, [setUsageFilterModels])

  return {
    toggleUsageProviderFilter,
    toggleUsageModelFilter,
  }
}
