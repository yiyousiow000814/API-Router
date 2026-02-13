import type * as React from 'react'
import { useCallback, useEffect } from 'react'

export function usePageScroll(options: {
  containerRef: React.RefObject<HTMLDivElement | null>
  mainAreaRef: React.RefObject<HTMLDivElement | null>
  activePage: string
  setActivePage: (next: string) => void
}) {
  const scrollToTop = useCallback(() => {
    const root = options.containerRef.current
    if (root) root.scrollTop = 0
    const main = options.mainAreaRef.current
    if (main) main.scrollTop = 0
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    }
  }, [options.containerRef, options.mainAreaRef])

  const switchPage = useCallback(
    (next: string) => {
      options.setActivePage(next)
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          scrollToTop()
        })
      }
    },
    [options, scrollToTop],
  )

  useEffect(() => {
    scrollToTop()
  }, [scrollToTop])

  useEffect(() => {
    scrollToTop()
  }, [options.activePage, scrollToTop])

  return { switchPage, scrollToTop }
}
