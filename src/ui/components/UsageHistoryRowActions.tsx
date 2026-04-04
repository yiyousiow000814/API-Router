import type { SpendHistoryRow } from '../devMockData'

type Props = {
  row: SpendHistoryRow
  onClearRow: (row: SpendHistoryRow) => void
  onRemoveTrackedRow: (row: SpendHistoryRow) => void
}

export function UsageHistoryRowActions({ row, onClearRow, onRemoveTrackedRow }: Props) {
  const hasTrackedRow = row.tracked_total_usd != null && (row.source ?? '').includes('tracked')
  return (
    <div className="aoUsageHistoryActions">
      <button
        className="aoTinyBtn"
        onClick={() => {
          void onClearRow(row)
        }}
      >
        Clear
      </button>
      {hasTrackedRow ? (
        <button
          className="aoUsageHistoryRemoveBtn"
          title="Remove tracked"
          aria-label="Remove tracked"
          onClick={() => {
            void onRemoveTrackedRow(row)
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
