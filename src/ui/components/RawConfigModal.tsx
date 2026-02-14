import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { ModalBackdrop } from './ModalBackdrop'

type DragState = {
  active: boolean
  pointerId: number
  pointerOffsetY: number
}

const IDLE_DRAG_STATE: DragState = { active: false, pointerId: -1, pointerOffsetY: 0 }

type Props = {
  open: boolean
  homeOptions: string[]
  homeLabels?: Record<string, string>
  valuesByHome: Record<string, string>
  loadingByHome: Record<string, boolean>
  savingByHome: Record<string, boolean>
  dirtyByHome: Record<string, boolean>
  loadedByHome: Record<string, boolean>
  onChangeHome: (home: string, next: string) => void
  onSaveHome: (home: string) => void
  onClose: () => void
}

export function RawConfigModal({
  open,
  homeOptions,
  homeLabels,
  valuesByHome,
  loadingByHome,
  savingByHome,
  dirtyByHome,
  loadedByHome,
  onChangeHome,
  onSaveHome,
  onClose,
}: Props) {
  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const surfaceRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const overlayRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const thumbRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const hideTimerRefs = useRef<Record<string, number | null>>({})
  const rafRefs = useRef<Record<string, number | null>>({})
  const dragRefs = useRef<Record<string, DragState>>({})

  const setVisible = (home: string, visible: boolean) => {
    surfaceRefs.current[home]?.classList.toggle('aoRawConfigScrollSurfaceScrollbarVisible', visible)
    overlayRefs.current[home]?.classList.toggle('aoRawConfigScrollbarOverlayVisible', visible)
  }

  const setCanScroll = (home: string, canScroll: boolean) => {
    surfaceRefs.current[home]?.classList.toggle('aoRawConfigScrollSurfaceCanScroll', canScroll)
  }

  const refreshScrollbar = (home: string) => {
    const editor = editorRefs.current[home]
    const overlay = overlayRefs.current[home]
    const thumb = thumbRefs.current[home]
    if (!editor || !overlay || !thumb) return
    const viewportHeight = editor.clientHeight
    const overlayHeight = overlay.clientHeight
    const scrollHeight = editor.scrollHeight
    const maxScroll = Math.max(0, scrollHeight - viewportHeight)
    if (viewportHeight <= 0 || overlayHeight <= 0 || maxScroll <= 0) {
      thumb.style.height = '0px'
      thumb.style.transform = 'translateY(0px)'
      setCanScroll(home, false)
      setVisible(home, false)
      return
    }
    setCanScroll(home, true)
    const thumbHeight = Math.max(24, Math.round((viewportHeight / scrollHeight) * overlayHeight))
    const thumbTravel = Math.max(0, overlayHeight - thumbHeight)
    const thumbTop = maxScroll > 0 ? Math.round((editor.scrollTop / maxScroll) * thumbTravel) : 0
    thumb.style.height = `${thumbHeight}px`
    thumb.style.transform = `translateY(${thumbTop}px)`
  }

  const scheduleSync = (home: string) => {
    if (typeof window === 'undefined') return
    if (rafRefs.current[home] != null) return
    rafRefs.current[home] = window.requestAnimationFrame(() => {
      rafRefs.current[home] = null
      refreshScrollbar(home)
    })
  }

  const activateScrollbar = (home: string) => {
    if (typeof window === 'undefined') return
    const editor = editorRefs.current[home]
    if (!editor) return
    if (editor.scrollHeight - editor.clientHeight <= 1) return
    setVisible(home, true)
    if (dragRefs.current[home]?.active) {
      const existing = hideTimerRefs.current[home]
      if (existing != null) {
        window.clearTimeout(existing)
        hideTimerRefs.current[home] = null
      }
      return
    }
    const timer = hideTimerRefs.current[home]
    if (timer != null) window.clearTimeout(timer)
    hideTimerRefs.current[home] = window.setTimeout(() => {
      setVisible(home, false)
      hideTimerRefs.current[home] = null
    }, 700)
  }

  const scrollByThumbTop = (home: string, thumbTopPx: number) => {
    const editor = editorRefs.current[home]
    const overlay = overlayRefs.current[home]
    const thumb = thumbRefs.current[home]
    if (!editor || !overlay || !thumb) return
    const viewportHeight = editor.clientHeight
    const overlayHeight = overlay.clientHeight
    const scrollHeight = editor.scrollHeight
    const maxScroll = Math.max(0, scrollHeight - viewportHeight)
    if (viewportHeight <= 0 || overlayHeight <= 0 || maxScroll <= 0) return
    const thumbHeight = Math.max(24, Math.round((viewportHeight / scrollHeight) * overlayHeight))
    const thumbTravel = Math.max(0, overlayHeight - thumbHeight)
    if (thumbTravel <= 0) return
    const nextThumbTop = Math.max(0, Math.min(thumbTravel, thumbTopPx))
    const nextScrollTop = Math.round((nextThumbTop / thumbTravel) * maxScroll)
    editor.scrollTop = nextScrollTop
    scheduleSync(home)
    activateScrollbar(home)
  }

  const onScrollbarPointerDown = (home: string, e: ReactPointerEvent<HTMLDivElement>) => {
    const editor = editorRefs.current[home]
    const overlay = overlayRefs.current[home]
    if (!editor || !overlay) return
    const viewportHeight = editor.clientHeight
    const overlayHeight = overlay.clientHeight
    const scrollHeight = editor.scrollHeight
    const maxScroll = Math.max(0, scrollHeight - viewportHeight)
    if (viewportHeight <= 0 || overlayHeight <= 0 || maxScroll <= 0) return

    e.preventDefault()
    e.stopPropagation()
    try {
      overlay.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }

    const thumbHeight = Math.max(24, Math.round((viewportHeight / scrollHeight) * overlayHeight))
    const thumbTravel = Math.max(0, overlayHeight - thumbHeight)
    const currentThumbTop = maxScroll > 0 ? Math.round((editor.scrollTop / maxScroll) * thumbTravel) : 0
    const rect = overlay.getBoundingClientRect()
    const y = e.clientY - rect.top
    const pointerOffsetY = Math.max(0, Math.min(thumbHeight, y - currentThumbTop))
    dragRefs.current[home] = { active: true, pointerId: e.pointerId, pointerOffsetY }
    activateScrollbar(home)
    scrollByThumbTop(home, y - pointerOffsetY)
  }

  const onScrollbarPointerMove = (home: string, e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRefs.current[home] ?? IDLE_DRAG_STATE
    if (!drag.active || drag.pointerId !== e.pointerId) return
    const overlay = overlayRefs.current[home]
    if (!overlay) return
    e.preventDefault()
    e.stopPropagation()
    const rect = overlay.getBoundingClientRect()
    const y = e.clientY - rect.top
    scrollByThumbTop(home, y - drag.pointerOffsetY)
  }

  const onScrollbarPointerUp = (home: string, e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRefs.current[home] ?? IDLE_DRAG_STATE
    if (!drag.active || drag.pointerId !== e.pointerId) return
    const overlay = overlayRefs.current[home]
    if (!overlay) return
    e.preventDefault()
    e.stopPropagation()
    dragRefs.current[home] = IDLE_DRAG_STATE
    try {
      overlay.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    activateScrollbar(home)
  }

  const onScrollbarLostPointerCapture = (home: string) => {
    const drag = dragRefs.current[home] ?? IDLE_DRAG_STATE
    if (!drag.active) return
    dragRefs.current[home] = IDLE_DRAG_STATE
    activateScrollbar(home)
  }

  useEffect(() => {
    homeOptions.forEach((home) => {
      scheduleSync(home)
    })
  }, [homeOptions, valuesByHome, loadingByHome])

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      Object.values(hideTimerRefs.current).forEach((timer) => {
        if (timer != null) window.clearTimeout(timer)
      })
      Object.values(rafRefs.current).forEach((raf) => {
        if (raf != null) window.cancelAnimationFrame(raf)
      })
    }
  }, [])

  const parseHomeLabel = (home: string) => {
    const raw = homeLabels?.[home] ?? home
    const idx = raw.indexOf(': ')
    if (idx <= 0) return { kind: 'Target', path: raw }
    return { kind: raw.slice(0, idx), path: raw.slice(idx + 2) }
  }
  const statusText = (home: string) => {
    if (savingByHome[home]) return 'Saving'
    if (loadingByHome[home]) return 'Loading'
    if (!loadedByHome[home]) return 'Load Failed'
    if (dirtyByHome[home]) return 'Not Saved'
    return 'Saved'
  }
  const statusClass = (home: string) => {
    if (savingByHome[home]) return 'aoRawConfigState aoRawConfigStateInfo'
    if (loadingByHome[home]) return 'aoRawConfigState aoRawConfigStateInfo'
    if (!loadedByHome[home]) return 'aoRawConfigState aoRawConfigStateError'
    if (dirtyByHome[home]) return 'aoRawConfigState aoRawConfigStateWarn'
    return 'aoRawConfigState aoRawConfigStateOk'
  }
  if (!open) return null
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal aoModalWide" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Raw Codex config.toml</div>
            <div className="aoModalSub">Edit both Windows/WSL2 configs directly. Save applies per side.</div>
          </div>
          <button className="aoBtn aoRawConfigCloseBtn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="aoModalBody aoRawConfigModalBody">
          <div className="aoRawConfigDual">
            {homeOptions.map((home) => {
              const parsed = parseHomeLabel(home)
              const disabled = Boolean(loadingByHome[home] || savingByHome[home] || !loadedByHome[home])
              return (
                <section key={home} className="aoRawConfigPane">
                  <div className="aoRawConfigPaneHead">
                    <div className="aoRawConfigPaneMeta">
                      <div className="aoRawConfigPaneTopline">
                        <span className="aoRawConfigPaneKind">{parsed.kind}</span>
                        <span className={statusClass(home)}>{statusText(home)}</span>
                      </div>
                      <span className="aoRawConfigPanePath" title={parsed.path}>
                        {parsed.path}
                      </span>
                    </div>
                    <div className="aoRawConfigPaneActions">
                      <button className="aoBtn aoBtnPrimary" disabled={disabled} onClick={() => onSaveHome(home)}>
                        {savingByHome[home] ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                  <div
                    className="aoRawConfigEditorShell"
                    ref={(el) => {
                      surfaceRefs.current[home] = el
                    }}
                  >
                    <textarea
                      className="aoRawConfigEditor"
                      ref={(el) => {
                        editorRefs.current[home] = el
                      }}
                      value={valuesByHome[home] ?? ''}
                      onChange={(e) => onChangeHome(home, e.target.value)}
                      onScroll={() => {
                        scheduleSync(home)
                        activateScrollbar(home)
                      }}
                      onWheel={() => {
                        scheduleSync(home)
                        activateScrollbar(home)
                      }}
                      onTouchMove={() => activateScrollbar(home)}
                      spellCheck={false}
                      placeholder={loadingByHome[home] ? 'Loading config.toml...' : 'config.toml is empty'}
                      disabled={disabled}
                    />
                    <div
                      className="aoRawConfigScrollbarOverlay"
                      ref={(el) => {
                        overlayRefs.current[home] = el
                      }}
                      onPointerDown={(e) => onScrollbarPointerDown(home, e)}
                      onPointerMove={(e) => onScrollbarPointerMove(home, e)}
                      onPointerUp={(e) => onScrollbarPointerUp(home, e)}
                      onPointerCancel={(e) => onScrollbarPointerUp(home, e)}
                      onLostPointerCapture={() => onScrollbarLostPointerCapture(home)}
                    >
                      <div
                        className="aoRawConfigScrollbarThumb"
                        ref={(el) => {
                          thumbRefs.current[home] = el
                        }}
                      />
                    </div>
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </ModalBackdrop>
  )
}
