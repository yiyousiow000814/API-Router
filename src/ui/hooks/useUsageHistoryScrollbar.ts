import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

type DragState = {
  active: boolean
  pointerId: number
  pointerOffsetY: number
}

const IDLE_DRAG_STATE: DragState = { active: false, pointerId: -1, pointerOffsetY: 0 }

export function useUsageHistoryScrollbar() {
  const usageHistoryTableSurfaceRef = useRef<HTMLDivElement | null>(null)
  const usageHistoryTableWrapRef = useRef<HTMLDivElement | null>(null)
  const usageHistoryScrollbarOverlayRef = useRef<HTMLDivElement | null>(null)
  const usageHistoryScrollbarThumbRef = useRef<HTMLDivElement | null>(null)

  const usageHistoryScrollbarHideTimerRef = useRef<number | null>(null)
  const usageHistoryScrollbarRafRef = useRef<number | null>(null)
  const usageHistoryScrollbarDragRef = useRef<DragState>(IDLE_DRAG_STATE)

  const setUsageHistoryScrollbarVisible = useCallback((visible: boolean) => {
    usageHistoryTableSurfaceRef.current?.classList.toggle('aoUsageHistoryTableSurfaceScrollbarVisible', visible)
    usageHistoryScrollbarOverlayRef.current?.classList.toggle('aoUsageHistoryScrollbarOverlayVisible', visible)
  }, [])

  const setUsageHistoryScrollbarCanScroll = useCallback((canScroll: boolean) => {
    usageHistoryTableSurfaceRef.current?.classList.toggle('aoUsageHistoryTableSurfaceCanScroll', canScroll)
  }, [])

  const refreshUsageHistoryScrollbarUi = useCallback(() => {
    const wrap = usageHistoryTableWrapRef.current
    const overlay = usageHistoryScrollbarOverlayRef.current
    const thumb = usageHistoryScrollbarThumbRef.current
    if (!wrap || !overlay || !thumb) return
    const viewportHeight = wrap.clientHeight
    const overlayHeight = overlay.clientHeight
    const scrollHeight = wrap.scrollHeight
    const maxScroll = Math.max(0, scrollHeight - viewportHeight)
    if (viewportHeight <= 0 || overlayHeight <= 0 || maxScroll <= 0) {
      thumb.style.height = '0px'
      thumb.style.transform = 'translateY(0px)'
      setUsageHistoryScrollbarCanScroll(false)
      setUsageHistoryScrollbarVisible(false)
      return
    }
    setUsageHistoryScrollbarCanScroll(true)
    const thumbHeight = Math.max(24, Math.round((viewportHeight / scrollHeight) * overlayHeight))
    const thumbTravel = Math.max(0, overlayHeight - thumbHeight)
    const thumbTop = maxScroll > 0 ? Math.round((wrap.scrollTop / maxScroll) * thumbTravel) : 0
    thumb.style.height = `${thumbHeight}px`
    thumb.style.transform = `translateY(${thumbTop}px)`
  }, [setUsageHistoryScrollbarCanScroll, setUsageHistoryScrollbarVisible])

  const scheduleUsageHistoryScrollbarSync = useCallback(() => {
    if (typeof window === 'undefined') return
    if (usageHistoryScrollbarRafRef.current != null) return
    usageHistoryScrollbarRafRef.current = window.requestAnimationFrame(() => {
      usageHistoryScrollbarRafRef.current = null
      refreshUsageHistoryScrollbarUi()
    })
  }, [refreshUsageHistoryScrollbarUi])

  const activateUsageHistoryScrollbarUi = useCallback(() => {
    if (typeof window === 'undefined') return
    const wrap = usageHistoryTableWrapRef.current
    if (!wrap) return
    if (wrap.scrollHeight - wrap.clientHeight <= 1) return
    setUsageHistoryScrollbarVisible(true)

    if (usageHistoryScrollbarDragRef.current.active) {
      if (usageHistoryScrollbarHideTimerRef.current != null) {
        window.clearTimeout(usageHistoryScrollbarHideTimerRef.current)
        usageHistoryScrollbarHideTimerRef.current = null
      }
      return
    }

    if (usageHistoryScrollbarHideTimerRef.current != null) {
      window.clearTimeout(usageHistoryScrollbarHideTimerRef.current)
    }
    usageHistoryScrollbarHideTimerRef.current = window.setTimeout(() => {
      setUsageHistoryScrollbarVisible(false)
      usageHistoryScrollbarHideTimerRef.current = null
    }, 700)
  }, [setUsageHistoryScrollbarVisible])

  const scrollUsageHistoryByThumbTop = useCallback((thumbTopPx: number) => {
    const wrap = usageHistoryTableWrapRef.current
    const overlay = usageHistoryScrollbarOverlayRef.current
    const thumb = usageHistoryScrollbarThumbRef.current
    if (!wrap || !overlay || !thumb) return

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
    scheduleUsageHistoryScrollbarSync()
    activateUsageHistoryScrollbarUi()
  }, [activateUsageHistoryScrollbarUi, scheduleUsageHistoryScrollbarSync])

  const onUsageHistoryScrollbarPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const wrap = usageHistoryTableWrapRef.current
      const overlay = usageHistoryScrollbarOverlayRef.current
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

      usageHistoryScrollbarDragRef.current = { active: true, pointerId: e.pointerId, pointerOffsetY }
      activateUsageHistoryScrollbarUi()
      scrollUsageHistoryByThumbTop(y - pointerOffsetY)
    },
    [activateUsageHistoryScrollbarUi, scrollUsageHistoryByThumbTop],
  )

  const onUsageHistoryScrollbarPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = usageHistoryScrollbarDragRef.current
      if (!drag.active || drag.pointerId !== e.pointerId) return
      const overlay = usageHistoryScrollbarOverlayRef.current
      if (!overlay) return

      e.preventDefault()
      e.stopPropagation()

      const r = overlay.getBoundingClientRect()
      const y = e.clientY - r.top
      scrollUsageHistoryByThumbTop(y - drag.pointerOffsetY)
    },
    [scrollUsageHistoryByThumbTop],
  )

  const onUsageHistoryScrollbarPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = usageHistoryScrollbarDragRef.current
      if (!drag.active || drag.pointerId !== e.pointerId) return
      const overlay = usageHistoryScrollbarOverlayRef.current
      if (!overlay) return

      e.preventDefault()
      e.stopPropagation()

      usageHistoryScrollbarDragRef.current = IDLE_DRAG_STATE
      try {
        overlay.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      activateUsageHistoryScrollbarUi()
    },
    [activateUsageHistoryScrollbarUi],
  )

  const onUsageHistoryScrollbarLostPointerCapture = useCallback(() => {
    if (!usageHistoryScrollbarDragRef.current.active) return
    usageHistoryScrollbarDragRef.current = IDLE_DRAG_STATE
    activateUsageHistoryScrollbarUi()
  }, [activateUsageHistoryScrollbarUi])

  const resetUsageHistoryScrollbarState = useCallback(() => {
    usageHistoryScrollbarDragRef.current = IDLE_DRAG_STATE
    setUsageHistoryScrollbarVisible(false)
  }, [setUsageHistoryScrollbarVisible])

  const clearUsageHistoryScrollbarTimers = useCallback(() => {
    if (typeof window === 'undefined') return
    if (usageHistoryScrollbarHideTimerRef.current != null) {
      window.clearTimeout(usageHistoryScrollbarHideTimerRef.current)
      usageHistoryScrollbarHideTimerRef.current = null
    }
    if (usageHistoryScrollbarRafRef.current != null) {
      window.cancelAnimationFrame(usageHistoryScrollbarRafRef.current)
      usageHistoryScrollbarRafRef.current = null
    }
  }, [])

  return {
    usageHistoryTableSurfaceRef,
    usageHistoryTableWrapRef,
    usageHistoryScrollbarOverlayRef,
    usageHistoryScrollbarThumbRef,
    refreshUsageHistoryScrollbarUi,
    scheduleUsageHistoryScrollbarSync,
    activateUsageHistoryScrollbarUi,
    onUsageHistoryScrollbarPointerDown,
    onUsageHistoryScrollbarPointerMove,
    onUsageHistoryScrollbarPointerUp,
    onUsageHistoryScrollbarLostPointerCapture,
    resetUsageHistoryScrollbarState,
    clearUsageHistoryScrollbarTimers,
  }
}
