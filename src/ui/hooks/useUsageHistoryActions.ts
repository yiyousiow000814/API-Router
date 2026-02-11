import { useCallback } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'

import type { SpendHistoryRow } from '../types'

type UsageHistoryDraft = {
  effectiveText: string
  perReqText: string
}

type Args = {
  isDevPreview: boolean
  devMockHistoryEnabled: boolean
  usageHistoryModalOpen: boolean
  usageHistoryDrafts: Record<string, UsageHistoryDraft>
  usageHistoryLoadedRef: MutableRefObject<boolean>
  setUsageHistoryRows: Dispatch<SetStateAction<SpendHistoryRow[]>>
  setUsageHistoryDrafts: Dispatch<SetStateAction<Record<string, UsageHistoryDraft>>>
  setUsageHistoryEditCell: Dispatch<SetStateAction<string | null>>
  setUsageHistoryLoading: Dispatch<SetStateAction<boolean>>
  queueAutoSaveTimer: (key: string, callback: () => void, delayMs?: number) => void
  formatDraftAmount: (value: number) => string
  historyDraftFromRow: (row: SpendHistoryRow, formatDraftAmount: (value: number) => string) => UsageHistoryDraft
  historyEffectiveDisplayValue: (row: SpendHistoryRow) => number | null
  historyPerReqDisplayValue: (row: SpendHistoryRow) => number | null
  parsePositiveAmount: (value: string) => number | null
  buildDevMockHistoryRows: (count: number) => SpendHistoryRow[]
  refreshUsageStatistics: (options?: { silent?: boolean }) => Promise<void>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
}

export function useUsageHistoryActions(args: Args) {
  const refreshUsageHistory = useCallback(
    async (options?: { silent?: boolean; keepEditCell?: boolean }) => {
      const silent = options?.silent === true
      const keepEditCell = options?.keepEditCell === true
      if (!silent) args.setUsageHistoryLoading(true)
      try {
        let rows: SpendHistoryRow[] = []
        if (args.devMockHistoryEnabled) {
          rows = args.buildDevMockHistoryRows(120)
        } else if (args.isDevPreview) {
          rows = []
        } else {
          const res = await invoke<{ ok: boolean; rows: SpendHistoryRow[] }>('get_spend_history', {
            provider: null,
            days: 180,
            compactOnly: true,
          })
          rows = Array.isArray(res?.rows) ? res.rows : []
        }
        args.setUsageHistoryRows(rows)
        args.usageHistoryLoadedRef.current = true
        args.setUsageHistoryDrafts(() => {
          const next: Record<string, UsageHistoryDraft> = {}
          for (const row of rows) {
            const key = `${row.provider}|${row.day_key}`
            next[key] = args.historyDraftFromRow(row, args.formatDraftAmount)
          }
          return next
        })
        if (!keepEditCell) args.setUsageHistoryEditCell(null)
      } catch (error) {
        args.flashToast(String(error), 'error')
      } finally {
        if (!silent) args.setUsageHistoryLoading(false)
      }
    },
    [args],
  )

  const saveUsageHistoryRow = useCallback(
    async (
      row: SpendHistoryRow,
      options?: { silent?: boolean; keepEditCell?: boolean; field?: 'effective' | 'per_req' },
    ) => {
      const silent = options?.silent === true
      const keepEditCell = options?.keepEditCell === true
      const field = options?.field ?? 'effective'
      const key = `${row.provider}|${row.day_key}`
      const draft = args.usageHistoryDrafts[key] ?? args.historyDraftFromRow(row, args.formatDraftAmount)
      const effectiveDraft = args.parsePositiveAmount(draft.effectiveText)
      const effectiveNow = args.historyEffectiveDisplayValue(row)
      const perReqDraft = args.parsePositiveAmount(draft.perReqText)
      const perReqNow = args.historyPerReqDisplayValue(row)
      const trackedBase = row.tracked_total_usd ?? 0
      const scheduledBase = row.scheduled_total_usd ?? 0
      const closeEnough = (a: number, b: number) => Math.abs(a - b) < 0.0005
      const effectiveChanged =
        effectiveDraft != null && (effectiveNow == null || !closeEnough(effectiveDraft, effectiveNow))
      const perReqChanged = perReqDraft != null && (perReqNow == null || !closeEnough(perReqDraft, perReqNow))
      let totalUsedUsd: number | null = null
      let usdPerReq: number | null = null

      if (field === 'per_req' && perReqChanged) {
        totalUsedUsd = null
        usdPerReq = perReqDraft
      } else if (field === 'effective' && effectiveChanged) {
        const minimum = trackedBase + scheduledBase
        if ((effectiveDraft ?? 0) < minimum - 0.0005) {
          if (!silent) args.flashToast('Effective $ cannot be lower than tracked + scheduled', 'error')
          return
        }
        const delta = (effectiveDraft ?? 0) - minimum
        totalUsedUsd = delta > 0.0005 ? delta : null
        usdPerReq = null
      } else {
        if (!silent) args.flashToast('No history change to save')
        return
      }
      try {
        await invoke('set_spend_history_entry', {
          provider: row.provider,
          dayKey: row.day_key,
          totalUsedUsd,
          usdPerReq,
        })
        if (!silent) args.flashToast(`History saved: ${row.provider} ${row.day_key}`)
        await refreshUsageHistory({ silent: true, keepEditCell })
        await args.refreshUsageStatistics({ silent: true })
      } catch (error) {
        if (!silent) args.flashToast(String(error), 'error')
      }
    },
    [args, refreshUsageHistory],
  )

  const queueUsageHistoryAutoSave = useCallback(
    (row: SpendHistoryRow, field: 'effective' | 'per_req') => {
      if (!args.usageHistoryModalOpen) return
      args.queueAutoSaveTimer('history:edit', () => {
        void saveUsageHistoryRow(row, { silent: true, keepEditCell: true, field })
      })
    },
    [args, saveUsageHistoryRow],
  )

  return {
    refreshUsageHistory,
    saveUsageHistoryRow,
    queueUsageHistoryAutoSave,
  }
}
