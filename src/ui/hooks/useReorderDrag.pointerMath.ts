type ItemNodeMap = Record<string, HTMLDivElement | null>

export function resolveDragDirection(
  movingDown: boolean | null,
  dyFromStart: number,
  dyEvent: number,
): boolean | null {
  if (movingDown === null) {
    if (dyFromStart > 1) return true
    if (dyFromStart < -1) return false
    return null
  }

  if (dyEvent > 1.5) return true
  if (dyEvent < -1.5) return false
  return movingDown
}

export function findTouchTarget<T extends string>(
  rest: T[],
  itemRefs: ItemNodeMap,
  dragTop: number,
  dragBottom: number,
  movingDown: boolean,
): T | null {
  const touchEps = 0.5
  let touchTarget: T | null = null
  let bestGap = Number.NEGATIVE_INFINITY

  for (const id of rest) {
    const node = itemRefs[id]
    if (!node) continue
    const rect = node.getBoundingClientRect()

    if (movingDown) {
      if (rect.top < dragTop + touchEps) continue
      const gap = rect.top - dragBottom
      if (gap <= -touchEps && gap > bestGap) {
        bestGap = gap
        touchTarget = id
      }
      continue
    }

    if (rect.bottom > dragBottom - touchEps) continue
    const gap = dragTop - rect.bottom
    if (gap <= -touchEps && gap > bestGap) {
      bestGap = gap
      touchTarget = id
    }
  }

  return touchTarget
}

export function findInsertIndex<T extends string>(
  rest: T[],
  itemRefs: ItemNodeMap,
  dragTop: number,
  dragHeight: number,
  movingDown: boolean,
): number {
  const dragProbe = dragTop + dragHeight * (movingDown ? 0.82 : 0.22)
  for (let i = 0; i < rest.length; i += 1) {
    const node = itemRefs[rest[i]]
    if (!node) continue
    const rect = node.getBoundingClientRect()
    const midpoint = rect.top + rect.height / 2
    if (dragProbe < midpoint) return i
  }
  return rest.length
}
