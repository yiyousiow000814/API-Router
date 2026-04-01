import { invoke } from '@tauri-apps/api/core'

declare global {
  interface Window {
    __API_ROUTER_UI_FREEZE_CAPTURE_READY__?: boolean
    __API_ROUTER_ACTIVE_PAGE__?: string
  }
}

function currentActivePage(): string {
  if (typeof window === 'undefined') {
    return 'unknown'
  }
  return window.__API_ROUTER_ACTIVE_PAGE__ || 'unknown'
}

function currentVisible(): boolean {
  if (typeof document === 'undefined') {
    return true
  }
  return document.visibilityState !== 'hidden'
}

export function initUiFreezeCapture(): void {
  if (typeof window === 'undefined' || window.__API_ROUTER_UI_FREEZE_CAPTURE_READY__) {
    return
  }
  window.__API_ROUTER_UI_FREEZE_CAPTURE_READY__ = true

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const elapsedMs = Math.round(entry.duration)
          if (elapsedMs < 1000) {
            continue
          }
          void invoke('record_ui_long_task', {
            elapsedMs,
            activePage: currentActivePage(),
            visible: currentVisible(),
          }).catch(() => {})
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // Ignore unsupported longtask observers.
    }
  }

  window.addEventListener('error', (event) => {
    const message =
      event.message ||
      event.error?.message ||
      (typeof event.error === 'string' ? event.error : 'unknown error')
    void invoke('record_ui_frontend_error', {
      kind: 'error',
      message,
      activePage: currentActivePage(),
      visible: currentVisible(),
    }).catch(() => {})
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const message =
      typeof reason === 'string'
        ? reason
        : reason?.message || JSON.stringify(reason ?? 'unknown rejection')
    void invoke('record_ui_frontend_error', {
      kind: 'unhandledrejection',
      message,
      activePage: currentActivePage(),
      visible: currentVisible(),
    }).catch(() => {})
  })
}
