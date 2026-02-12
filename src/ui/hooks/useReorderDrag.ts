import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

import {
  clampDragTopToList,
  computeAutoScrollVelocity,
  isAtScrollBoundary,
  shouldStopForVisibleRows,
} from './useReorderDrag.constraints'
import { findInsertIndex, findTouchTarget, resolveDragDirection } from './useReorderDrag.pointerMath'
import {
  animateReorderFlip,
  buildNextOrder,
  captureRects,
  findScrollableParent,
  hasOrderChanged,
  pruneItemRefs,
} from './useReorderDrag.stateHelpers'

type ReorderDragParams<T extends string> = {
  items: T[]
  onReorder: (next: T[]) => void
  enabled?: boolean
}

type ReorderDragResult<T extends string> = {
  listRef: RefObject<HTMLDivElement | null>
  registerItemRef: (id: T) => (node: HTMLDivElement | null) => void

  draggingId: T | null
  dragOverId: T | null
  dragPreviewOrder: T[] | null

  dragOffsetY: number
  dragBaseTop: number
  dragCardHeight: number

  onHandlePointerDown: (id: T, e: ReactPointerEvent) => void
}

// Drag-to-reorder logic extracted from App.tsx so it can be maintained independently.
export function useReorderDrag<T extends string>({
  items,
  onReorder,
  enabled = true,
}: ReorderDragParams<T>): ReorderDragResult<T> {
  const itemsRef = useRef<T[]>(items)
  const listRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const scrollParentRef = useRef<HTMLElement | null>(null)

  const [draggingId, setDraggingId] = useState<T | null>(null)
  const [dragOverId, setDragOverId] = useState<T | null>(null)
  const [dragPreviewOrder, setDragPreviewOrder] = useState<T[] | null>(null)
  const [dragOffsetY, setDragOffsetY] = useState<number>(0)
  const [dragBaseTop, setDragBaseTop] = useState<number>(0)
  const [dragCardHeight, setDragCardHeight] = useState<number>(0)

  const dragHandleIdRef = useRef<T | null>(null)
  const dragStartOrderRef = useRef<T[]>([])
  const dragOrderRef = useRef<T[]>([])
  const dragPointerOffsetRef = useRef<number>(0)
  const dragStartTopRef = useRef<number>(0)
  const dragStartTopInListRef = useRef<number>(0)
  const dragStartYRef = useRef<number>(0)
  const dragLastYRef = useRef<number>(0)
  const dragMovingDownRef = useRef<boolean | null>(null)
  const dragCardHeightRef = useRef<number>(0)
  const autoScrollRafRef = useRef<number | null>(null)
  // px/sec (time-based so high-refresh monitors don't make it feel like "teleporting")
  const autoScrollVelRef = useRef<number>(0)
  const autoScrollLastTsRef = useRef<number>(0)
  const onScrollDuringDragRef = useRef<((this: HTMLElement, ev: Event) => void) | null>(null)

  const recomputeFromClientY = useCallback((clientY: number, opts?: { updateDirection?: boolean }) => {
    const dragging = dragHandleIdRef.current
    if (!dragging) return

    const updateDirection = opts?.updateDirection ?? false
    if (updateDirection) {
      const dyFromStart = clientY - dragStartYRef.current
      const dyEvent = clientY - dragLastYRef.current
      dragMovingDownRef.current = resolveDragDirection(dragMovingDownRef.current, dyFromStart, dyEvent)
      dragLastYRef.current = clientY
    }

    const dragTopRaw = clientY - dragPointerOffsetRef.current
    const listNode = listRef.current
    const listRect = listNode?.getBoundingClientRect()
    let dragTop = dragTopRaw

    if (listNode && listRect) {
      const currentOrder = dragOrderRef.current.length ? dragOrderRef.current : itemsRef.current
      const { dragTop: clampedTop, dragTopInList } = clampDragTopToList({
        listNode,
        listRect,
        currentOrder,
        draggingId: dragging,
        itemRefs: itemRefs.current,
        dragTopRaw,
        dragHeight: dragCardHeightRef.current || 0,
      })
      dragTop = clampedTop
      setDragOffsetY(dragTopInList - dragStartTopInListRef.current)
    } else {
      setDragOffsetY(dragTopRaw - dragStartTopRef.current)
    }

    const current = dragOrderRef.current.length ? dragOrderRef.current : itemsRef.current
    const rest = current.filter((id) => id !== dragging)
    if (!rest.length) return

    const dragHeight = dragCardHeightRef.current || 0
    const dragBottom = dragTop + dragHeight
    const movingDown = dragMovingDownRef.current

    if (movingDown === null) {
      setDragOverId(null)
    } else {
      setDragOverId(findTouchTarget(rest, itemRefs.current, dragTop, dragBottom, movingDown))
    }

    if (movingDown === null) return

    const insertIdx = findInsertIndex(rest, itemRefs.current, dragTop, dragHeight, movingDown)
    const next = buildNextOrder(rest, dragging, insertIdx)
    if (next.join('|') === current.join('|')) return

    dragOrderRef.current = next
    const firstRects = captureRects(current, dragging, itemRefs.current)
    setDragPreviewOrder(next)
    requestAnimationFrame(() => {
      animateReorderFlip(next, dragging, firstRects, itemRefs.current)
    })
  }, [])

  const stopAutoScroll = useCallback(() => {
    autoScrollVelRef.current = 0
    autoScrollLastTsRef.current = 0
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current)
      autoScrollRafRef.current = null
    }
  }, [])

  const updateAutoScrollFromClientY = useCallback(
    (clientY: number) => {
      const sp = scrollParentRef.current
      if (!sp) return
      if (sp.scrollHeight <= sp.clientHeight + 1) return

      const scrollRect = sp.getBoundingClientRect()
      const velocity = computeAutoScrollVelocity(clientY, scrollRect)

      if (velocity !== 0 && shouldStopForVisibleRows(velocity, listRef.current, scrollRect)) {
        stopAutoScroll()
        return
      }

      if (isAtScrollBoundary(sp, velocity)) {
        stopAutoScroll()
        return
      }

      autoScrollVelRef.current = velocity
      if (velocity === 0) {
        stopAutoScroll()
        return
      }

      if (autoScrollRafRef.current !== null) return
      autoScrollLastTsRef.current = performance.now()
      const tick = () => {
        const sp2 = scrollParentRef.current
        const vel = autoScrollVelRef.current
        if (!sp2 || vel === 0) {
          autoScrollRafRef.current = null
          return
        }

        const now = performance.now()
        const last = autoScrollLastTsRef.current || now
        autoScrollLastTsRef.current = now
        const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
        if (dt === 0) {
          autoScrollRafRef.current = requestAnimationFrame(tick)
          return
        }

        const maxScrollTop2 = Math.max(0, sp2.scrollHeight - sp2.clientHeight)
        if ((vel < 0 && sp2.scrollTop <= 0.5) || (vel > 0 && sp2.scrollTop >= maxScrollTop2 - 0.5)) {
          stopAutoScroll()
          autoScrollRafRef.current = null
          return
        }

        const before = sp2.scrollTop
        sp2.scrollTop = Math.max(0, Math.min(maxScrollTop2, sp2.scrollTop + vel * dt))
        if (sp2.scrollTop === before) {
          stopAutoScroll()
          autoScrollRafRef.current = null
          return
        }

        recomputeFromClientY(dragLastYRef.current, { updateDirection: false })
        autoScrollRafRef.current = requestAnimationFrame(tick)
      }
      autoScrollRafRef.current = requestAnimationFrame(tick)
    },
    [recomputeFromClientY, stopAutoScroll],
  )

  const registerItemRef = useCallback(
    (id: T) => (node: HTMLDivElement | null) => {
      itemRefs.current[id] = node
    },
    [],
  )

  const onDragMove = useCallback(
    (e: PointerEvent) => {
      recomputeFromClientY(e.clientY, { updateDirection: true })
      updateAutoScrollFromClientY(e.clientY)
    },
    [recomputeFromClientY, updateAutoScrollFromClientY],
  )

  const onDragUp = useCallback(() => {
    const dragging = dragHandleIdRef.current
    dragHandleIdRef.current = null
    stopAutoScroll()

    setDraggingId(null)
    setDragOverId(null)
    setDragOffsetY(0)
    setDragPreviewOrder(null)
    setDragBaseTop(0)
    setDragCardHeight(0)
    dragCardHeightRef.current = 0
    dragStartTopInListRef.current = 0
    autoScrollVelRef.current = 0
    autoScrollLastTsRef.current = 0

    const sp = scrollParentRef.current
    if (sp && onScrollDuringDragRef.current) {
      sp.removeEventListener('scroll', onScrollDuringDragRef.current as EventListener)
    }
    onScrollDuringDragRef.current = null
    scrollParentRef.current = null

    window.removeEventListener('pointermove', onDragMove as EventListener)
    window.removeEventListener('pointerup', onDragUp as EventListener)

    if (!dragging) return
    const start = dragStartOrderRef.current
    const finalOrder = dragOrderRef.current.length ? dragOrderRef.current : itemsRef.current
    const changed = hasOrderChanged(start, finalOrder)
    dragStartOrderRef.current = []
    dragOrderRef.current = []
    if (changed) onReorder(finalOrder)
  }, [onDragMove, onReorder, stopAutoScroll])

  const cancelDrag = useCallback(() => {
    dragHandleIdRef.current = null
    stopAutoScroll()

    setDraggingId(null)
    setDragOverId(null)
    setDragOffsetY(0)
    setDragPreviewOrder(null)
    setDragBaseTop(0)
    setDragCardHeight(0)
    dragCardHeightRef.current = 0
    dragStartTopInListRef.current = 0
    autoScrollVelRef.current = 0
    autoScrollLastTsRef.current = 0
    dragStartOrderRef.current = []
    dragOrderRef.current = []

    const sp = scrollParentRef.current
    if (sp && onScrollDuringDragRef.current) {
      sp.removeEventListener('scroll', onScrollDuringDragRef.current as EventListener)
    }
    onScrollDuringDragRef.current = null
    scrollParentRef.current = null

    window.removeEventListener('pointermove', onDragMove as EventListener)
    window.removeEventListener('pointerup', onDragUp as EventListener)
  }, [onDragMove, onDragUp, stopAutoScroll])

  const onHandlePointerDown = useCallback(
    (id: T, e: ReactPointerEvent) => {
      if (!enabled) return
      e.preventDefault()

      dragHandleIdRef.current = id
      dragStartOrderRef.current = itemsRef.current
      dragOrderRef.current = itemsRef.current

      const node = itemRefs.current[id]
      const rect = node?.getBoundingClientRect()
      const listNode = listRef.current
      const listRect = listNode?.getBoundingClientRect()
      dragStartYRef.current = e.clientY
      dragLastYRef.current = e.clientY
      dragMovingDownRef.current = null
      dragPointerOffsetRef.current = rect ? e.clientY - rect.top : 0
      dragStartTopRef.current = rect?.top ?? 0
      dragStartTopInListRef.current = rect && listRect ? rect.top - listRect.top : 0

      const h = rect?.height ?? 0
      dragCardHeightRef.current = h
      setDragCardHeight(h)

      scrollParentRef.current = findScrollableParent(listNode)
      setDragBaseTop(dragStartTopInListRef.current)

      const sp = scrollParentRef.current
      if (sp) {
        const onScroll = () => {
          recomputeFromClientY(dragLastYRef.current, { updateDirection: false })
        }
        onScrollDuringDragRef.current = onScroll as unknown as (this: HTMLElement, ev: Event) => void
        sp.addEventListener('scroll', onScrollDuringDragRef.current as EventListener, { passive: true })
      }

      setDraggingId(id)
      setDragOffsetY(0)
      setDragPreviewOrder(itemsRef.current)
      stopAutoScroll()

      window.addEventListener('pointermove', onDragMove as EventListener)
      window.addEventListener('pointerup', onDragUp as EventListener)
    },
    [enabled, onDragMove, onDragUp, recomputeFromClientY, stopAutoScroll],
  )

  useEffect(() => {
    itemsRef.current = items
    pruneItemRefs(itemRefs.current, items)
  }, [items])

  useEffect(() => {
    if (enabled) return
    if (!dragHandleIdRef.current) return
    cancelDrag()
  }, [enabled, cancelDrag])

  return {
    listRef,
    registerItemRef,
    draggingId,
    dragOverId,
    dragPreviewOrder,
    dragOffsetY,
    dragBaseTop,
    dragCardHeight,
    onHandlePointerDown,
  }
}
