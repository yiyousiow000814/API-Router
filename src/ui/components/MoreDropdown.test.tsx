import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

import { resolveMoreDropdownMenuPosition } from './MoreDropdown'

describe('resolveMoreDropdownMenuPosition', () => {
  it('anchors the menu to the button bottom-right edge', () => {
    expect(resolveMoreDropdownMenuPosition({ bottom: 48, right: 300 }, 1280)).toEqual({
      top: 52,
      right: 980,
    })
  })

  it('keeps the More trigger out of the direct top-nav page button selector', () => {
    const source = fs.readFileSync(new URL('./MoreDropdown.tsx', import.meta.url), 'utf8')

    expect(source).toContain('aoTopNavMenuBtn')
    expect(source).not.toContain('className={`aoTopNavBtn')
  })
})
