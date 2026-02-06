import { useRef } from 'react'

type Props = {
  className?: string
  onClose: () => void
  children: React.ReactNode
}

// Close only when the pointer is pressed AND released on the backdrop itself.
// This avoids accidental closes when users start a drag inside the modal and
// release on the blurred area, or vice versa.
export function ModalBackdrop({ className = 'aoModalBackdrop', onClose, children }: Props) {
  const pressedOnBackdropRef = useRef<boolean>(false)

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

