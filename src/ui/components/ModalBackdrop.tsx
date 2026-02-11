import { useEffect, useRef } from 'react'

type Props = {
  className?: string
  onClose: () => void
  children: React.ReactNode
}

type ScrollLockSnapshot = {
  scrollY: number
  bodyOverflow: string
  bodyPosition: string
  bodyTop: string
  bodyLeft: string
  bodyRight: string
  bodyWidth: string
  bodyPaddingRight: string
  htmlOverflow: string
}

let scrollLockCount = 0
let scrollLockSnapshot: ScrollLockSnapshot | null = null

export function lockBodyScrollForModal(): () => void {
  // SSR / tests can run without a DOM; treat lock as a no-op.
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) {
    return () => {}
  }

  if (scrollLockCount === 0) {
    const bodyStyle = document.body.style
    const htmlStyle = document.documentElement?.style

    scrollLockSnapshot = {
      scrollY: window.scrollY ?? 0,
      bodyOverflow: bodyStyle.overflow || '',
      bodyPosition: bodyStyle.position || '',
      bodyTop: bodyStyle.top || '',
      bodyLeft: bodyStyle.left || '',
      bodyRight: bodyStyle.right || '',
      bodyWidth: bodyStyle.width || '',
      bodyPaddingRight: bodyStyle.paddingRight || '',
      htmlOverflow: htmlStyle?.overflow || '',
    }

    // Compensate for the missing scrollbar so layout doesn't shift when locking.
    const docEl = document.documentElement
    const scrollbarWidth = Math.max(0, (window.innerWidth ?? 0) - (docEl?.clientWidth ?? 0))
    if (scrollbarWidth > 0) {
      bodyStyle.paddingRight = `${scrollbarWidth}px`
    }

    // Lock background scroll without changing the visible scroll position.
    bodyStyle.overflow = 'hidden'
    bodyStyle.position = 'fixed'
    bodyStyle.top = `-${scrollLockSnapshot.scrollY}px`
    bodyStyle.left = '0'
    bodyStyle.right = '0'
    bodyStyle.width = '100%'
    if (htmlStyle) htmlStyle.overflow = 'hidden'
  }

  scrollLockCount += 1

  return () => {
    if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return
    if (scrollLockCount <= 0) return

    scrollLockCount -= 1
    if (scrollLockCount !== 0) return

    const snap = scrollLockSnapshot
    scrollLockSnapshot = null
    if (!snap) return

    const bodyStyle = document.body.style
    const htmlStyle = document.documentElement?.style

    bodyStyle.overflow = snap.bodyOverflow
    bodyStyle.position = snap.bodyPosition
    bodyStyle.top = snap.bodyTop
    bodyStyle.left = snap.bodyLeft
    bodyStyle.right = snap.bodyRight
    bodyStyle.width = snap.bodyWidth
    bodyStyle.paddingRight = snap.bodyPaddingRight
    if (htmlStyle) htmlStyle.overflow = snap.htmlOverflow

    window.scrollTo?.(0, snap.scrollY)
  }
}

// Close only when the pointer is pressed AND released on the backdrop itself.
// This avoids accidental closes when users start a drag inside the modal and
// release on the blurred area, or vice versa.
export function ModalBackdrop({ className = 'aoModalBackdrop', onClose, children }: Props) {
  const pressedOnBackdropRef = useRef<boolean>(false)

  useEffect(() => {
    return lockBodyScrollForModal()
  }, [])

  return (
    <div
      className={className}
      role="dialog"
      aria-modal="true"
      onPointerDown={(e) => {
        pressedOnBackdropRef.current = e.target === e.currentTarget
      }}
      onPointerUp={(e) => {
        const shouldClose = pressedOnBackdropRef.current && e.target === e.currentTarget
        pressedOnBackdropRef.current = false
        if (shouldClose) onClose()
      }}
      onPointerCancel={() => {
        pressedOnBackdropRef.current = false
      }}
    >
      {children}
    </div>
  )
}

