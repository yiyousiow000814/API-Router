import type { SpendHistoryRow } from '../devMockData'

type Props = {
  row: SpendHistoryRow
  onClearRow: (row: SpendHistoryRow) => void
}

export function UsageHistoryRowActions({ row, onClearRow }: Props) {
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
    </div>
  )
}
