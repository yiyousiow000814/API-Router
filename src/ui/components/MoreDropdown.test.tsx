import { describe, expect, it } from 'vitest'

import { resolveMoreDropdownMenuPosition } from './MoreDropdown'

describe('resolveMoreDropdownMenuPosition', () => {
  it('anchors the menu to the button bottom-right edge', () => {
    expect(resolveMoreDropdownMenuPosition({ bottom: 48, right: 300 }, 1280)).toEqual({
      top: 52,
      right: 980,
    })
  })
})
