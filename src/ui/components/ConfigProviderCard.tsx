import type { Config } from '../types'

type Props = {
  name: string
  overlay?: boolean
  provider: Config['providers'][string]
  baselineBaseUrl: string
  isDragOver: boolean
  dragBaseTop: number
  dragOffsetY: number
  isOpen: boolean
  editingProviderName: string | null
  providerNameDraft: string
  quotaUpdatedAtUnixMs?: number
  quotaLastError?: string
  registerProviderCardRef: (providerName: string) => (element: HTMLDivElement | null) => void
  onProviderHandlePointerDown: (providerName: string, event: React.PointerEvent) => void
  onSetProviderNameDraft: (providerName: string, value: string) => void
  onCommitRenameProvider: (providerName: string) => Promise<void>
  onBeginRenameProvider: (providerName: string) => void
  onCancelRenameProvider: (providerName: string) => void
  onSaveProvider: (providerName: string) => Promise<void>
  onOpenKeyModal: (providerName: string) => Promise<void>
  onClearKey: (providerName: string) => Promise<void>
  onDeleteProvider: (providerName: string) => Promise<void>
  onSetProviderBaseUrl: (providerName: string, value: string) => void
  onToggleProviderOpen: (providerName: string) => void
  onOpenUsageBaseModal: (providerName: string, usageBaseUrl?: string | null) => Promise<void>
  onClearUsageBaseUrl: (providerName: string) => Promise<void>
  fmtWhen: (unixMs: number) => string
}

export function ConfigProviderCard({
  name,
  overlay = false,
  provider,
  baselineBaseUrl,
  isDragOver,
  dragBaseTop,
  dragOffsetY,
  isOpen,
  editingProviderName,
  providerNameDraft,
  quotaUpdatedAtUnixMs,
  quotaLastError,
  registerProviderCardRef,
  onProviderHandlePointerDown,
  onSetProviderNameDraft,
  onCommitRenameProvider,
  onBeginRenameProvider,
  onCancelRenameProvider,
  onSaveProvider,
  onOpenKeyModal,
  onClearKey,
  onDeleteProvider,
  onSetProviderBaseUrl,
  onToggleProviderOpen,
  onOpenUsageBaseModal,
  onClearUsageBaseUrl,
  fmtWhen,
}: Props) {
  const dragStyle = overlay
    ? { position: 'absolute' as const, left: 0, right: 0, top: dragBaseTop, transform: `translateY(${dragOffsetY}px)` }
    : undefined

  return (
    <div
      className={`aoProviderConfigCard${overlay ? ' aoProviderConfigDragging' : ''}${isDragOver && !overlay ? ' aoProviderConfigDragOver' : ''}${!isOpen ? ' aoProviderConfigCollapsed' : ''}`}
      key={overlay ? `${name}-drag` : name}
      data-provider={overlay ? undefined : name}
      ref={overlay ? undefined : registerProviderCardRef(name)}
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
                onPointerDown={(event) => onProviderHandlePointerDown(name, event)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h16" />
                  <path d="M4 12h16" />
                  <path d="M4 17h16" />
                </svg>
              </button>
              {editingProviderName === name ? (
                <input
                  className="aoNameInput"
                  value={providerNameDraft}
                  onChange={(event) => onSetProviderNameDraft(name, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void onCommitRenameProvider(name)
                    } else if (event.key === 'Escape') {
                      onCancelRenameProvider(name)
                    }
                  }}
                  onBlur={() => void onCommitRenameProvider(name)}
                  autoFocus
                />
              ) : (
                <>
                  <span className="aoProviderName">{name}</span>
                  <button className="aoIconGhost" title="Rename" aria-label="Rename" onClick={() => onBeginRenameProvider(name)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                    </svg>
                  </button>
                </>
              )}
            </div>
            <div className="aoProviderHeadActions">
              {provider.base_url !== baselineBaseUrl ? (
                <button className="aoActionBtn" title="Save" onClick={() => void onSaveProvider(name)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
                    <path d="M17 21v-8H7v8" />
                    <path d="M7 3v5h8" />
                  </svg>
                  <span>Save</span>
                </button>
              ) : null}
              <button className="aoActionBtn" title="Set key" onClick={() => void onOpenKeyModal(name)}>
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
              <button className="aoActionBtn" title="Clear key" onClick={() => void onClearKey(name)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m7 21-4-4a2 2 0 0 1 0-3l10-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8" />
                  <path d="M6 18h8" />
                </svg>
                <span>Clear</span>
              </button>
              <button className="aoActionBtn aoActionBtnDanger" title="Delete provider" aria-label="Delete provider" onClick={() => void onDeleteProvider(name)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6 18 20H6L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
              </button>
            </div>
          </div>
          {isOpen ? (
            <>
              <div className="aoMiniLabel">Base URL</div>
              <input className="aoInput aoUrlInput" value={provider.base_url} onChange={(event) => onSetProviderBaseUrl(name, event.target.value)} />
              <div className="aoMiniLabel">Key</div>
              <div className="aoKeyValue">{provider.has_key ? provider.key_preview || 'set' : 'empty'}</div>
            </>
          ) : null}
        </div>
        <div className="aoProviderField aoProviderRight">
          <div className="aoUsageControlsHeader">
            <div className="aoMiniLabel">Usage controls</div>
            <button className="aoTinyBtn aoToggleBtn" onClick={() => onToggleProviderOpen(name)}>
              {isOpen ? 'Hide' : 'Show'}
            </button>
          </div>
          {isOpen ? (
            <>
              <div className="aoUsageBtns">
                <button className="aoTinyBtn" onClick={() => void onOpenUsageBaseModal(name, provider.usage_base_url)}>
                  Usage Base
                </button>
                {provider.usage_base_url ? (
                  <button className="aoTinyBtn" onClick={() => void onClearUsageBaseUrl(name)}>
                    Clear
                  </button>
                ) : null}
              </div>
              <div className="aoHint">Usage base sets the usage endpoint. If empty, we use the provider base URL.</div>
              <div className="aoHint">updated: {quotaUpdatedAtUnixMs ? fmtWhen(quotaUpdatedAtUnixMs) : 'never'}</div>
              {quotaLastError ? <div className="aoUsageErr">{quotaLastError}</div> : null}
            </>
          ) : (
            <div className="aoHint">Details hidden</div>
          )}
        </div>
      </div>
    </div>
  )
}
