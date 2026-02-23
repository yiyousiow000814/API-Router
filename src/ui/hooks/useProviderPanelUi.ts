import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Config, Status } from '../types'
import { createProviderCardRenderer } from '../utils/providerCardRenderer'

type Params = {
  orderedConfigProviders: string[]
  providerPanelsOpen: Record<string, boolean>
  setProviderPanelsOpen: Dispatch<SetStateAction<Record<string, boolean>>>
  setEditingProviderName: Dispatch<SetStateAction<string | null>>
  setProviderNameDrafts: Dispatch<SetStateAction<Record<string, string>>>
  providerNameDrafts: Record<string, string>
  refreshConfig: () => Promise<void>
  refreshStatus: () => Promise<void>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  registerProviderCardRef: (name: string) => (el: HTMLDivElement | null) => void
  dragOverProvider: string | null
  dragOffsetY: number
  dragBaseTop: number
  onProviderHandlePointerDown: (name: string, event: ReactPointerEvent<Element>) => void
  config: Config | null
  status: Status | null
  setConfig: Dispatch<SetStateAction<Config | null>>
  baselineBaseUrls: Record<string, string>
  saveProvider: (name: string) => Promise<void>
  setProviderDisabled: (name: string, disabled: boolean) => Promise<void>
  deleteProvider: (name: string) => Promise<void>
  openKeyModal: (provider: string) => Promise<void>
  clearKey: (provider: string) => Promise<void>
  openUsageBaseModal: (provider: string, current: string | null | undefined) => Promise<void>
  clearUsageBaseUrl: (provider: string) => Promise<void>
  setProviderQuotaHardCap: (
    provider: string,
    field: 'daily' | 'weekly' | 'monthly',
    enabled: boolean,
  ) => Promise<void>
  editingProviderName: string | null
}

type QuotaHardCapPeriod = 'daily' | 'weekly' | 'monthly'

type MissingHardCapToggle = {
  provider: string
  period: QuotaHardCapPeriod
}

const AUTO_DISABLE_HARD_CAP_RETRY_COOLDOWN_MS = 30_000

export function toMissingHardCapRetryKey(target: MissingHardCapToggle): string {
  return `${target.provider}:${target.period}`
}

export function canAutoDisableMissingHardCap(
  retryAtByKey: Record<string, number>,
  target: MissingHardCapToggle | null,
  nowMs: number,
): target is MissingHardCapToggle {
  if (!target) return false
  return nowMs >= (retryAtByKey[toMissingHardCapRetryKey(target)] ?? 0)
}

export function canStartMissingHardCapAutoDisable(
  inFlightKeys: Set<string>,
  retryAtByKey: Record<string, number>,
  target: MissingHardCapToggle | null,
  nowMs: number,
  hasInFlightOperation = false,
): target is MissingHardCapToggle {
  if (!canAutoDisableMissingHardCap(retryAtByKey, target, nowMs)) return false
  if (hasInFlightOperation) return false
  return !inFlightKeys.has(toMissingHardCapRetryKey(target))
}

export function markMissingHardCapAutoDisableAttempt(
  retryAtByKey: Record<string, number>,
  target: MissingHardCapToggle,
  nowMs: number,
  cooldownMs = AUTO_DISABLE_HARD_CAP_RETRY_COOLDOWN_MS,
): void {
  retryAtByKey[toMissingHardCapRetryKey(target)] = nowMs + cooldownMs
}

export function findMissingBudgetHardCapToggleToDisable(
  config: Config | null,
  status: Status | null,
): MissingHardCapToggle | null {
  if (!config || !status) return null
  const hardCapPeriods: QuotaHardCapPeriod[] = ['daily', 'weekly', 'monthly']
  for (const [providerName, providerConfig] of Object.entries(config.providers)) {
    const quota = status.quota?.[providerName]
    if (quota?.kind !== 'budget_info') continue
    const quotaHardCap = providerConfig.quota_hard_cap ?? { daily: true, weekly: true, monthly: true }
    const budgetWindowVisibleByPeriod: Record<QuotaHardCapPeriod, boolean> = {
      daily: quota.daily_spent_usd != null && quota.daily_budget_usd != null,
      weekly: quota.weekly_spent_usd != null && quota.weekly_budget_usd != null,
      monthly: quota.monthly_spent_usd != null && quota.monthly_budget_usd != null,
    }
    for (const period of hardCapPeriods) {
      if (!budgetWindowVisibleByPeriod[period] && quotaHardCap[period]) {
        return { provider: providerName, period }
      }
    }
  }
  return null
}

export function useProviderPanelUi(params: Params) {
  const {
    orderedConfigProviders,
    providerPanelsOpen,
    setProviderPanelsOpen,
    setEditingProviderName,
    setProviderNameDrafts,
    providerNameDrafts,
    refreshConfig,
    refreshStatus,
    flashToast,
    registerProviderCardRef,
    dragOverProvider,
    dragOffsetY,
    dragBaseTop,
    onProviderHandlePointerDown,
    config,
    status,
    setConfig,
    baselineBaseUrls,
    saveProvider,
    setProviderDisabled,
    deleteProvider,
    openKeyModal,
    clearKey,
    openUsageBaseModal,
    clearUsageBaseUrl,
    setProviderQuotaHardCap,
    editingProviderName,
  } = params
  const autoDisableInFlightRef = useRef<Set<string>>(new Set())
  const autoDisableRetryAtRef = useRef<Record<string, number>>({})
  const autoDisableAnyInFlightRef = useRef(false)

  const setAllProviderPanels = useCallback((open: boolean) => {
    setProviderPanelsOpen((prev) => {
      const next: Record<string, boolean> = { ...prev }
      for (const name of orderedConfigProviders) {
        next[name] = open
      }
      return next
    })
  }, [orderedConfigProviders])

  const allProviderPanelsOpen = useMemo(
    () => orderedConfigProviders.every((name: string) => providerPanelsOpen[name] ?? true),
    [orderedConfigProviders, providerPanelsOpen],
  )

  const isProviderOpen = useCallback(
    (name: string) => providerPanelsOpen[name] ?? true,
    [providerPanelsOpen],
  )

  const toggleProviderOpen = useCallback((name: string) => {
    setProviderPanelsOpen((prev) => ({ ...prev, [name]: !(prev[name] ?? true) }))
  }, [])

  const beginRename = useCallback((name: string) => {
    setEditingProviderName(name)
    setProviderNameDrafts((prev) => ({ ...prev, [name]: prev[name] ?? name }))
  }, [])

  const commitRename = useCallback(
    async (name: string) => {
      const next = (providerNameDrafts[name] ?? '').trim()
      setEditingProviderName(null)
      if (!next || next === name) {
        setProviderNameDrafts((prev) => ({ ...prev, [name]: name }))
        return
      }
      try {
        await invoke('rename_provider', { oldName: name, newName: next })
        setProviderPanelsOpen((prev) => {
          if (!(name in prev)) return prev
          const { [name]: value, ...rest } = prev
          return { ...rest, [next]: value }
        })
        flashToast(`Renamed: ${name} -> ${next}`)
      } catch (e) {
        flashToast(String(e), 'error')
      }
      await refreshStatus()
      await refreshConfig()
    },
    [providerNameDrafts, refreshConfig, refreshStatus, flashToast],
  )

  useEffect(() => {
    const missingHardCap = findMissingBudgetHardCapToggleToDisable(config, status)
    const nowMs = Date.now()
    if (
      !canStartMissingHardCapAutoDisable(
        autoDisableInFlightRef.current,
        autoDisableRetryAtRef.current,
        missingHardCap,
        nowMs,
        autoDisableAnyInFlightRef.current,
      )
    ) {
      return
    }
    const retryKey = toMissingHardCapRetryKey(missingHardCap)
    markMissingHardCapAutoDisableAttempt(autoDisableRetryAtRef.current, missingHardCap, nowMs)
    autoDisableAnyInFlightRef.current = true
    autoDisableInFlightRef.current.add(retryKey)
    void setProviderQuotaHardCap(missingHardCap.provider, missingHardCap.period, false).finally(() => {
      autoDisableInFlightRef.current.delete(retryKey)
      autoDisableAnyInFlightRef.current = false
    })
  }, [config, setProviderQuotaHardCap, status])

  const renderProviderCard = useMemo(
    () =>
      createProviderCardRenderer({
        registerProviderCardRef,
        dragOverProvider,
        dragOffsetY,
        dragBaseTop,
        onProviderHandlePointerDown,
        config,
        status,
        setConfig,
        baselineBaseUrls,
        saveProvider,
        setProviderDisabled,
        deleteProvider,
        openKeyModal,
        clearKey,
        openUsageBaseModal,
        clearUsageBaseUrl,
        setProviderQuotaHardCap,
        isProviderOpen,
        toggleProviderOpen,
        beginRenameProvider: beginRename,
        commitRenameProvider: commitRename,
        editingProviderName,
        providerNameDrafts,
        setProviderNameDrafts,
        setEditingProviderName,
      }),
    [
      registerProviderCardRef,
      dragOverProvider,
      dragOffsetY,
      dragBaseTop,
      onProviderHandlePointerDown,
      config,
      status,
      setConfig,
      baselineBaseUrls,
      saveProvider,
      setProviderDisabled,
      deleteProvider,
      openKeyModal,
      clearKey,
      openUsageBaseModal,
      clearUsageBaseUrl,
      setProviderQuotaHardCap,
      isProviderOpen,
      toggleProviderOpen,
      beginRename,
      commitRename,
      editingProviderName,
      providerNameDrafts,
      setProviderNameDrafts,
      setEditingProviderName,
    ],
  )

  return {
    setAllProviderPanels,
    allProviderPanelsOpen,
    renderProviderCard,
  }
}
