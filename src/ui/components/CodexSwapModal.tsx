type Props = {
  open: boolean
  dir1: string
  dir2: string
  applyBoth: boolean
  onChangeDir1: (v: string) => void
  onChangeDir2: (v: string) => void
  onChangeApplyBoth: (v: boolean) => void
  onCancel: () => void
  onApply: () => void
}

export function CodexSwapModal({
  open,
  dir1,
  dir2,
  applyBoth,
  onChangeDir1,
  onChangeDir2,
  onChangeApplyBoth,
  onCancel,
  onApply,
}: Props) {
  if (!open) return null

  const canApplyBoth = dir2.trim().length > 0

  return (
    <div className="aoModalBackdrop aoModalBackdropTop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="aoModal" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalTitle">Codex CLI dirs</div>
        <div className="aoModalSub">Defaults to %USERPROFILE%\\.codex. Supports up to 2 dirs.</div>
        <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
          <label className="aoRoutingRow">
            <span className="aoMiniLabel">Dir 1</span>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12 }}
              value={dir1}
              onChange={(e) => onChangeDir1(e.target.value)}
            />
          </label>

          <label className="aoRoutingRow">
            <span className="aoMiniLabel">Dir 2 (optional)</span>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12 }}
              value={dir2}
              onChange={(e) => onChangeDir2(e.target.value)}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              checked={applyBoth}
              disabled={!canApplyBoth}
              onChange={(e) => onChangeApplyBoth(e.target.checked)}
            />
            <span style={{ color: 'rgba(13, 18, 32, 0.82)', fontWeight: 500, fontSize: 13 }}>
              Apply to both dirs
            </span>
          </label>

          <div className="aoHint">
            Each dir must contain auth.json and config.toml, otherwise you'll get an error.
          </div>
        </div>

        <div className="aoModalActions">
          <button className="aoBtn" onClick={onCancel}>
            Cancel
          </button>
          <button className="aoBtn aoBtnPrimary" onClick={onApply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
