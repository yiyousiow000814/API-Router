import { describe, expect, it } from 'vitest'
import { clampDragTopToList } from './useReorderDrag.constraints'

describe('clampDragTopToList', () => {
  it('keeps drag coordinates in list content space when the list is scrolled', () => {
    const listNode = {
      querySelector: () => null,
    } as unknown as HTMLDivElement
    const listRect = {
      top: 100,
    } as DOMRect
    const itemRefs = {
      a: {
        getBoundingClientRect: () => ({ bottom: 180 }),
      },
      b: {
        getBoundingClientRect: () => ({ bottom: 360 }),
      },
    } as unknown as Record<string, HTMLDivElement | null>

    const result = clampDragTopToList({
      listNode,
      listRect,
      scrollTop: 160,
      currentOrder: ['a', 'b', 'dragging'],
      draggingId: 'dragging',
      itemRefs,
      dragTopRaw: 210,
      dragHeight: 56,
    })

    expect(result.dragTopInList).toBe(270)
    expect(result.dragTop).toBe(210)
  })
})
