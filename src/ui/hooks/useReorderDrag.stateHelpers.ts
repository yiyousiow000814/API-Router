type ItemNodeMap = Record<string, HTMLDivElement | null>

export function buildNextOrder<T extends string>(rest: T[], draggingId: T, insertIdx: number): T[] {
  const next = [...rest]
  next.splice(insertIdx, 0, draggingId)
  return next
}

export function hasOrderChanged<T extends string>(before: T[], after: T[]): boolean {
  return before.length !== after.length || before.some((id, idx) => id !== after[idx])
}

export function captureRects<T extends string>(order: T[], draggingId: T, itemRefs: ItemNodeMap): Map<T, DOMRect> {
  const rects = new Map<T, DOMRect>()
  for (const id of order) {
    if (id === draggingId) continue
    const node = itemRefs[id]
    if (node) rects.set(id, node.getBoundingClientRect())
  }
  return rects
}

export function animateReorderFlip<T extends string>(
  order: T[],
  draggingId: T,
  firstRects: Map<T, DOMRect>,
  itemRefs: ItemNodeMap,
): void {
  for (const id of order) {
    if (id === draggingId) continue
    const node = itemRefs[id]
    const before = firstRects.get(id)
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
}

export function findScrollableParent(node: HTMLElement | null): HTMLElement | null {
  let current = node
  while (current) {
    const style = window.getComputedStyle(current)
    const overflowY = style.overflowY
    const isScrollable = (overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight + 1
    if (isScrollable) return current
    current = current.parentElement
  }
  return null
}

export function pruneItemRefs<T extends string>(itemRefs: ItemNodeMap, items: T[]): void {
  const alive = new Set(items)
  for (const key of Object.keys(itemRefs)) {
    if (!alive.has(key as T)) delete itemRefs[key]
  }
}
