import { describe, expect, it } from 'vitest'
import { computeDragStartTopInList, measureDragItemHeight } from './useReorderDrag.stateHelpers'

describe('measureDragItemHeight', () => {
  it('uses the largest available DOM height signal', () => {
    const node = {
      getBoundingClientRect: () => ({ height: 64 }),
      offsetHeight: 60,
      clientHeight: 58,
      scrollHeight: 62,
    } as unknown as HTMLDivElement

    expect(measureDragItemHeight(node)).toBe(64)
  })

  it('falls back to a compact placeholder height when all signals collapse to zero', () => {
    const node = {
      getBoundingClientRect: () => ({ height: 0 }),
      offsetHeight: 0,
      clientHeight: 0,
      scrollHeight: 0,
    } as unknown as HTMLDivElement

    expect(measureDragItemHeight(node)).toBe(56)
  })
})

describe('computeDragStartTopInList', () => {
  it('includes scroll offset so dragged overlays stay aligned inside scrolled lists', () => {
    expect(computeDragStartTopInList(280, 100, 160)).toBe(340)
  })

  it('falls back to zero when rect inputs are missing', () => {
    expect(computeDragStartTopInList(undefined, 100, 50)).toBe(0)
    expect(computeDragStartTopInList(280, undefined, 50)).toBe(0)
  })
})
