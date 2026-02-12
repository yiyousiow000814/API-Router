type UsageScheduleModalHeaderProps = {
  onClose: () => void
}

export function UsageScheduleModalHeader({ onClose }: UsageScheduleModalHeaderProps) {
  return (
    <div className="aoModalHeader">
      <div>
        <div className="aoModalTitle">Pricing Timeline</div>
        <div className="aoModalSub">
          Edit base pricing timeline rows (monthly fee or $/request) with explicit start/expires.
        </div>
      </div>
      <button className="aoBtn" onClick={onClose}>
        Close
      </button>
    </div>
  )
}