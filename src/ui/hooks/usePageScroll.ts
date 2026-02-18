import type * as React from 'react'
import { useCallback, useEffect, useRef } from 'react'

export function usePageScroll(options: {
  containerRef: React.RefObject<HTMLDivElement | null>
  mainAreaRef: React.RefObject<HTMLDivElement | null>
  activePage: string
  setActivePage: (next: string) => void
}) {
  const pageScrollTopRef = useRef<Record<string, number>>({})
  const prevPageRef = useRef<string>(options.activePage)

  const getRoot = useCallback(() => options.containerRef.current, [options.containerRef])

  const readCurrentScrollTop = useCallback(() => {
    const root = getRoot()
    if (!root) return 0
    return root.scrollTop ?? 0
  }, [getRoot])

  const applyScrollTop = useCallback(
    (top: number) => {
      const root = getRoot()
      if (root) root.scrollTop = top
      const main = options.mainAreaRef.current
      if (main) main.scrollTop = 0
      if (typeof window !== 'undefined') {
        window.scrollTo({ top, left: 0, behavior: 'auto' })
      }
    },
    [getRoot, options.mainAreaRef],
  )

  const scrollToTop = useCallback(() => {
    pageScrollTopRef.current[options.activePage] = 0
    applyScrollTop(0)
  }, [applyScrollTop, options.activePage])

  const restorePageScroll = useCallback(
    (page: string) => {
      const top = pageScrollTopRef.current[page] ?? 0
      applyScrollTop(top)
    },
    [applyScrollTop],
  )

  const saveCurrentPageScroll = useCallback(
    (page: string) => {
      pageScrollTopRef.current[page] = readCurrentScrollTop()
    },
    [readCurrentScrollTop],
  )

  const scheduleRestore = useCallback(
    (page: string) => {
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          restorePageScroll(page)
        })
      } else {
        restorePageScroll(page)
      }
    },
    [restorePageScroll],
  )

  const switchPage = useCallback(
    (next: string) => {
      const current = prevPageRef.current
      saveCurrentPageScroll(current)
      prevPageRef.current = next
      options.setActivePage(next)
      scheduleRestore(next)
    },
    [options, saveCurrentPageScroll, scheduleRestore],
  )

  useEffect(() => {
    pageScrollTopRef.current[options.activePage] = readCurrentScrollTop()
    prevPageRef.current = options.activePage
  }, [])

  useEffect(() => {
    const prev = prevPageRef.current
    if (prev !== options.activePage) {
      saveCurrentPageScroll(prev)
      prevPageRef.current = options.activePage
      scheduleRestore(options.activePage)
    }
  }, [options.activePage, saveCurrentPageScroll, scheduleRestore])

  useEffect(() => {
    const root = options.containerRef.current
    if (!root) return
    const onScroll = () => {
      pageScrollTopRef.current[options.activePage] = root.scrollTop ?? 0
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [options.activePage, options.containerRef])

  return { switchPage, scrollToTop }
}
