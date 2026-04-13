import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { TopPage } from './AppTopNav'

const MoreIcon = () => (
  <svg className="aoTopNavIcon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12l7 7 7-7" />
  </svg>
)

const MonitorIcon = () => (
  <svg className="aoMoreDropdownIcon" viewBox="0 0 24 24" aria-hidden="true" style={{ width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', flexShrink: 0 }}>
    <path d="M4 12h3l2.5-6 3.5 12 2.5-6H20" />
  </svg>
)

const WebCodexIcon = () => (
  <svg className="aoMoreDropdownIcon" viewBox="0 0 24 24" aria-hidden="true" style={{ width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', flexShrink: 0 }}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.1 9.4 11.7 12l-2.6 2.6" />
    <path d="M13.2 14.6h3.1" />
  </svg>
)

type MoreDropdownProps = {
  activePage: TopPage
  onSelectMonitor: () => void
  onSelectWebCodex: () => void
}

export const MoreDropdown = memo(function MoreDropdown({
  activePage,
  onSelectMonitor,
  onSelectWebCodex,
}: MoreDropdownProps) {
  const [open, setOpen] = useState(false)
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const toggle = useCallback(() => setOpen(v => !v), [])
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const updateRect = () => {
      if (buttonRef.current) {
        setButtonRect(buttonRef.current.getBoundingClientRect())
      }
    }
    updateRect()
    const ro = new ResizeObserver(updateRect)
    if (buttonRef.current) {
      ro.observe(buttonRef.current)
    }
    return () => ro.disconnect()
  }, [open])

  const handleMonitorSelect = useCallback(() => {
    close()
    onSelectMonitor()
  }, [close, onSelectMonitor])

  const handleWebCodexSelect = useCallback(() => {
    close()
    onSelectWebCodex()
  }, [close, onSelectWebCodex])

  return (
    <div className="aoMoreDropdown" style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        className={`aoTopNavBtn${activePage === 'monitor' || activePage === 'web_codex' ? ' is-active' : ''}`}
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <MoreIcon />
        <span>More</span>
      </button>
      {open && buttonRect && createPortal(
        <>
          <div className="aoMoreDropdownOverlay" onClick={close} />
          <div
            className="aoMoreDropdownMenu"
            role="menu"
            style={{
              top: buttonRect.bottom + 4,
              right: document.documentElement.clientWidth - buttonRect.right,
            }}
          >
            <button
              className={`aoMoreDropdownItem${activePage === 'monitor' ? ' is-active' : ''}`}
              role="menuitem"
              onClick={handleMonitorSelect}
            >
              <MonitorIcon />
              <span>Monitor</span>
            </button>
            <button
              className={`aoMoreDropdownItem${activePage === 'web_codex' ? ' is-active' : ''}`}
              role="menuitem"
              onClick={handleWebCodexSelect}
            >
              <WebCodexIcon />
              <span>Web Codex</span>
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  )
})
