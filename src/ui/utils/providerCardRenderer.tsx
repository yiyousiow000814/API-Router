import type * as React from 'react'
import type { Config, Status } from '../types'
import { fmtWhen } from './format'

type CreateProviderCardRendererOptions = {
  config: Config | null
  status: Status | null
  baselineBaseUrls: Record<string, string>
  dragOverProvider: string | null
  dragBaseTop: number
  dragOffsetY: number
  isProviderOpen: (name: string) => boolean
  registerProviderCardRef: (name: string) => (el: HTMLDivElement | null) => void
  onProviderHandlePointerDown: (name: string, event: React.PointerEvent<Element>) => void
  editingProviderName: string | null
  providerNameDrafts: Record<string, string>
  setProviderNameDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setEditingProviderName: React.Dispatch<React.SetStateAction<string | null>>
  beginRenameProvider: (name: string) => void
  commitRenameProvider: (name: string) => Promise<void>
  saveProvider: (name: string) => Promise<void>
  setProviderDisabled: (name: string, disabled: boolean) => Promise<void>
  openKeyModal: (provider: string) => Promise<void>
  clearKey: (provider: string) => Promise<void>
  deleteProvider: (provider: string) => Promise<void>
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>
  toggleProviderOpen: (name: string) => void
  openUsageBaseModal: (provider: string, value?: string) => Promise<void>
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
    const quotaHardCap = p.quota_hard_cap ?? { daily: true, weekly: true, monthly: true }
    const quota = options.status?.quota?.[name]
    const budgetHardCapWindows = [
      {
        key: 'daily' as const,
        visible: quota?.kind === 'budget_info' && quota.daily_spent_usd != null && quota.daily_budget_usd != null,
      },
      {
        key: 'weekly' as const,
        visible: quota?.kind === 'budget_info' && quota.weekly_spent_usd != null && quota.weekly_budget_usd != null,
      },
      {
        key: 'monthly' as const,
        visible: quota?.kind === 'budget_info' && quota.monthly_spent_usd != null && quota.monthly_budget_usd != null,
      },
    ].filter((window) => window.visible)
    const budgetHardCapLabel = budgetHardCapWindows.map(({ key }) => key).join('/')
    const allVisibleHardCapsDisabled =
      budgetHardCapWindows.length > 0 && budgetHardCapWindows.every(({ key }) => !quotaHardCap[key])
    const hiddenEnabledHardCapExists =
      budgetHardCapWindows.length > 0 &&
      (['daily', 'weekly', 'monthly'] as const).some(
        (key) => !budgetHardCapWindows.some((window) => window.key === key) && quotaHardCap[key],
      )
    const visibleHardCapWarningText = allVisibleHardCapsDisabled
      ? hiddenEnabledHardCapExists
        ? 'All visible hard caps are disabled. This provider may still auto-close if hidden budget windows appear later.'
        : 'All visible hard caps are disabled, so this provider will not auto-close on budget exhaustion.'
      : null
    const activeProviderCount = Object.values(options.config?.providers ?? {}).filter((provider) => !provider.disabled).length
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
        className={`aoProviderConfigCard${overlay ? ' aoProviderConfigDragging' : ''}${isDragOver && !overlay ? ' aoProviderConfigDragOver' : ''}${!options.isProviderOpen(name) ? ' aoProviderConfigCollapsed' : ''}${p.disabled ? ' aoProviderConfigDisabled' : ''}`}
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
                {p.base_url !== (options.baselineBaseUrls[name] ?? '') ? (
                  <button className="aoActionBtn" title="Save" onClick={() => void options.saveProvider(name)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
                      <path d="M17 21v-8H7v8" />
                      <path d="M7 3v5h8" />
                    </svg>
                    <span>Save</span>
                  </button>
                ) : null}
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
                <button className="aoActionBtn" title="Clear key" onClick={() => void options.clearKey(name)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m7 21-4-4a2 2 0 0 1 0-3l10-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8" />
                    <path d="M6 18h8" />
                  </svg>
                  <span>Clear</span>
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
                    if (nextDisabled && options.isProviderOpen(name)) {
                      options.toggleProviderOpen(name)
                    }
                    void options.setProviderDisabled(name, nextDisabled)
                  }}
                >
                  <span className="aoStatusSwitchThumb" aria-hidden="true" />
                </button>
              </div>
            </div>
            {options.isProviderOpen(name) ? (
              <>
                <div className="aoMiniLabel">Base URL</div>
                <input
                  className="aoInput aoUrlInput"
                  value={p.base_url}
                  onChange={(e) =>
                    options.setConfig((c) =>
                      c
                        ? {
                            ...c,
                            providers: {
                              ...c.providers,
                              [name]: { ...c.providers[name], base_url: e.target.value },
                            },
                          }
                        : c,
                    )
                  }
                />
                <div className="aoMiniLabel">Key</div>
                <div className="aoKeyValue">{p.has_key ? (p.key_preview ? p.key_preview : 'set') : 'empty'}</div>
              </>
            ) : null}
          </div>
          <div className="aoProviderField aoProviderRight">
            <div className="aoUsageControlsHeader">
              <div className="aoMiniLabel">Usage controls</div>
              <button className="aoTinyBtn aoToggleBtn" onClick={() => options.toggleProviderOpen(name)}>
                {options.isProviderOpen(name) ? 'Hide' : 'Show'}
              </button>
            </div>
            {options.isProviderOpen(name) ? (
              <>
                <div className="aoUsageBtns">
                  <button
                    className="aoTinyBtn"
                    onClick={() => void options.openUsageBaseModal(name, p.usage_base_url ?? undefined)}
                  >
                    Usage Base
                  </button>
                  {p.usage_base_url ? (
                    <button className="aoTinyBtn" onClick={() => void options.clearUsageBaseUrl(name)}>
                      Clear
                    </button>
                  ) : null}
                </div>
                {budgetHardCapWindows.length > 0 ? (
                  <div className="aoUsageHardCapGrid">
                    {budgetHardCapWindows.map(({ key: period }) => (
                      <label key={period} className="aoUsageHardCapItem">
                        <input
                          type="checkbox"
                          checked={quotaHardCap[period]}
                          onChange={(event) => void options.setProviderQuotaHardCap(name, period, event.target.checked)}
                        />
                        <span>{period} hard cap</span>
                      </label>
                    ))}
                  </div>
                ) : null}
                <div className="aoHint">Usage base sets the usage endpoint. If empty, we use the provider base URL.</div>
                {budgetHardCapWindows.length > 0 ? (
                  <div className="aoHint">Hard cap controls whether {budgetHardCapLabel} budget exhaustion auto-closes this provider.</div>
                ) : (
                  <div className="aoHint">No budget windows detected for this provider, so hard cap toggles are hidden.</div>
                )}
                {visibleHardCapWarningText ? (
                  <div className="aoHint" style={{ color: 'rgba(145, 12, 43, 0.92)' }}>
                    {visibleHardCapWarningText}
                  </div>
                ) : null}
                <div className="aoHint">
                  updated:{' '}
                  {options.status?.quota?.[name]?.updated_at_unix_ms
                    ? fmtWhen(options.status.quota[name].updated_at_unix_ms)
                    : 'never'}
                </div>
                {options.status?.quota?.[name]?.last_error ? (
                  <div className="aoUsageErr">{options.status.quota[name].last_error}</div>
                ) : null}
              </>
            ) : (
              <div className="aoHint">Details hidden</div>
            )}
          </div>
        </div>
      </div>
    )
  }
}
