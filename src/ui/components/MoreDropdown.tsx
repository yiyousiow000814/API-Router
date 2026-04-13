import { memo, useCallback, useRef, useState } from 'react'

type MoreDropdownProps = {
  onSelectMonitor: () => void
  onSelectWebCodex: () => void
  onSelectGettingStarted: () => void
}

export const MoreDropdown = memo(function MoreDropdown({
  onSelectMonitor,
  onSelectWebCodex,
  onSelectGettingStarted,
}: MoreDropdownProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const toggle = useCallback(() => setOpen(v => !v), [])
  const close = useCallback(() => setOpen(false), [])

  return (
    <div className="aoMoreDropdown" style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        className={`aoTopNavBtn${open ? ' is-active' : ''}`}
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
      >
        More ▾
      </button>
      {open && (
        <>
          <div className="aoMoreDropdownOverlay" onClick={close} />
          <div className="aoMoreDropdownMenu" role="menu">
            <button className="aoMoreDropdownItem" role="menuitem" onClick={onSelectMonitor}>
              Monitor
            </button>
            <button className="aoMoreDropdownItem" role="menuitem" onClick={onSelectWebCodex}>
              Web Codex
            </button>
            <button className="aoMoreDropdownItem" role="menuitem" onClick={onSelectGettingStarted}>
              Getting Started
            </button>
          </div>
        </>
      )}
    </div>
  )
})
