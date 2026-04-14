import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { TopPage } from './AppTopNav'

export function resolveMoreDropdownMenuPosition(buttonRect: Pick<DOMRect, 'bottom' | 'right'>, viewportWidth: number) {
  return {
    top: buttonRect.bottom + 4,
    right: viewportWidth - buttonRect.right,
  }
}

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
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const toggle = useCallback(() => setOpen(v => !v), [])
  const close = useCallback(() => setOpen(false), [])

  // Close on outside click — document-level mousedown with explicit contains()
  // checks on both the button and the portaled menu, so the menu does NOT need
  // to be a DOM child of containerRef.
  useEffect(() => {
    if (!open) return
    function handleOutsideClick(e: MouseEvent) {
      const btn = buttonRef.current
      const menu = menuRef.current
      if (!btn || !menu) return
      if (btn.contains(e.target as Node)) return
      if (menu.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  useEffect(() => {
    if (!open) return
    const updateRect = () => {
      if (buttonRef.current) {
        setButtonRect(buttonRef.current.getBoundingClientRect())
      }
    }
    updateRect()
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateRect)
    if (resizeObserver && buttonRef.current) {
      resizeObserver.observe(buttonRef.current)
    }
    window.addEventListener('resize', updateRect)
    window.addEventListener('scroll', updateRect, true)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateRect)
      window.removeEventListener('scroll', updateRect, true)
    }
  }, [open])

  const handleMonitorSelect = useCallback(() => {
    close()
    onSelectMonitor()
  }, [close, onSelectMonitor])

  const handleWebCodexSelect = useCallback(() => {
    close()
    onSelectWebCodex()
  }, [close, onSelectWebCodex])

  const menuPosition = buttonRect
    ? resolveMoreDropdownMenuPosition(buttonRect, document.documentElement.clientWidth)
    : null

  return (
    <div ref={containerRef} className="aoMoreDropdown" style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        ref={buttonRef}
        className={`aoTopNavMenuBtn${activePage === 'monitor' || activePage === 'web_codex' ? ' is-active' : ''}`}
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <MoreIcon />
        <span>More</span>
      </button>
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          className="aoMoreDropdownMenu"
          role="menu"
          style={{
            top: menuPosition.top,
            right: menuPosition.right,
          }}
        >
          <button
            type="button"
            className={`aoMoreDropdownItem${activePage === 'monitor' ? ' is-active' : ''}`}
            role="menuitem"
            onClick={handleMonitorSelect}
          >
            <MonitorIcon />
            <span>Monitor</span>
          </button>
          <button
            type="button"
            className={`aoMoreDropdownItem${activePage === 'web_codex' ? ' is-active' : ''}`}
            role="menuitem"
            onClick={handleWebCodexSelect}
          >
            <WebCodexIcon />
            <span>Web Codex</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
})
