import type { SpendHistoryRow } from '../devMockData'

type Props = {
  row: SpendHistoryRow
  onClearRow: (row: SpendHistoryRow) => void
  onRemoveTrackedRow: (row: SpendHistoryRow, sourceNodeId: string, sourceNodeName?: string | null) => void
}

export function UsageHistoryRowActions({ row, onClearRow, onRemoveTrackedRow }: Props) {
  const explicitTrackedSources = (row.tracked_source_nodes ?? []).filter((source) => source?.node_id)
  const trackedSources =
    explicitTrackedSources.length > 0
      ? explicitTrackedSources
      : row.tracked_total_usd != null && (row.source ?? '').includes('tracked')
        ? [{ node_id: '__local__', node_name: 'Local' }]
        : []
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
      {trackedSources.map((source) => (
        <button
          key={source.node_id}
          className="aoUsageHistoryRemoveBtn"
          title={trackedSources.length > 1 ? `Remove tracked: ${source.node_name || source.node_id}` : 'Remove tracked'}
          aria-label={trackedSources.length > 1 ? `Remove tracked: ${source.node_name || source.node_id}` : 'Remove tracked'}
          onClick={() => {
            void onRemoveTrackedRow(row, source.node_id, source.node_name)
          }}
        >
          ×
        </button>
      ))}
    </div>
  )
}
