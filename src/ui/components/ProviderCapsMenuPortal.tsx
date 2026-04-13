import { createPortal } from 'react-dom'

export type ProviderCapsMenuState = {
  provider: string
  left: number
  top: number
} | null

type HardCapPeriod = 'daily' | 'weekly' | 'monthly'

type Props = {
  menu: ProviderCapsMenuState
  periods: HardCapPeriod[]
  quotaHardCap: Record<HardCapPeriod, boolean>
  editable: boolean
  registerMenuRef: (el: HTMLDivElement | null) => void
  setProviderQuotaHardCap: (
    provider: string,
    field: HardCapPeriod,
    enabled: boolean,
  ) => Promise<void>
}

export function ProviderCapsMenuPortal({
  menu,
  periods,
  quotaHardCap,
  editable,
  registerMenuRef,
  setProviderQuotaHardCap,
}: Props) {
  if (!menu || periods.length === 0) return null

  return createPortal(
    <div
      ref={registerMenuRef}
      className="aoMenu aoProviderCapsPanel"
      role="menu"
      aria-label="Quota hard caps"
      style={{ left: menu.left, top: menu.top }}
    >
      {periods.map((period) => (
        <label key={period} className="aoProviderCapsItem">
          <input
            type="checkbox"
            checked={quotaHardCap[period]}
            disabled={!editable}
            onChange={(event) =>
              void setProviderQuotaHardCap(menu.provider, period, event.target.checked)
            }
          />
          <span>{period} cap</span>
        </label>
      ))}
    </div>,
    document.body,
  )
}
