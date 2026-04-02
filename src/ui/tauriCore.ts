import * as actual from '../../node_modules/@tauri-apps/api/core.js'

export * from '../../node_modules/@tauri-apps/api/core.js'

type PendingUiTrace = {
  kind: string
  active_page: string
  visible: boolean
  fields: Record<string, unknown>
}

type PendingInvokeResult = {
  command: string
  elapsed_ms: number
  ok: boolean
  error_message: string | null
  active_page: string
  visible: boolean
}

const pendingUiTraces: PendingUiTrace[] = []
const pendingInvokeResults: PendingInvokeResult[] = []
let diagnosticsFlushTimer: number | null = null

function scheduleUiDiagnosticsFlush(): void {
  if (typeof window === 'undefined') return
  if (diagnosticsFlushTimer != null) return
  diagnosticsFlushTimer = window.setTimeout(() => {
    diagnosticsFlushTimer = null
    if (!pendingUiTraces.length && !pendingInvokeResults.length) return
    const traces = pendingUiTraces.splice(0, pendingUiTraces.length)
    const invokeResults = pendingInvokeResults.splice(0, pendingInvokeResults.length)
    void actual
      .invoke('record_ui_diagnostics_batch', {
        traces,
        invokeResults,
      })
      .catch(() => {})
  }, 180)
}

function queueUiTrace(entry: PendingUiTrace): void {
  pendingUiTraces.push(entry)
  if (pendingUiTraces.length + pendingInvokeResults.length >= 24) {
    scheduleUiDiagnosticsFlush()
    return
  }
  scheduleUiDiagnosticsFlush()
}

function queueInvokeResult(entry: PendingInvokeResult): void {
  pendingInvokeResults.push(entry)
  if (pendingUiTraces.length + pendingInvokeResults.length >= 24) {
    scheduleUiDiagnosticsFlush()
    return
  }
  scheduleUiDiagnosticsFlush()
}

declare global {
  interface Window {
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

function shouldSkipInvokeDiagnostics(command: string): boolean {
  return (
    command === 'record_app_startup_stage' ||
    command === 'record_ui_watchdog_heartbeat' ||
    command === 'record_ui_trace' ||
    command === 'record_ui_slow_refresh' ||
    command === 'record_ui_long_task' ||
    command === 'record_ui_frame_stall' ||
    command === 'record_ui_frontend_error' ||
    command === 'record_ui_invoke_result' ||
    command === 'record_ui_diagnostics_batch'
  )
}

function diagnosticCommandName(
  command: string,
  args?: actual.InvokeArgs,
): string {
  if (
    command === 'get_usage_statistics' &&
    args &&
    typeof args === 'object' &&
    'detailLevel' in args &&
    (args as Record<string, unknown>).detailLevel === 'overview'
  ) {
    return 'get_usage_statistics_overview'
  }
  if (
    command === 'get_status' &&
    args &&
    typeof args === 'object' &&
    'detailLevel' in args &&
    (args as Record<string, unknown>).detailLevel === 'dashboard'
  ) {
    return 'get_status_dashboard'
  }
  return command
}

export function shouldSuppressSlowInvokeSuccess(command: string): boolean {
  return (
    command === 'codex_account_refresh' ||
    command === 'get_config' ||
    command === 'provider_switchboard_status'
  )
}

export function shouldSuppressInvokeError(command: string, message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase()
  return (
    command === 'codex_cli_default_wsl_home' &&
    normalizedMessage.includes('missing wsl distro/home')
  )
}

export async function invoke<T>(
  cmd: string,
  args?: actual.InvokeArgs,
  options?: actual.InvokeOptions,
): Promise<T> {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const diagnosticsCommand = diagnosticCommandName(cmd, args)
  try {
    const result = await actual.invoke<T>(cmd, args, options)
    const elapsedMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
    )
    if (!shouldSkipInvokeDiagnostics(cmd) && !shouldSuppressSlowInvokeSuccess(cmd)) {
      queueInvokeResult({
        command: diagnosticsCommand,
        elapsed_ms: elapsedMs,
        ok: true,
        error_message: null,
        active_page: currentActivePage(),
        visible: currentVisible(),
      })
    }
    return result
  } catch (error) {
    const elapsedMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
    )
    if (!shouldSkipInvokeDiagnostics(cmd)) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error)
      if (!shouldSuppressInvokeError(cmd, message)) {
        queueInvokeResult({
          command: diagnosticsCommand,
          elapsed_ms: elapsedMs,
          ok: false,
          error_message: message,
          active_page: currentActivePage(),
          visible: currentVisible(),
        })
      }
    }
    throw error
  }
}

export function recordUiTrace(kind: string, fields: Record<string, unknown>): void {
  queueUiTrace({
    kind,
    active_page: currentActivePage(),
    visible: currentVisible(),
    fields,
  })
}
