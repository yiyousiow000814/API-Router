type Props = {
  onClose: () => void
}

export function UsageHistoryModalHeader({ onClose }: Props) {
  return (
    <div className="aoModalHeader">
      <div>
        <div className="aoModalTitle">Daily History</div>
        <div className="aoModalSub">
          Edit per-day manual fixes. Use this when provider daily spend resets to zero and leaves cost gaps.
          Showing latest 180 days.
        </div>
      </div>
      <button className="aoBtn" onClick={onClose}>
        Close
      </button>
    </div>
  )
}
