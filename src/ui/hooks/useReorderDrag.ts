import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

type ReorderDragParams<T extends string> = {
  items: T[]
  onReorder: (next: T[]) => void
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
export function useReorderDrag<T extends string>({ items, onReorder }: ReorderDragParams<T>): ReorderDragResult<T> {
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
        let movingDown = dragMovingDownRef.current
        if (movingDown === null) {
          if (dyFromStart > 1) movingDown = true
          else if (dyFromStart < -1) movingDown = false
        } else {
          if (dyEvent > 1.5) movingDown = true
          else if (dyEvent < -1.5) movingDown = false
        }
        dragMovingDownRef.current = movingDown
        dragLastYRef.current = clientY
      }

      // Keep the overlay positioned in list-local coordinates so it stays clipped inside the modal/list.
      const listNode = listRef.current
      const listRect = listNode?.getBoundingClientRect()
      const dragTopRaw = clientY - dragPointerOffsetRef.current

      // Clamp the overlay to the list's content bounds. Without this, the absolute-positioned overlay
      // can extend the scrollHeight and allow "infinite" scrolling into blank space when dragging
      // from the very top to the very bottom.
      let dragTop = dragTopRaw
      if (listNode && listRect) {
        const dragHeight = dragCardHeightRef.current || 0
        let maxBottomInList = 0

        // Cards currently in the list (excluding the dragged card which is rendered as the overlay).
        const current = dragOrderRef.current.length ? dragOrderRef.current : itemsRef.current
        for (const id of current) {
          if (id === dragging) continue
          const node = itemRefs.current[id]
          if (!node) continue
          const rect = node.getBoundingClientRect()
          maxBottomInList = Math.max(maxBottomInList, rect.bottom - listRect.top)
        }

        // Placeholder represents the dragged slot; include it in bounds so you can drag to the end.
        const ph = listNode.querySelector('.aoProviderConfigPlaceholder') as HTMLElement | null
        if (ph) {
          const rect = ph.getBoundingClientRect()
          maxBottomInList = Math.max(maxBottomInList, rect.bottom - listRect.top)
        }

        const maxTopInList = Math.max(0, maxBottomInList - dragHeight)
        const dragTopInListRaw = dragTopRaw - listRect.top
        const dragTopInList = Math.max(0, Math.min(maxTopInList, dragTopInListRaw))
        dragTop = dragTopInList + listRect.top

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

      // Touch highlight: only when the dragged card overlaps a card in the current direction.
      if (movingDown === null) {
        setDragOverId(null)
      } else {
        const touchEps = 0.5
        let touchTarget: T | null = null
        let bestGap = Number.NEGATIVE_INFINITY

        for (const id of rest) {
          const node = itemRefs.current[id]
          if (!node) continue
          const rect = node.getBoundingClientRect()

          if (movingDown) {
            // Only consider cards below.
            if (rect.top < dragTop + touchEps) continue
            const gap = rect.top - dragBottom
            if (gap <= -touchEps && gap > bestGap) {
              bestGap = gap
              touchTarget = id
            }
          } else {
            // Only consider cards above.
            if (rect.bottom > dragBottom - touchEps) continue
            const gap = dragTop - rect.bottom
            if (gap <= -touchEps && gap > bestGap) {
              bestGap = gap
              touchTarget = id
            }
          }
        }

        setDragOverId(touchTarget)
      }

      if (movingDown === null) return

      // Reorder hysteresis (kept from the tuned behavior in App.tsx).
      const dragProbe = dragTop + dragHeight * (movingDown ? 0.82 : 0.22)
      let insertIdx = rest.length
      for (let i = 0; i < rest.length; i += 1) {
        const id = rest[i]
        const node = itemRefs.current[id]
        if (!node) continue
        const rect = node.getBoundingClientRect()
        const midpoint = rect.top + rect.height / 2
        if (dragProbe < midpoint) {
          insertIdx = i
          break
        }
      }

      const next = [...rest]
      next.splice(insertIdx, 0, dragging)
      if (next.join('|') === current.join('|')) return
      dragOrderRef.current = next
      const first = new Map<T, DOMRect>()
      for (const id of current) {
        if (id === dragging) continue
        const node = itemRefs.current[id]
        if (node) first.set(id, node.getBoundingClientRect())
      }
      setDragPreviewOrder(next)
      requestAnimationFrame(() => {
        for (const id of next) {
          if (id === dragging) continue
          const node = itemRefs.current[id]
          const before = first.get(id)
          if (!node || !before) continue
          const after = node.getBoundingClientRect()
          const dx = before.left - after.left
          const dy = before.top - after.top
          if (dx === 0 && dy === 0) continue
          node.getAnimations().forEach((anim) => anim.cancel())
          node.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: 'translate(0, 0)' },
            ],
            { duration: 200, easing: 'cubic-bezier(0.2, 0.6, 0.2, 1)' },
          )
        }
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

      const r = sp.getBoundingClientRect()
      // Bigger edge makes it easier to trigger; easing + time-based speed keeps it smooth.
      const edge = 72 // px
      // Allow auto-scroll to keep running even if the pointer drifts slightly outside the scroll container.
      // (Helps when the modal is near the window edge and you keep dragging past it.)
      const outside = 1000 // px
      // Faster by default, but still time-based to avoid "teleporting" on high refresh rates.
      const maxSpeedDown = 820 // px/sec
      const maxSpeedUp = 520 // px/sec
      const minSpeed = 120 // px/sec (so it can still progress when just inside the edge)

      let v = 0
      const distTopRaw = clientY - r.top
      const distBottomRaw = r.bottom - clientY
      // Autoscroll direction is determined by proximity to the container edges (not drag direction),
      // otherwise tiny pointer jitters can make it feel "hard to trigger".
      if (distTopRaw < edge && distTopRaw > -outside) {
        // Clamp: outside the container counts as "max trigger".
        const distTop = Math.max(0, distTopRaw)
        const t = (edge - distTop) / edge
        const eased = t * t
        v = -Math.round(minSpeed + (maxSpeedUp - minSpeed) * eased)
      } else if (distBottomRaw < edge && distBottomRaw > -outside) {
        const distBottom = Math.max(0, distBottomRaw)
        const t = (edge - distBottom) / edge
        const eased = t * t
        v = Math.round(minSpeed + (maxSpeedDown - minSpeed) * eased)
      }

      // Don't scroll into blank space: once the first/last real row is fully visible, stop scrolling
      // further in that direction (even if the dragged item hasn't reached idx 0/last yet).
      if (v !== 0) {
        const listNode = listRef.current
        if (listNode) {
          const kids = Array.from(listNode.children) as HTMLElement[]
          const visibleKids = kids.filter((el) => !el.classList.contains('aoProviderConfigDragging'))
          const firstEl = visibleKids[0] ?? null
          const lastEl = visibleKids.length ? visibleKids[visibleKids.length - 1] : null
          const pad = 2

          if (v < 0 && firstEl) {
            const fr = firstEl.getBoundingClientRect()
            if (fr.top >= r.top + pad) {
              stopAutoScroll()
              return
            }
          }

          if (v > 0 && lastEl) {
            const lr = lastEl.getBoundingClientRect()
            if (lr.bottom <= r.bottom - pad) {
              stopAutoScroll()
              return
            }
          }
        }
      }

      // Stop at scroll bounds.
      const maxScrollTop = Math.max(0, sp.scrollHeight - sp.clientHeight)
      if ((v < 0 && sp.scrollTop <= 0) || (v > 0 && sp.scrollTop >= maxScrollTop - 0.5)) {
        stopAutoScroll()
        return
      }

      autoScrollVelRef.current = v
      if (v === 0) {
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
        // Clamp dt so background/tab-switch doesn't cause a giant jump.
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
        // Some platforms clamp scrollTop without firing a scroll event; detect it and stop.
        if (sp2.scrollTop === before) {
          stopAutoScroll()
          autoScrollRafRef.current = null
          return
        }

        // Keep highlight/reorder in sync while scrolling even if the pointer doesn't move.
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
      // Allow reaching offscreen slots by auto-scrolling the modal body near its edges.
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
    const changed = start.length !== finalOrder.length || start.some((id, idx) => id !== finalOrder[idx])
    dragStartOrderRef.current = []
    dragOrderRef.current = []
    if (changed) onReorder(finalOrder)
  }, [onDragMove, onReorder, stopAutoScroll])

  const onHandlePointerDown = useCallback(
    (id: T, e: ReactPointerEvent) => {
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

      // Find the nearest scrollable parent (the Config modal body).
      let sp: HTMLElement | null = listNode
      while (sp) {
        const style = window.getComputedStyle(sp)
        const oy = style.overflowY
        const scrollable = (oy === 'auto' || oy === 'scroll') && sp.scrollHeight > sp.clientHeight + 1
        if (scrollable) break
        sp = sp.parentElement
      }
      scrollParentRef.current = sp

      // Keep overlay within the list's clipping context.
      setDragBaseTop(dragStartTopInListRef.current)

      // If the container scrolls (wheel / trackpad / programmatic), keep the overlay and
      // drag-over calculations pinned to the pointer even if the pointer doesn't move.
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
    [onDragMove, onDragUp, recomputeFromClientY, stopAutoScroll],
  )

  // Ensure the item ref map doesn't grow unbounded if items are removed/renamed.
  useEffect(() => {
    itemsRef.current = items
    const alive = new Set(items)
    for (const k of Object.keys(itemRefs.current)) {
      if (!alive.has(k as T)) delete itemRefs.current[k]
    }
  }, [items])

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
