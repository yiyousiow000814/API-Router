import { invoke } from '@tauri-apps/api/core'

type StartupStage = {
  stage: string
  elapsedMs?: number | null
  detail?: string | null
}

type StartupTraceState = {
  startNow: number
  stages: StartupStage[]
  mark: (stage: string, detail?: string | null) => void
}

declare global {
  interface Window {
    __API_ROUTER_STARTUP_TRACE__?: StartupTraceState
  }
}

function fallbackElapsedMs(): number {
  if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
    return 0
  }
  return Math.round(performance.now())
}

function localTraceState(): StartupTraceState | null {
  if (typeof window === 'undefined') {
    return null
  }
  return window.__API_ROUTER_STARTUP_TRACE__ ?? null
}

function elapsedFromTrace(): number {
  const trace = localTraceState()
  if (!trace || typeof performance === 'undefined' || typeof performance.now !== 'function') {
    return fallbackElapsedMs()
  }
  return Math.round(performance.now() - trace.startNow)
}

export function recordStartupStage(stage: string, detail?: string | null): void {
  const trace = localTraceState()
  const trimmedStage = stage.trim()
  if (!trimmedStage) {
    return
  }
  if (trace) {
    trace.mark(trimmedStage, detail ?? null)
  }
  void invoke('record_app_startup_stage', {
    stage: trimmedStage,
    elapsedMs: elapsedFromTrace(),
    detail: detail ?? null,
  }).catch(() => {})
}

export function flushQueuedStartupStages(): void {
  const trace = localTraceState()
  if (!trace) {
    return
  }
  const pendingStages = [...trace.stages]
  trace.stages.length = 0
  for (const pending of pendingStages) {
    void invoke('record_app_startup_stage', {
      stage: pending.stage,
      elapsedMs: pending.elapsedMs ?? null,
      detail: pending.detail ?? null,
    }).catch(() => {})
  }
}
