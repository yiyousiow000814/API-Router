import { useCallback, useRef } from 'react'

type DragState = {
  active: boolean
  pointerId: number
  pointerOffsetY: number
}

export function useUsageHistoryScrollbar() {
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  const tableSurfaceRef = useRef<HTMLDivElement | null>(null)
  const scrollbarOverlayRef = useRef<HTMLDivElement | null>(null)
  const scrollbarThumbRef = useRef<HTMLDivElement | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const dragRef = useRef<DragState>({ active: false, pointerId: -1, pointerOffsetY: 0 })

  const setVisible = useCallback((visible: boolean) => {
    tableSurfaceRef.current?.classList.toggle('aoUsageHistoryTableSurfaceScrollbarVisible', visible)
    scrollbarOverlayRef.current?.classList.toggle('aoUsageHistoryScrollbarOverlayVisible', visible)
  }, [])

  const setCanScroll = useCallback((canScroll: boolean) => {
    tableSurfaceRef.current?.classList.toggle('aoUsageHistoryTableSurfaceCanScroll', canScroll)
  }, [])

  const refreshUi = useCallback(() => {
    const wrap = tableWrapRef.current
    const overlay = scrollbarOverlayRef.current
    const thumb = scrollbarThumbRef.current
    if (!wrap || !overlay || !thumb) return
    const viewportHeight = wrap.clientHeight
    const overlayHeight = overlay.clientHeight
    const scrollHeight = wrap.scrollHeight
    const maxScroll = Math.max(0, scrollHeight - viewportHeight)
    if (viewportHeight <= 0 || overlayHeight <= 0 || maxScroll <= 0) {
      thumb.style.height = '0px'
      thumb.style.transform = 'translateY(0px)'
      setCanScroll(false)
      setVisible(false)
      return
    }
    setCanScroll(true)
    const thumbHeight = Math.max(24, Math.round((viewportHeight / scrollHeight) * overlayHeight))
    const thumbTravel = Math.max(0, overlayHeight - thumbHeight)
    const thumbTop = maxScroll > 0 ? Math.round((wrap.scrollTop / maxScroll) * thumbTravel) : 0
    thumb.style.height = `${thumbHeight}px`
    thumb.style.transform = `translateY(${thumbTop}px)`
  }, [setCanScroll, setVisible])

  const scheduleSync = useCallback(() => {
    if (typeof window === 'undefined') return
    if (rafRef.current != null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      refreshUi()
    })
  }, [refreshUi])

  const activateUi = useCallback(() => {
    if (typeof window === 'undefined') return
    const wrap = tableWrapRef.current
    if (!wrap) return
    if (wrap.scrollHeight - wrap.clientHeight <= 1) return
    setVisible(true)

    if (dragRef.current.active) {
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      return
    }

    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current)
    }
    hideTimerRef.current = window.setTimeout(() => {
      setVisible(false)
      hideTimerRef.current = null
    }, 700)
  }, [setVisible])

  const scrollByThumbTop = useCallback(
    (thumbTopPx: number) => {
      const wrap = tableWrapRef.current
      const overlay = scrollbarOverlayRef.current
      const thumb = scrollbarThumbRef.current
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
      scheduleSync()
      activateUi()
    },
    [activateUi, scheduleSync],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wrap = tableWrapRef.current
      const overlay = scrollbarOverlayRef.current
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

      const rect = overlay.getBoundingClientRect()
      const y = e.clientY - rect.top
      const pointerOffsetY = Math.max(0, Math.min(thumbHeight, y - currentThumbTop))

      dragRef.current = { active: true, pointerId: e.pointerId, pointerOffsetY }
      activateUi()
      scrollByThumbTop(y - pointerOffsetY)
    },
    [activateUi, scrollByThumbTop],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag.active || drag.pointerId !== e.pointerId) return
      const overlay = scrollbarOverlayRef.current
      if (!overlay) return

      e.preventDefault()
      e.stopPropagation()

      const rect = overlay.getBoundingClientRect()
      const y = e.clientY - rect.top
      scrollByThumbTop(y - drag.pointerOffsetY)
    },
    [scrollByThumbTop],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag.active || drag.pointerId !== e.pointerId) return
      const overlay = scrollbarOverlayRef.current
      if (!overlay) return

      e.preventDefault()
      e.stopPropagation()

      dragRef.current = { active: false, pointerId: -1, pointerOffsetY: 0 }
      try {
        overlay.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      activateUi()
    },
    [activateUi],
  )

  const onLostPointerCapture = useCallback(() => {
    const drag = dragRef.current
    if (!drag.active) return
    dragRef.current = { active: false, pointerId: -1, pointerOffsetY: 0 }
    activateUi()
  }, [activateUi])

  const clearRuntime = useCallback(() => {
    dragRef.current = { active: false, pointerId: -1, pointerOffsetY: 0 }
    if (typeof window !== 'undefined') {
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  return {
    tableWrapRef,
    tableSurfaceRef,
    scrollbarOverlayRef,
    scrollbarThumbRef,
    setVisible,
    refreshUi,
    scheduleSync,
    activateUi,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onLostPointerCapture,
    clearRuntime,
  }
}
