import type { Dispatch, SetStateAction } from 'react'
import type { SpendHistoryRow } from '../devMockData'
import type { UsageHistoryDraft } from '../types/usage'

type Props = {
  row: SpendHistoryRow
  keyId: string
  field: 'effective' | 'per_req'
  draft: UsageHistoryDraft
  baseDraft: UsageHistoryDraft
  isEditing: boolean
  displayValue: number | null
  formatUsdMaybe: (value: number | null | undefined) => string
  setUsageHistoryDrafts: Dispatch<SetStateAction<Record<string, UsageHistoryDraft>>>
  setUsageHistoryEditCell: Dispatch<SetStateAction<string | null>>
  queueUsageHistoryAutoSave: (row: SpendHistoryRow, field: 'effective' | 'per_req') => void
  clearAutoSaveTimer: (key: string) => void
  saveUsageHistoryRow: (
    row: SpendHistoryRow,
    options?: { silent?: boolean; keepEditCell?: boolean; field?: 'effective' | 'per_req' },
  ) => Promise<void>
}

const EDIT_META = {
  per_req: {
    step: '0.0001',
    editCellKey: 'per_req',
    title: 'Edit $/req',
    label: 'Edit $/req',
  },
  effective: {
    step: '0.001',
    editCellKey: 'effective',
    title: 'Edit effective',
    label: 'Edit effective',
  },
} as const

export function UsageHistoryEditableUsdCell({
  row,
  keyId,
  field,
  draft,
  baseDraft,
  isEditing,
  displayValue,
  formatUsdMaybe,
  setUsageHistoryDrafts,
  setUsageHistoryEditCell,
  queueUsageHistoryAutoSave,
  clearAutoSaveTimer,
  saveUsageHistoryRow,
}: Props) {
  const meta = EDIT_META[field]
  const value = field === 'per_req' ? draft.perReqText : draft.effectiveText

  const setDraftValue = (nextValue: string) => {
    setUsageHistoryDrafts((prev) => ({
      ...prev,
      [keyId]:
        field === 'per_req'
          ? { ...draft, perReqText: nextValue }
          : { ...draft, effectiveText: nextValue },
    }))
  }

  return (
    <div className="aoUsageHistoryValueCell">
      {isEditing ? (
        <input
          className="aoInput aoUsageHistoryInput"
          type="number"
          min="0"
          step={meta.step}
          placeholder="0"
          value={value}
          onChange={(e) => {
            setDraftValue(e.target.value)
            queueUsageHistoryAutoSave(row, field)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              clearAutoSaveTimer('history:edit')
              setUsageHistoryEditCell(null)
              void saveUsageHistoryRow(row, { field })
            } else if (e.key === 'Escape') {
              setUsageHistoryDrafts((prev) => ({ ...prev, [keyId]: baseDraft }))
              setUsageHistoryEditCell(null)
            }
          }}
          onBlur={() => {
            clearAutoSaveTimer('history:edit')
            setUsageHistoryEditCell(null)
            void saveUsageHistoryRow(row, { silent: true, keepEditCell: false, field })
          }}
          autoFocus
        />
      ) : (
        <span>{formatUsdMaybe(displayValue)}</span>
      )}
      {!isEditing ? (
        <button
          className="aoUsageHistoryEditBtn"
          title={meta.title}
          aria-label={meta.label}
          onClick={() => {
            setUsageHistoryDrafts((prev) => ({ ...prev, [keyId]: draft }))
            setUsageHistoryEditCell(`${keyId}|${meta.editCellKey}`)
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}
