const EDGE_SIZE = 72
const OUTSIDE_RANGE = 1000
const MAX_SPEED_DOWN = 820
const MAX_SPEED_UP = 520
const MIN_SPEED = 120

type ItemNodeMap = Record<string, HTMLDivElement | null>

type ClampDragTopParams<T extends string> = {
  listNode: HTMLDivElement
  listRect: DOMRect
  currentOrder: T[]
  draggingId: T
  itemRefs: ItemNodeMap
  dragTopRaw: number
  dragHeight: number
}

export function clampDragTopToList<T extends string>({
  listNode,
  listRect,
  currentOrder,
  draggingId,
  itemRefs,
  dragTopRaw,
  dragHeight,
}: ClampDragTopParams<T>): { dragTop: number; dragTopInList: number } {
  let maxBottomInList = 0

  for (const id of currentOrder) {
    if (id === draggingId) continue
    const node = itemRefs[id]
    if (!node) continue
    const rect = node.getBoundingClientRect()
    maxBottomInList = Math.max(maxBottomInList, rect.bottom - listRect.top)
  }

  const placeholder = listNode.querySelector('.aoProviderConfigPlaceholder') as HTMLElement | null
  if (placeholder) {
    const rect = placeholder.getBoundingClientRect()
    maxBottomInList = Math.max(maxBottomInList, rect.bottom - listRect.top)
  }

  const maxTopInList = Math.max(0, maxBottomInList - dragHeight)
  const dragTopInListRaw = dragTopRaw - listRect.top
  const dragTopInList = Math.max(0, Math.min(maxTopInList, dragTopInListRaw))
  return {
    dragTop: dragTopInList + listRect.top,
    dragTopInList,
  }
}

export function computeAutoScrollVelocity(clientY: number, scrollRect: DOMRect): number {
  const distTopRaw = clientY - scrollRect.top
  if (distTopRaw < EDGE_SIZE && distTopRaw > -OUTSIDE_RANGE) {
    const distTop = Math.max(0, distTopRaw)
    const t = (EDGE_SIZE - distTop) / EDGE_SIZE
    const eased = t * t
    return -Math.round(MIN_SPEED + (MAX_SPEED_UP - MIN_SPEED) * eased)
  }

  const distBottomRaw = scrollRect.bottom - clientY
  if (distBottomRaw < EDGE_SIZE && distBottomRaw > -OUTSIDE_RANGE) {
    const distBottom = Math.max(0, distBottomRaw)
    const t = (EDGE_SIZE - distBottom) / EDGE_SIZE
    const eased = t * t
    return Math.round(MIN_SPEED + (MAX_SPEED_DOWN - MIN_SPEED) * eased)
  }

  return 0
}

export function shouldStopForVisibleRows(
  velocity: number,
  listNode: HTMLDivElement | null,
  scrollRect: DOMRect,
): boolean {
  if (!listNode || velocity === 0) return false

  const children = Array.from(listNode.children) as HTMLElement[]
  const visibleChildren = children.filter((el) => !el.classList.contains('aoProviderConfigDragging'))
  const firstEl = visibleChildren[0] ?? null
  const lastEl = visibleChildren.length ? visibleChildren[visibleChildren.length - 1] : null
  const pad = 2

  if (velocity < 0 && firstEl) {
    const rect = firstEl.getBoundingClientRect()
    return rect.top >= scrollRect.top + pad
  }

  if (velocity > 0 && lastEl) {
    const rect = lastEl.getBoundingClientRect()
    return rect.bottom <= scrollRect.bottom - pad
  }

  return false
}

export function isAtScrollBoundary(scrollParent: HTMLElement, velocity: number): boolean {
  const maxScrollTop = Math.max(0, scrollParent.scrollHeight - scrollParent.clientHeight)
  return (
    (velocity < 0 && scrollParent.scrollTop <= 0) ||
    (velocity > 0 && scrollParent.scrollTop >= maxScrollTop - 0.5)
  )
}
