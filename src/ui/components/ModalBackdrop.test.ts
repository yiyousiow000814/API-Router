import { describe, expect, it, vi } from 'vitest'

import { lockBodyScrollForModal } from './ModalBackdrop'

function setupDom(scrollY: number) {
  const scrollTo = vi.fn()
  const bodyStyle: Record<string, string> = {}
  const htmlStyle: Record<string, string> = {}

  ;(globalThis as any).window = {
    scrollY,
    innerWidth: 1000,
    scrollTo,
  }
  ;(globalThis as any).document = {
    body: { style: bodyStyle },
    documentElement: { clientWidth: 980, style: htmlStyle },
  }

  return { scrollTo, bodyStyle, htmlStyle }
}

describe('lockBodyScrollForModal', () => {
  it('locks scroll and restores on unlock', () => {
    const { scrollTo, bodyStyle, htmlStyle } = setupDom(123)

    const unlock = lockBodyScrollForModal()
    expect(bodyStyle.position).toBe('fixed')
    expect(bodyStyle.top).toBe('-123px')
    expect(bodyStyle.overflow).toBe('hidden')
    expect(bodyStyle.paddingRight).toBe('20px')
    expect(htmlStyle.overflow).toBe('hidden')

    unlock()
    expect(bodyStyle.position || '').toBe('')
    expect(bodyStyle.top || '').toBe('')
    expect(bodyStyle.overflow || '').toBe('')
    expect(bodyStyle.paddingRight || '').toBe('')
    expect(htmlStyle.overflow || '').toBe('')
    expect(scrollTo).toHaveBeenCalledWith(0, 123)
  })

  it('ref-counts nested locks', () => {
    const { bodyStyle } = setupDom(50)

    const unlock1 = lockBodyScrollForModal()
    const unlock2 = lockBodyScrollForModal()
    expect(bodyStyle.position).toBe('fixed')

    unlock1()
    expect(bodyStyle.position).toBe('fixed')

    unlock2()
    expect(bodyStyle.position || '').toBe('')
  })
})

