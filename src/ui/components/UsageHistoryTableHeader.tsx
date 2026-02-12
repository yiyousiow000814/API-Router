import { UsageHistoryColGroup } from './UsageHistoryColGroup'

export function UsageHistoryTableHeader() {
  return (
    <div className="aoUsageHistoryTableHead" aria-hidden="true">
      <table className="aoUsageHistoryTable">
        <UsageHistoryColGroup />
        <thead>
          <tr>
            <th>Date</th>
            <th>Provider</th>
            <th>API Key</th>
            <th>Req</th>
            <th>Tokens</th>
            <th>$ / req</th>
            <th>Effective $</th>
            <th>Package $</th>
            <th>Source</th>
            <th>Action</th>
          </tr>
        </thead>
      </table>
    </div>
  )
}
