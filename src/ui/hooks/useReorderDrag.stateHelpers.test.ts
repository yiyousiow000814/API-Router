import { describe, expect, it } from 'vitest'
import { measureDragItemHeight } from './useReorderDrag.stateHelpers'

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
