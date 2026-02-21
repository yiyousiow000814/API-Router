import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Status } from '../types'
import { fmtAgo, fmtWhen } from '../utils/format'
import { isNearBottom } from '../utils/scroll'
import { ModalBackdrop } from './ModalBackdrop'
import './EventsTable.css'

type Props = {
  events: Status['recent_events']
  focusEvent?: Status['recent_events'][number] | null
  focusNonce?: number
  splitByLevel?: boolean
  scrollInside?: boolean
  scrollPersistKey?: string
  onReachEnd?: () => void
}

type DragState = {
  active: boolean
  pointerId: number
  pointerOffsetY: number
}

type OverflowMetrics = {
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
}

const IDLE_DRAG_STATE: DragState = { active: false, pointerId: -1, pointerOffsetY: 0 }
const SCROLL_TOP_BY_KEY = new Map<string, number>()

function formatEventMessageDialog(message: string): string {
  return message.replace(/;\s+/g, ';\n')
}

function eventIdentity(event: Status['recent_events'][number]): string {
  return `${event.unix_ms}|${event.provider}|${event.level}|${event.code}|${event.message}`
}

function withStableRowKeys(
  rows: Status['recent_events'],
  scope: string,
): Array<{ event: Status['recent_events'][number]; key: string }> {
  const seen = new Map<string, number>()
  return rows.map((event) => {
    const id = eventIdentity(event)
    const occurrence = seen.get(id) ?? 0
    seen.set(id, occurrence + 1)
    return { event, key: `${id}-${scope}-${occurrence}` }
  })
}

export function isEventMessageOverflow(metrics: OverflowMetrics): boolean {
  return metrics.scrollHeight - metrics.clientHeight > 1 || metrics.scrollWidth - metrics.clientWidth > 1
}

export function EventsTable({
  events,
  focusEvent = null,
  focusNonce = 0,
  splitByLevel = true,
  scrollInside = false,
  scrollPersistKey,
  onReachEnd,
}: Props) {
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null)
  const [messageDialog, setMessageDialog] = useState<{ title: string; text: string } | null>(null)
  const [expandableMessageKeys, setExpandableMessageKeys] = useState<Record<string, true>>({})
  const allEvents = events ?? []
  const focusEventId = focusEvent ? eventIdentity(focusEvent) : ''
  const eventsTableSurfaceRef = useRef<HTMLDivElement | null>(null)
  const eventsTableWrapRef = useRef<HTMLDivElement | null>(null)
  const eventsScrollbarOverlayRef = useRef<HTMLDivElement | null>(null)
  const eventsScrollbarThumbRef = useRef<HTMLDivElement | null>(null)
  const eventsScrollbarHideTimerRef = useRef<number | null>(null)
  const eventsScrollbarRafRef = useRef<number | null>(null)
  const eventsScrollbarDragRef = useRef<DragState>(IDLE_DRAG_STATE)
  const focusRowRef = useRef<HTMLTableRowElement | null>(null)
  const focusFlashTimerRef = useRef<number | null>(null)
  const wasNearBottomRef = useRef(false)
  const messageTextRefs = useRef(new Map<string, HTMLSpanElement>())
  const prevScrollHeightRef = useRef<number | null>(null)
  const prevFirstEventIdRef = useRef('')
  const scrollRestoreKeyRef = useRef<string | null>(null)

  const setEventsScrollbarVisible = useCallback((visible: boolean) => {
    eventsTableSurfaceRef.current?.classList.toggle('aoEventsTableSurfaceScrollbarVisible', visible)
    eventsScrollbarOverlayRef.current?.classList.toggle('aoEventsScrollbarOverlayVisible', visible)
  }, [])

  const setEventsScrollbarCanScroll = useCallback((canScroll: boolean) => {
    eventsTableSurfaceRef.current?.classList.toggle('aoEventsTableSurfaceCanScroll', canScroll)
  }, [])

  const refreshEventsScrollbarUi = useCallback(() => {
    const wrap = eventsTableWrapRef.current
    const overlay = eventsScrollbarOverlayRef.current
    const thumb = eventsScrollbarThumbRef.current
    if (!wrap || !overlay || !thumb) return
    const viewportHeight = wrap.clientHeight
    const overlayHeight = overlay.clientHeight
    const scrollHeight = wrap.scrollHeight
    const maxScroll = Math.max(0, scrollHeight - viewportHeight)
    if (viewportHeight <= 0 || overlayHeight <= 0 || maxScroll <= 0) {
      thumb.style.height = '0px'
      thumb.style.transform = 'translateY(0px)'
      setEventsScrollbarCanScroll(false)
      setEventsScrollbarVisible(false)
      return
    }
    setEventsScrollbarCanScroll(true)
    const thumbHeight = Math.max(24, Math.round((viewportHeight / scrollHeight) * overlayHeight))
    const thumbTravel = Math.max(0, overlayHeight - thumbHeight)
    const thumbTop = maxScroll > 0 ? Math.round((wrap.scrollTop / maxScroll) * thumbTravel) : 0
    thumb.style.height = `${thumbHeight}px`
    thumb.style.transform = `translateY(${thumbTop}px)`
  }, [setEventsScrollbarCanScroll, setEventsScrollbarVisible])

  const scheduleEventsScrollbarSync = useCallback(() => {
    if (typeof window === 'undefined') return
    if (eventsScrollbarRafRef.current != null) return
    eventsScrollbarRafRef.current = window.requestAnimationFrame(() => {
      eventsScrollbarRafRef.current = null
      refreshEventsScrollbarUi()
    })
  }, [refreshEventsScrollbarUi])

  const activateEventsScrollbarUi = useCallback(() => {
    if (typeof window === 'undefined') return
    const wrap = eventsTableWrapRef.current
    if (!wrap) return
    if (wrap.scrollHeight - wrap.clientHeight <= 1) return
    setEventsScrollbarVisible(true)
    if (eventsScrollbarDragRef.current.active) {
      if (eventsScrollbarHideTimerRef.current != null) {
        window.clearTimeout(eventsScrollbarHideTimerRef.current)
        eventsScrollbarHideTimerRef.current = null
      }
      return
    }
    if (eventsScrollbarHideTimerRef.current != null) {
      window.clearTimeout(eventsScrollbarHideTimerRef.current)
    }
    eventsScrollbarHideTimerRef.current = window.setTimeout(() => {
      setEventsScrollbarVisible(false)
      eventsScrollbarHideTimerRef.current = null
    }, 700)
  }, [setEventsScrollbarVisible])

  const scrollEventsByThumbTop = useCallback(
    (thumbTopPx: number) => {
      const wrap = eventsTableWrapRef.current
      const overlay = eventsScrollbarOverlayRef.current
      if (!wrap || !overlay) return
      const viewportHeight = wrap.clientHeight
      const overlayHeight = overlay.clientHeight
      const scrollHeight = wrap.scrollHeight
      const maxScroll = Math.max(0, scrollHeight - viewportHeight)
      if (viewportHeight <= 0 || overlayHeight <= 0 || maxScroll <= 0) return
      const thumbHeight = Math.max(24, Math.round((viewportHeight / scrollHeight) * overlayHeight))
      const thumbTravel = Math.max(0, overlayHeight - thumbHeight)
      if (thumbTravel <= 0) return
      const nextThumbTop = Math.max(0, Math.min(thumbTravel, thumbTopPx))
      const nextScrollTop = Math.round((nextThumbTop / thumbTravel) * maxScroll)
      wrap.scrollTop = nextScrollTop
      scheduleEventsScrollbarSync()
      activateEventsScrollbarUi()
    },
    [activateEventsScrollbarUi, scheduleEventsScrollbarSync],
  )

  const onEventsScrollbarPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const wrap = eventsTableWrapRef.current
      const overlay = eventsScrollbarOverlayRef.current
      if (!wrap || !overlay) return
      const viewportHeight = wrap.clientHeight
      const overlayHeight = overlay.clientHeight
      const scrollHeight = wrap.scrollHeight
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
      const currentThumbTop = maxScroll > 0 ? Math.round((wrap.scrollTop / maxScroll) * thumbTravel) : 0
      const r = overlay.getBoundingClientRect()
      const y = e.clientY - r.top
      const pointerOffsetY = Math.max(0, Math.min(thumbHeight, y - currentThumbTop))
      eventsScrollbarDragRef.current = { active: true, pointerId: e.pointerId, pointerOffsetY }
      activateEventsScrollbarUi()
      scrollEventsByThumbTop(y - pointerOffsetY)
    },
    [activateEventsScrollbarUi, scrollEventsByThumbTop],
  )

  const onEventsScrollbarPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = eventsScrollbarDragRef.current
      if (!drag.active || drag.pointerId !== e.pointerId) return
      const overlay = eventsScrollbarOverlayRef.current
      if (!overlay) return
      e.preventDefault()
      e.stopPropagation()
      const r = overlay.getBoundingClientRect()
      const y = e.clientY - r.top
      scrollEventsByThumbTop(y - drag.pointerOffsetY)
    },
    [scrollEventsByThumbTop],
  )

  const onEventsScrollbarPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = eventsScrollbarDragRef.current
      if (!drag.active || drag.pointerId !== e.pointerId) return
      const overlay = eventsScrollbarOverlayRef.current
      if (!overlay) return
      e.preventDefault()
      e.stopPropagation()
      eventsScrollbarDragRef.current = IDLE_DRAG_STATE
      try {
        overlay.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      activateEventsScrollbarUi()
    },
    [activateEventsScrollbarUi],
  )

  const onEventsScrollbarLostPointerCapture = useCallback(() => {
    if (!eventsScrollbarDragRef.current.active) return
    eventsScrollbarDragRef.current = IDLE_DRAG_STATE
    activateEventsScrollbarUi()
  }, [activateEventsScrollbarUi])

  const setMessageTextRef = useCallback((key: string, element: HTMLSpanElement | null) => {
    if (element) {
      messageTextRefs.current.set(key, element)
      return
    }
    messageTextRefs.current.delete(key)
  }, [])

  const refreshExpandableMessageKeys = useCallback(() => {
    const next: Record<string, true> = {}
    messageTextRefs.current.forEach((element, key) => {
      if (
        isEventMessageOverflow({
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        })
      ) {
        next[key] = true
      }
    })
    setExpandableMessageKeys((prev) => {
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      if (prevKeys.length === nextKeys.length && prevKeys.every((k) => next[k])) return prev
      return next
    })
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const raf = window.requestAnimationFrame(refreshExpandableMessageKeys)
    const onResize = () => refreshExpandableMessageKeys()
    window.addEventListener('resize', onResize)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [refreshExpandableMessageKeys, allEvents.length, splitByLevel, scrollInside])

  useEffect(() => {
    if (!scrollInside || typeof window === 'undefined') return
    const wrap = eventsTableWrapRef.current
    if (wrap && scrollPersistKey && scrollRestoreKeyRef.current !== scrollPersistKey) {
      scrollRestoreKeyRef.current = scrollPersistKey
      const savedTop = SCROLL_TOP_BY_KEY.get(scrollPersistKey) ?? 0
      const applySavedTop = () => {
        if (!eventsTableWrapRef.current) return
        eventsTableWrapRef.current.scrollTop = savedTop
        scheduleEventsScrollbarSync()
      }
      // Wait for layout/rows to settle before restoring, otherwise it may snap back to 0.
      window.requestAnimationFrame(() => {
        applySavedTop()
        window.requestAnimationFrame(applySavedTop)
      })
    }
    scheduleEventsScrollbarSync()
    const onResize = () => scheduleEventsScrollbarSync()
    window.addEventListener('resize', onResize)
    return () => {
      if (scrollPersistKey && eventsTableWrapRef.current) {
        SCROLL_TOP_BY_KEY.set(scrollPersistKey, eventsTableWrapRef.current.scrollTop ?? 0)
      }
      window.removeEventListener('resize', onResize)
    }
  }, [scrollInside, scheduleEventsScrollbarSync, splitByLevel, scrollPersistKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    return () => {
      if (eventsScrollbarHideTimerRef.current != null) {
        window.clearTimeout(eventsScrollbarHideTimerRef.current)
        eventsScrollbarHideTimerRef.current = null
      }
      if (eventsScrollbarRafRef.current != null) {
        window.cancelAnimationFrame(eventsScrollbarRafRef.current)
        eventsScrollbarRafRef.current = null
      }
      if (focusFlashTimerRef.current != null) {
        window.clearTimeout(focusFlashTimerRef.current)
        focusFlashTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!focusEvent) {
      focusRowRef.current = null
      return
    }
  }, [focusEvent])

  useEffect(() => {
    wasNearBottomRef.current = false
  }, [allEvents.length])

  useLayoutEffect(() => {
    if (!scrollInside) return
    const wrap = eventsTableWrapRef.current
    if (!wrap) return
    const nextHeight = wrap.scrollHeight
    const nextCount = allEvents.length
    const nextFirstId = nextCount > 0 ? eventIdentity(allEvents[0]) : ''
    const prevHeight = prevScrollHeightRef.current
    const prevFirstId = prevFirstEventIdRef.current

    const prevFirstIndexInNext = prevFirstId ? allEvents.findIndex((row) => eventIdentity(row) === prevFirstId) : -1
    const prependedCount = prevFirstIndexInNext > 0 ? prevFirstIndexInNext : 0
    const prepended = prependedCount > 0
    const grew = prevHeight != null && nextHeight > prevHeight + 1
    const nearTop = wrap.scrollTop <= 4
    if (prepended && !nearTop) {
      const firstRow = wrap.querySelector('tbody tr')
      const fallbackRowHeight = firstRow instanceof HTMLElement ? firstRow.offsetHeight : 36
      const delta = grew && prevHeight != null ? (nextHeight - prevHeight) : (fallbackRowHeight * prependedCount)
      wrap.scrollTop += Math.max(0, delta)
      if (scrollPersistKey) SCROLL_TOP_BY_KEY.set(scrollPersistKey, wrap.scrollTop ?? 0)
      scheduleEventsScrollbarSync()
    }

    prevScrollHeightRef.current = wrap.scrollHeight
    prevFirstEventIdRef.current = nextFirstId
  }, [allEvents, scheduleEventsScrollbarSync, scrollInside, scrollPersistKey])

  useEffect(() => {
    if (!focusNonce || !focusEvent) return
    const row = focusRowRef.current
    if (!row) return
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.classList.remove('aoEventRowFocusFlash')
    // Force reflow so repeated focus requests replay the animation.
    void row.getBoundingClientRect()
    row.classList.add('aoEventRowFocusFlash')
    if (focusFlashTimerRef.current != null) window.clearTimeout(focusFlashTimerRef.current)
    focusFlashTimerRef.current = window.setTimeout(() => {
      row.classList.remove('aoEventRowFocusFlash')
      focusFlashTimerRef.current = null
    }, 1400)
  }, [focusEvent, focusNonce])

  // Infos are displayed directly, so cap them here. Errors/warnings are merged/sorted and capped later.
  const errors = allEvents.filter((e) => e.level === 'error')
  const warnings = allEvents.filter((e) => e.level === 'warning')
  const infos = allEvents.filter((e) => e.level !== 'error' && e.level !== 'warning').slice(0, 5)

  const renderColGroup = () => (
    <colgroup>
      <col style={{ width: 92 }} />
      <col style={{ width: 220 }} />
      <col style={{ width: 110 }} />
      <col style={{ width: 90 }} />
      <col />
    </colgroup>
  )

  const renderRow = (e: Status['recent_events'][number], key: string) => {
    const isError = e.level === 'error'
    const isWarning = e.level === 'warning'
    const canExpandMessage = !!expandableMessageKeys[key]
    const displayMessage = e.message
    const f: Record<string, unknown> = e.fields ?? {}
    const isSessionPref =
      e.code === 'config.session_preferred_provider_updated' || e.code === 'config.session_preferred_provider_cleared'

    const wtSessionVal = f['wt_session']
    const wt = typeof wtSessionVal === 'string' ? wtSessionVal : null

    const legacySessionIdVal = f['session_id']

    const codexSessionVal = f['codex_session_id']
    const codex =
      typeof codexSessionVal === 'string'
        ? codexSessionVal
        : typeof legacySessionIdVal === 'string'
          ? legacySessionIdVal
          : null

    const pidVal = f['pid']
    const pid = typeof pidVal === 'number' ? pidVal : null

    const showSession = isSessionPref || !!codex || pid !== null
    const sessionCell = showSession ? codex ?? '-' : '-'
    const sessionTitle = showSession
      ? [codex ? `Codex session: ${codex}` : null, wt ? `WT_SESSION: ${wt}` : null, pid ? `pid: ${pid}` : null]
          .filter(Boolean)
          .join('\n')
      : ''

    const isFocus = !!focusEventId && eventIdentity(e) === focusEventId

    return (
      <tr
        key={key}
        ref={isFocus ? focusRowRef : undefined}
        className={`${isError ? 'aoEventRowError' : isWarning ? 'aoEventRowWarning' : ''}`.trim() || undefined}
      >
        <td title={fmtWhen(e.unix_ms)}>{fmtAgo(e.unix_ms)}</td>
        <td className="aoEventsMono" title={sessionTitle}>
          {sessionCell}
        </td>
        <td className="aoEventsMono">{e.provider}</td>
        <td className="aoEventsLevelCell">
          <span
            className={`aoLevelBadge ${
              isError ? 'aoLevelBadgeError' : isWarning ? 'aoLevelBadgeWarning' : 'aoLevelBadgeInfo'
            }`}
          >
            {e.level}
          </span>
        </td>
        <td className="aoEventsCellWrap">
          <div className="aoEventMessageWrap">
            <div className="aoEventMessage">
              {canExpandMessage ? (
                <button
                  className="aoEventMessageTextBtn is-clickable"
                  title="Click to view full message"
                  onClick={() => setMessageDialog({ title: e.code || 'Message', text: formatEventMessageDialog(e.message) })}
                >
                  <span ref={(element) => setMessageTextRef(key, element)} className="aoEventMessageText">
                    {displayMessage}
                  </span>
                </button>
              ) : (
                <span
                  ref={(element) => setMessageTextRef(key, element)}
                  className="aoEventMessageText aoEventMessageTextStatic"
                  title={e.code ? `${e.code}: ${e.message}` : e.message}
                >
                  {displayMessage}
                </span>
              )}
            </div>
            {isError ? (
              <button
                className="aoIconBtn aoIconBtnMini aoEventCopyBtn"
                title={copiedMessageKey === key ? 'Copied' : 'Copy message'}
                aria-label={copiedMessageKey === key ? 'Copied' : 'Copy message'}
                onClick={() => {
                  const text = e.code ? `${e.code}: ${e.message}` : e.message
                  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    void navigator.clipboard.writeText(text)
                  } else if (typeof window !== 'undefined') {
                    const ta = document.createElement('textarea')
                    ta.value = text
                    document.body.appendChild(ta)
                    ta.select()
                    document.execCommand('copy')
                    document.body.removeChild(ta)
                  }
                  setCopiedMessageKey(key)
                  if (typeof window !== 'undefined') {
                    window.setTimeout(() => {
                      setCopiedMessageKey((prev) => (prev === key ? null : prev))
                    }, 1100)
                  }
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 9h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
                  <path d="M15 9V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                </svg>
              </button>
            ) : (
              <span className="aoEventCopySlot" aria-hidden="true" />
            )}
          </div>
        </td>
      </tr>
    )
  }

  const renderBodyRows = () =>
    !splitByLevel ? (
      [...allEvents].sort((a, b) => b.unix_ms - a.unix_ms).length ? (
        withStableRowKeys(
          [...allEvents].sort((a, b) => b.unix_ms - a.unix_ms),
          'all',
        ).map(({ event, key }) => renderRow(event, key))
      ) : (
        <tr>
          <td colSpan={5} className="aoHint">
            No events
          </td>
        </tr>
      )
    ) : (
      <>
        <tr className="aoEventsSection">
          <td colSpan={5}>
            <span>Info</span>
          </td>
        </tr>
        {infos.length ? (
          withStableRowKeys(infos, 'info').map(({ event, key }) => renderRow(event, key))
        ) : (
          <tr>
            <td colSpan={5} className="aoHint">
              No info events
            </td>
          </tr>
        )}

        {infos.length ? (
          <tr className="aoEventsGap" aria-hidden="true">
            <td colSpan={5} />
          </tr>
        ) : null}

        <tr className="aoEventsSection">
          <td colSpan={5}>
            <div className="aoEventsSectionRow">
              <div>
                <span>Errors / Warnings</span>
              </div>
            </div>
          </td>
        </tr>
        {(errors.length || warnings.length) ? (
          withStableRowKeys(
            [...warnings, ...errors]
              .sort((a, b) => b.unix_ms - a.unix_ms)
              .slice(0, 5),
            'issue',
          ).map(({ event, key }) => renderRow(event, key))
        ) : (
          <tr>
            <td colSpan={5} className="aoHint">
              No errors or warnings
            </td>
          </tr>
        )}
      </>
    )

  if (!scrollInside) {
    return (
      <>
        <div className="aoEventsTablePlain">
          <table className="aoTable aoTableFixed aoEventsTable">
            {renderColGroup()}
            <thead>
              <tr>
                <th>When</th>
                <th>Session</th>
                <th>Provider</th>
                <th className="aoEventsLevelCell">Level</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>{renderBodyRows()}</tbody>
          </table>
        </div>
        {messageDialog ? (
          <ModalBackdrop onClose={() => setMessageDialog(null)}>
            <div className="aoModal aoEventMessageModal" onClick={(e) => e.stopPropagation()}>
              <div className="aoModalHeader">
                <div className="aoModalTitle">{messageDialog.title}</div>
                <button className="aoTinyBtn" onClick={() => setMessageDialog(null)}>
                  Close
                </button>
              </div>
              <div className="aoModalBody">
                <pre className="aoEventMessageDialogBody">{messageDialog.text}</pre>
              </div>
            </div>
          </ModalBackdrop>
        ) : null}
      </>
    )
  }

  return (
    <div ref={eventsTableSurfaceRef} className="aoEventsTableSurface">
      <div className="aoEventsTableHead">
        <table className="aoTable aoTableFixed">
          {renderColGroup()}
          <thead>
            <tr>
              <th>When</th>
              <th>Session</th>
              <th>Provider</th>
              <th className="aoEventsLevelCell">Level</th>
              <th>Message</th>
            </tr>
          </thead>
        </table>
      </div>
      <div className="aoEventsTableBody">
        <div
          ref={eventsTableWrapRef}
          className="aoEventsTableWrap"
          onScroll={() => {
            if (scrollPersistKey && eventsTableWrapRef.current) {
              SCROLL_TOP_BY_KEY.set(scrollPersistKey, eventsTableWrapRef.current.scrollTop ?? 0)
            }
            if (onReachEnd && eventsTableWrapRef.current) {
              const wrap = eventsTableWrapRef.current
              const nearBottom = isNearBottom(wrap, 24)
              if (nearBottom && !wasNearBottomRef.current) {
                onReachEnd()
              }
              wasNearBottomRef.current = nearBottom
            }
            scheduleEventsScrollbarSync()
            activateEventsScrollbarUi()
          }}
          onWheel={() => {
            scheduleEventsScrollbarSync()
            activateEventsScrollbarUi()
          }}
          onTouchMove={activateEventsScrollbarUi}
        >
          <table className="aoTable aoTableFixed aoEventsTable">
            {renderColGroup()}
            <tbody>{renderBodyRows()}</tbody>
          </table>
        </div>
        <div
          ref={eventsScrollbarOverlayRef}
          className="aoEventsScrollbarOverlay"
          aria-hidden="true"
          onPointerDown={onEventsScrollbarPointerDown}
          onPointerMove={onEventsScrollbarPointerMove}
          onPointerUp={onEventsScrollbarPointerUp}
          onPointerCancel={onEventsScrollbarPointerUp}
          onLostPointerCapture={onEventsScrollbarLostPointerCapture}
        >
          <div ref={eventsScrollbarThumbRef} className="aoEventsScrollbarThumb" />
        </div>
      </div>
      {messageDialog ? (
        <ModalBackdrop onClose={() => setMessageDialog(null)}>
          <div className="aoModal aoEventMessageModal" onClick={(e) => e.stopPropagation()}>
            <div className="aoModalHeader">
              <div className="aoModalTitle">{messageDialog.title}</div>
              <button className="aoTinyBtn" onClick={() => setMessageDialog(null)}>
                Close
              </button>
            </div>
            <div className="aoModalBody">
              <pre className="aoEventMessageDialogBody">{messageDialog.text}</pre>
            </div>
          </div>
        </ModalBackdrop>
      ) : null}
    </div>
  )
}
