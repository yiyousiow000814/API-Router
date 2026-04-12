import { createPortal } from 'react-dom'

export type ProviderWsTooltipState = {
  text: string
  left: number
  top: number
} | null

type Props = {
  tooltip: ProviderWsTooltipState
}

export function ProviderWsTooltipPortal({ tooltip }: Props) {
  if (!tooltip) return null

  return createPortal(
    <div
      className="aoProviderWsTooltipPortal"
      role="tooltip"
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.text}
    </div>,
    document.body,
  )
}
