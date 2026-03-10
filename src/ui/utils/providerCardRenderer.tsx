import type * as React from 'react'
import type { Config, Status } from '../types'
import {
  getVisibleBudgetHardCapPeriods,
  isBudgetInfoQuota,
} from './providerBudgetWindows'

type CreateProviderCardRendererOptions = {
  config: Config | null
  status: Status | null
  dragOverProvider: string | null
  dragBaseTop: number
  dragOffsetY: number
  registerProviderCardRef: (name: string) => (el: HTMLDivElement | null) => void
  onProviderHandlePointerDown: (name: string, event: React.PointerEvent<Element>) => void
  editingProviderName: string | null
  providerNameDrafts: Record<string, string>
  setProviderNameDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setEditingProviderName: React.Dispatch<React.SetStateAction<string | null>>
  beginRenameProvider: (name: string) => void
  commitRenameProvider: (name: string) => Promise<void>
  setProviderDisabled: (name: string, disabled: boolean) => Promise<void>
  openProviderGroupManager: (provider: string) => void
  openProviderBaseUrlModal: (provider: string, current: string) => void
  openKeyModal: (provider: string) => Promise<void>
  clearKey: (provider: string) => Promise<void>
  deleteProvider: (provider: string) => Promise<void>
  openUsageBaseModal: (provider: string, current: string | null | undefined) => Promise<void>
  openUsageAuthModal: (provider: string) => Promise<void>
  openProviderEmailModal: (provider: string, current: string | null | undefined) => void
  clearUsageBaseUrl: (provider: string) => Promise<void>
  setProviderQuotaHardCap: (
    provider: string,
    field: 'daily' | 'weekly' | 'monthly',
    enabled: boolean,
  ) => Promise<void>
}

export function createProviderCardRenderer(options: CreateProviderCardRendererOptions) {
  return (name: string, overlay = false) => {
    const p = options.config?.providers?.[name]
    if (!p) return null

    const normalizedBaseUrl = (p.base_url ?? '').toLowerCase()
    const supportsUsageAuth = normalizedBaseUrl.includes('codex-for')
    const supportsUsageUrl = !supportsUsageAuth
    const quotaHardCap = p.quota_hard_cap ?? { daily: true, weekly: true, monthly: true }
    const quota = options.status?.quota?.[name]
    const hasBudgetInfo = isBudgetInfoQuota(quota)
    const hardCapPeriods = getVisibleBudgetHardCapPeriods(quota)
    const groupName = (p.group ?? '').trim()
    const activeProviderCount = Object.values(options.config?.providers ?? {}).filter(
      (provider) => !provider.disabled,
    ).length
    const canDeactivate = p.disabled || activeProviderCount > 1
    const isDragOver = options.dragOverProvider === name
    const dragStyle = overlay
      ? {
          position: 'absolute' as const,
          left: 0,
          right: 0,
          top: options.dragBaseTop,
          transform: `translateY(${options.dragOffsetY}px)`,
        }
      : undefined

    return (
      <div
        className={`aoProviderConfigCard${overlay ? ' aoProviderConfigDragging' : ''}${isDragOver && !overlay ? ' aoProviderConfigDragOver' : ''}${p.disabled ? ' aoProviderConfigDisabled' : ''}`}
        key={overlay ? `${name}-drag` : name}
        data-provider={overlay ? undefined : name}
        ref={overlay ? undefined : options.registerProviderCardRef(name)}
        style={dragStyle}
      >
        <div className="aoProviderConfigBody">
          <div className="aoProviderField aoProviderLeft">
            <div className="aoProviderHeadRow">
              <div className="aoProviderNameRow">
                <button
                  className="aoDragHandle"
                  title="Drag to reorder"
                  aria-label="Drag to reorder"
                  type="button"
                  draggable={false}
                  onPointerDown={(e) => options.onProviderHandlePointerDown(name, e)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h16" />
                    <path d="M4 12h16" />
                    <path d="M4 17h16" />
                  </svg>
                </button>
                {options.editingProviderName === name ? (
                  <input
                    className="aoNameInput"
                    value={options.providerNameDrafts[name] ?? name}
                    onChange={(e) =>
                      options.setProviderNameDrafts((prev) => ({
                        ...prev,
                        [name]: e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void options.commitRenameProvider(name)
                      } else if (e.key === 'Escape') {
                        options.setEditingProviderName(null)
                        options.setProviderNameDrafts((prev) => ({ ...prev, [name]: name }))
                      }
                    }}
                    onBlur={() => void options.commitRenameProvider(name)}
                    autoFocus
                  />
                ) : (
                  <>
                    {groupName ? <span className="aoProviderGroupTag">{groupName}</span> : null}
                    <span className="aoProviderName">{name}</span>
                    <button
                      className="aoIconGhost"
                      title="Rename"
                      aria-label="Rename"
                      onClick={() => options.beginRenameProvider(name)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
              <div className="aoProviderHeadActions">
                <button
                  className="aoActionBtn"
                  title="Set base URL"
                  onClick={() => options.openProviderBaseUrlModal(name, p.base_url)}
                >
                  <span>Base URL</span>
                </button>
                <button className="aoActionBtn" title="Set key" onClick={() => void options.openKeyModal(name)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <g transform="rotate(-28 12 12)">
                      <circle cx="7.2" cy="12" r="3.2" />
                      <circle cx="7.2" cy="12" r="1.15" />
                      <path d="M10.8 12H21" />
                      <path d="M17.2 12v2.4" />
                      <path d="M19.2 12v3.4" />
                    </g>
                  </svg>
                  <span>Key</span>
                </button>
                <button
                  className="aoActionBtn aoActionBtnDanger"
                  title="Delete provider"
                  aria-label="Delete provider"
                  onClick={() => void options.deleteProvider(name)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="M19 6 18 20H6L5 6" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                  </svg>
                </button>
                <button
                  className={`aoStatusSwitch ${p.disabled ? 'aoStatusSwitchOff' : 'aoStatusSwitchOn'}`}
                  title={
                    p.disabled
                      ? 'Click to activate provider'
                      : canDeactivate
                        ? 'Click to deactivate provider'
                        : 'At least one provider must stay active'
                  }
                  aria-label={p.disabled ? 'Activate provider' : 'Deactivate provider'}
                  aria-pressed={!p.disabled}
                  disabled={!p.disabled && !canDeactivate}
                  onClick={() => {
                    const nextDisabled = !Boolean(p.disabled)
                    if (nextDisabled && !canDeactivate) return
                    void options.setProviderDisabled(name, nextDisabled)
                  }}
                >
                  <span className="aoStatusSwitchThumb" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          <div className="aoProviderField aoProviderRight">
            {groupName ? (
              <div className="aoUsageBtns">
                <button
                  className="aoTinyBtn"
                  onClick={() => options.openProviderEmailModal(name, p.account_email ?? undefined)}
                >
                  Email
                </button>
                <button className="aoTinyBtn" onClick={() => options.openProviderGroupManager(name)}>
                  Open Group Manager
                </button>
              </div>
            ) : (
              <div className="aoUsageTop">
                <div className="aoUsageBtns">
                  <button
                    className="aoTinyBtn"
                    onClick={() => options.openProviderEmailModal(name, p.account_email ?? undefined)}
                  >
                    Email
                  </button>
                  {supportsUsageAuth ? (
                    <button className="aoTinyBtn" onClick={() => void options.openUsageAuthModal(name)}>
                      Usage Auth
                    </button>
                  ) : null}
                  {supportsUsageUrl ? (
                    <button
                      className="aoTinyBtn"
                      onClick={() => void options.openUsageBaseModal(name, p.usage_base_url ?? undefined)}
                    >
                      Usage URL
                    </button>
                  ) : null}
                </div>
                {hasBudgetInfo ? (
                  <div className="aoUsageHardCapInline">
                    {hardCapPeriods.map((period) => (
                      <label key={period} className="aoUsageHardCapItem">
                        <input
                          type="checkbox"
                          checked={quotaHardCap[period]}
                          onChange={(event) =>
                            void options.setProviderQuotaHardCap(name, period, event.target.checked)
                          }
                        />
                        <span>{period} cap</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }
}
