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
        <div className="aoModalSub">默认会是 %USERPROFILE%\\.codex。最多支持两个目录。</div>

        <div className="aoDivider" style={{ marginTop: 10 }} />

        <div className="aoModalBody" style={{ paddingTop: 10, paddingBottom: 6 }}>
          <label className="aoLabel">
            <span className="aoMiniLabel">Dir 1</span>
            <input className="aoInput" value={dir1} onChange={(e) => onChangeDir1(e.target.value)} />
          </label>
          <div style={{ height: 10 }} />
          <label className="aoLabel">
            <span className="aoMiniLabel">Dir 2 (optional)</span>
            <input className="aoInput" value={dir2} onChange={(e) => onChangeDir2(e.target.value)} />
          </label>
          <div style={{ height: 10 }} />

          <label className="aoKvp" style={{ alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              checked={applyBoth}
              disabled={!canApplyBoth}
              onChange={(e) => onChangeApplyBoth(e.target.checked)}
            />
            <div className="aoVal">同时替换两个目录</div>
          </label>

          <div className="aoHint" style={{ marginTop: 8 }}>
            目录里必须存在 auth.json 和 config.toml；否则会报错。
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

