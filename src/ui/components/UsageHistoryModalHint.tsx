type Props = {
  loading: boolean
}

export function UsageHistoryModalHint({ loading }: Props) {
  return <div className="aoHint">{loading ? 'Loading...' : 'No history yet.'}</div>
}
