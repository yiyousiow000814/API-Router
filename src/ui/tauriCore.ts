import * as actual from '../../node_modules/@tauri-apps/api/core.js'

export * from '../../node_modules/@tauri-apps/api/core.js'

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
    command === 'record_ui_slow_refresh' ||
    command === 'record_ui_long_task' ||
    command === 'record_ui_frontend_error' ||
    command === 'record_ui_invoke_result'
  )
}

export function shouldSuppressSlowInvokeSuccess(command: string): boolean {
  return (
    command === 'codex_account_refresh' ||
    command === 'get_status' ||
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
  try {
    const result = await actual.invoke<T>(cmd, args, options)
    const elapsedMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
    )
    if (!shouldSkipInvokeDiagnostics(cmd) && !shouldSuppressSlowInvokeSuccess(cmd)) {
      void actual
        .invoke('record_ui_invoke_result', {
          command: cmd,
          elapsedMs,
          ok: true,
          errorMessage: null,
          activePage: currentActivePage(),
          visible: currentVisible(),
        })
        .catch(() => {})
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
        void actual
          .invoke('record_ui_invoke_result', {
            command: cmd,
            elapsedMs,
            ok: false,
            errorMessage: message,
            activePage: currentActivePage(),
            visible: currentVisible(),
          })
          .catch(() => {})
      }
    }
    throw error
  }
}
