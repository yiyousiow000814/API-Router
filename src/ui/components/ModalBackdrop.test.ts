import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetModalBackdropScrollLockForTests, lockBodyScrollForModal } from './ModalBackdrop'

function setupDom(scrollY: number) {
  const prevWindow = (globalThis as any).window
  const prevDocument = (globalThis as any).document
  const scrollTo = vi.fn()
  const bodyStyle: Record<string, string> = {}
  const htmlStyle: Record<string, string> = {}
  const rootStyle: Record<string, string> = {}
  const root = { style: rootStyle, scrollTop: 456 }

  ;(globalThis as any).window = {
    scrollY,
    innerWidth: 1000,
    scrollTo,
  }
  ;(globalThis as any).document = {
    body: { style: bodyStyle },
    documentElement: { clientWidth: 980, style: htmlStyle },
    querySelector: (sel: string) => {
      if (sel === '.aoRoot') return root
      return null
    },
  }

  return { prevWindow, prevDocument, scrollTo, bodyStyle, htmlStyle, rootStyle, root }
}

describe('lockBodyScrollForModal', () => {
  let prevWindow: any
  let prevDocument: any

  beforeEach(() => {
    __resetModalBackdropScrollLockForTests()
  })

  afterEach(() => {
    if (prevWindow !== undefined) (globalThis as any).window = prevWindow
    if (prevDocument !== undefined) (globalThis as any).document = prevDocument
    prevWindow = undefined
    prevDocument = undefined
  })

  it('locks scroll and restores on unlock', () => {
    const setup = setupDom(123)
    prevWindow = setup.prevWindow
    prevDocument = setup.prevDocument
    const { scrollTo, bodyStyle, htmlStyle, rootStyle, root } = setup

    const unlock = lockBodyScrollForModal()
    expect(bodyStyle.position).toBe('fixed')
    expect(bodyStyle.top).toBe('-123px')
    expect(bodyStyle.overflow).toBe('hidden')
    expect(bodyStyle.paddingRight).toBe('20px')
    expect(htmlStyle.overflow).toBe('hidden')
    expect(rootStyle.overflowY).toBe('hidden')
    expect(rootStyle.overflowX).toBe('hidden')

    unlock()
    expect(bodyStyle.position || '').toBe('')
    expect(bodyStyle.top || '').toBe('')
    expect(bodyStyle.overflow || '').toBe('')
    expect(bodyStyle.paddingRight || '').toBe('')
    expect(htmlStyle.overflow || '').toBe('')
    expect(rootStyle.overflowY || '').toBe('')
    expect(rootStyle.overflowX || '').toBe('')
    expect(root.scrollTop).toBe(456)
    expect(scrollTo).toHaveBeenCalledWith(0, 123)
  })

  it('ref-counts nested locks', () => {
    const setup = setupDom(50)
    prevWindow = setup.prevWindow
    prevDocument = setup.prevDocument
    const { bodyStyle } = setup

    const unlock1 = lockBodyScrollForModal()
    const unlock2 = lockBodyScrollForModal()
    expect(bodyStyle.position).toBe('fixed')

    unlock1()
    expect(bodyStyle.position).toBe('fixed')

    unlock2()
    expect(bodyStyle.position || '').toBe('')
  })
})

