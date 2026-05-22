import { invoke } from '@tauri-apps/api/core'

declare global {
  interface Window {
    __API_ROUTER_UI_FREEZE_CAPTURE_READY__?: boolean
    __API_ROUTER_ACTIVE_PAGE__?: string
  }
}

const LONG_TASK_THRESHOLD_MS = 1000
const FRAME_STALL_THRESHOLD_MS = 180
const FRAME_STALL_REPORT_COOLDOWN_MS = 10_000
const STARTUP_MONITOR_WINDOW_MS = 10_000
const INTERACTION_MONITOR_WINDOW_MS = 8_000

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

export function shouldReportFrameStall(deltaMs: number, thresholdMs = FRAME_STALL_THRESHOLD_MS): boolean {
  return Number.isFinite(deltaMs) && deltaMs >= thresholdMs
}

export function extendMonitorUntil(currentUntil: number, now: number, windowMs: number): number {
  return Math.max(currentUntil, now + windowMs)
}

export function shouldKeepFrameMonitorActive(
  visible: boolean,
  now: number,
  activeUntil: number,
): boolean {
  return visible && now < activeUntil
}

export function initUiFreezeCapture(): void {
  if (typeof window === 'undefined' || window.__API_ROUTER_UI_FREEZE_CAPTURE_READY__) {
    return
  }
  window.__API_ROUTER_UI_FREEZE_CAPTURE_READY__ = true

  let frameMonitorActiveUntil = performance.now() + STARTUP_MONITOR_WINDOW_MS
  let frameMonitorReason = 'startup'
  let frameMonitorScheduled = false
  let lastFrameTs = 0
  let lastFrameStallReportAt = 0

  const scheduleFrameMonitor = (): void => {
    if (
      frameMonitorScheduled ||
      typeof window.requestAnimationFrame !== 'function' ||
      !shouldKeepFrameMonitorActive(currentVisible(), performance.now(), frameMonitorActiveUntil)
    ) {
      return
    }
    frameMonitorScheduled = true
    lastFrameTs = 0

    const tick = (ts: number) => {
      const now = performance.now()
      if (!shouldKeepFrameMonitorActive(currentVisible(), now, frameMonitorActiveUntil)) {
        frameMonitorScheduled = false
        lastFrameTs = 0
        return
      }

      if (lastFrameTs > 0) {
        const deltaMs = Math.round(ts - lastFrameTs)
        if (
          shouldReportFrameStall(deltaMs) &&
          now - lastFrameStallReportAt >= FRAME_STALL_REPORT_COOLDOWN_MS
        ) {
          lastFrameStallReportAt = now
          void invoke('record_ui_frame_stall', {
            elapsedMs: deltaMs,
            monitorKind: frameMonitorReason,
            activePage: currentActivePage(),
            visible: currentVisible(),
          }).catch(() => {})
        }
      }

      lastFrameTs = ts
      window.requestAnimationFrame(tick)
    }

    window.requestAnimationFrame(tick)
  }

  const activateFrameMonitor = (reason: string, windowMs: number): void => {
    const now = performance.now()
    frameMonitorActiveUntil = extendMonitorUntil(frameMonitorActiveUntil, now, windowMs)
    frameMonitorReason = reason
    scheduleFrameMonitor()
  }

  activateFrameMonitor('startup', STARTUP_MONITOR_WINDOW_MS)

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const elapsedMs = Math.round(entry.duration)
          if (elapsedMs < LONG_TASK_THRESHOLD_MS) {
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

  const onInteraction = () => {
    activateFrameMonitor('interaction', INTERACTION_MONITOR_WINDOW_MS)
  }

  window.addEventListener('pointerdown', onInteraction, { passive: true })
  window.addEventListener('keydown', onInteraction, { passive: true })
  window.addEventListener('wheel', onInteraction, { passive: true })
  window.addEventListener('touchstart', onInteraction, { passive: true })
  document.addEventListener('visibilitychange', () => {
    if (currentVisible()) {
      scheduleFrameMonitor()
    }
  })

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
