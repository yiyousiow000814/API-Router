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
  setProviderSupportsWebsockets: (provider: string, enabled: boolean) => Promise<void>
  openKeyModal: (provider: string) => Promise<void>
  clearKey: (provider: string) => Promise<void>
  deleteProvider: (provider: string) => Promise<void>
  copyProviderFromConfigSource: (sourceNodeId: string, sharedProviderId: string) => Promise<void>
  openUsageBaseModal: (provider: string, current: string | null | undefined) => Promise<void>
  openUsageAuthModal: (provider: string) => Promise<void>
  openProviderEmailModal: (provider: string, current: string | null | undefined) => void
  clearUsageBaseUrl: (provider: string) => Promise<void>
  setProviderQuotaHardCap: (
    provider: string,
    field: 'daily' | 'weekly' | 'monthly',
    enabled: boolean,
  ) => Promise<void>
  showProviderWsTooltip: (text: string, anchor: HTMLButtonElement) => void
  hideProviderWsTooltip: () => void
  openProviderCapsMenu: string | null
  toggleProviderCapsMenu: (provider: string, anchor: HTMLButtonElement) => void
}

export function createProviderCardRenderer(options: CreateProviderCardRendererOptions) {
  return (name: string, overlay = false) => {
    const p = options.config?.providers?.[name]
    if (!p) return null

    const supportsUsageUrl = true
    const quotaHardCap = p.quota_hard_cap ?? { daily: true, weekly: true, monthly: true }
    const quota = options.status?.quota?.[name]
    const hasBudgetInfo = isBudgetInfoQuota(quota)
    const hardCapPeriods = getVisibleBudgetHardCapPeriods(quota)
    const groupName = (p.group ?? '').trim()
    const activeProviderCount = Object.values(options.config?.providers ?? {}).filter(
      (provider) => !provider.disabled,
    ).length
    const canDeactivate = p.disabled || activeProviderCount > 1
    const editable = p.editable !== false
    const canCopyBorrowed = Boolean(p.borrowed && p.source_node_id && p.shared_provider_id)
    const capsMenuOpen = options.openProviderCapsMenu === name
    const localCopyState = p.local_copy_state ?? null
    const copyButtonLabel = localCopyState === 'linked' ? 'Linked' : localCopyState === 'copied' ? 'Copied' : 'Copy'
    const copyButtonTitle =
      localCopyState === 'linked'
        ? 'An equivalent local provider already exists'
        : localCopyState === 'copied'
          ? 'Provider already copied to local definitions'
          : 'Copy provider to local definitions'
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
                  disabled={!editable}
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
                      disabled={!editable}
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
                  className={`aoTinyBtn aoProviderWsBtn${p.supports_websockets ? ' is-active' : ''}`}
                  aria-label={p.supports_websockets ? 'Disable WebSocket' : 'Enable WebSocket'}
                  aria-pressed={Boolean(p.supports_websockets)}
                  disabled={!editable}
                  onMouseEnter={(event) =>
                    options.showProviderWsTooltip(
                      p.supports_websockets ? 'Disable WebSocket' : 'Enable WebSocket',
                      event.currentTarget,
                    )
                  }
                  onMouseLeave={() => options.hideProviderWsTooltip()}
                  onFocus={(event) =>
                    options.showProviderWsTooltip(
                      p.supports_websockets ? 'Disable WebSocket' : 'Enable WebSocket',
                      event.currentTarget,
                    )
                  }
                  onBlur={() => options.hideProviderWsTooltip()}
                  onClick={() => void options.setProviderSupportsWebsockets(name, !Boolean(p.supports_websockets))}
                >
                  WS
                </button>
                <button
                  className="aoActionBtn aoProviderHeadBtn"
                  disabled={!editable}
                  onClick={() => options.openProviderBaseUrlModal(name, p.base_url)}
                >
                  <span>Base URL</span>
                </button>
                <button
                  className="aoActionBtn aoProviderHeadBtn"
                  disabled={!editable}
                  onClick={() => void options.openKeyModal(name)}
                >
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
                  className={`aoStatusSwitch aoProviderHeadSwitch ${p.disabled ? 'aoStatusSwitchOff' : 'aoStatusSwitchOn'}`}
                  aria-label={p.disabled ? 'Activate provider' : 'Deactivate provider'}
                  aria-pressed={!p.disabled}
                  aria-disabled={!editable || (!p.disabled && !canDeactivate)}
                  onClick={() => {
                    if (!editable) return
                    const nextDisabled = !Boolean(p.disabled)
                    if (nextDisabled && !canDeactivate) return
                    void options.setProviderDisabled(name, nextDisabled)
                  }}
                  disabled={!editable || (!p.disabled && !canDeactivate)}
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
                  disabled={!editable}
                  onClick={() => options.openProviderEmailModal(name, p.account_email ?? undefined)}
                >
                  Email
                </button>
                <button className="aoTinyBtn" disabled={!editable} onClick={() => options.openProviderGroupManager(name)}>
                  Open Group Manager
                </button>
              </div>
            ) : (
              <div className="aoUsageTop">
                <div className="aoUsageBtns">
                  <button
                    className="aoTinyBtn"
                    disabled={!editable}
                    onClick={() => options.openProviderEmailModal(name, p.account_email ?? undefined)}
                  >
                    Email
                  </button>
                  {supportsUsageUrl ? (
                    <button
                      className="aoTinyBtn"
                      disabled={!editable}
                      onClick={() => void options.openUsageBaseModal(name, p.usage_base_url ?? undefined)}
                    >
                      Usage URL
                    </button>
                  ) : null}
                  {hasBudgetInfo ? (
                    <div className="aoActionsMenuWrap aoProviderCapsMenuWrap">
                      <button
                        type="button"
                        className="aoTinyBtn aoProviderCapsTrigger"
                        aria-haspopup="menu"
                        aria-expanded={capsMenuOpen}
                        onClick={(event) => options.toggleProviderCapsMenu(name, event.currentTarget)}
                      >
                        Caps
                        <span className="aoProviderCapsSummary">
                          {hardCapPeriods.filter((period) => quotaHardCap[period]).length}/{hardCapPeriods.length}
                        </span>
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
          <div className="aoProviderDeleteSlot">
            {canCopyBorrowed ? (
              <button
                className={`aoTinyBtn aoProviderCopyBtn${localCopyState !== null ? ' is-static' : ''}`}
                title={copyButtonTitle}
                aria-label={copyButtonTitle}
                disabled={localCopyState !== null}
                onClick={() => void options.copyProviderFromConfigSource(p.source_node_id!, p.shared_provider_id!)}
              >
                {copyButtonLabel}
              </button>
            ) : (
              <button
                className="aoProviderDeleteBtn"
                title="Delete provider"
                aria-label="Delete provider"
                disabled={!editable}
                onClick={() => void options.deleteProvider(name)}
              >
                <span aria-hidden="true">x</span>
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
