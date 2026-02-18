import type * as React from 'react'
import { useMemo, useRef } from 'react'
import type { Config, Status } from '../types'

type UseStatusDerivationsOptions = {
  status: Status | null
  config: Config | null
  clearErrorsBeforeMs: number
  setClearErrorsBeforeMs: React.Dispatch<React.SetStateAction<number>>
}

export function useStatusDerivations({
  status,
  config,
  clearErrorsBeforeMs,
  setClearErrorsBeforeMs,
}: UseStatusDerivationsOptions) {
  const providers = useMemo(() => {
    const statusProviders = Object.keys(status?.providers ?? {})
    if (!config) return statusProviders
    const order = config.provider_order ?? []
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const name of order) {
      if (statusProviders.includes(name) && !seen.has(name)) {
        ordered.push(name)
        seen.add(name)
      }
    }
    for (const name of statusProviders) {
      if (!seen.has(name)) ordered.push(name)
    }
    return ordered
  }, [status, config])

  const visibleEvents = useMemo(() => {
    const events = status?.recent_events ?? []
    if (!clearErrorsBeforeMs) return events
    return events.filter((e) => (e.level !== 'error' && e.level !== 'warning') || e.unix_ms > clearErrorsBeforeMs)
  }, [status, clearErrorsBeforeMs])

  const canClearErrors = useMemo(
    () => visibleEvents.some((e) => e.level === 'error' || e.level === 'warning'),
    [visibleEvents],
  )

  const clearErrors = () => {
    const events = status?.recent_events ?? []
    let maxIssueUnixMs = 0
    for (const e of events) {
      if (e.level !== 'error' && e.level !== 'warning') continue
      if (e.unix_ms > maxIssueUnixMs) maxIssueUnixMs = e.unix_ms
    }
    if (!maxIssueUnixMs) return
    setClearErrorsBeforeMs((prev) => Math.max(prev, maxIssueUnixMs))
  }

  const sessionOrderRef = useRef<Record<string, number>>({})
  const sessionOrderNextRef = useRef(1)
  const clientSessions = useMemo(() => {
    const sessions = status?.client_sessions ?? []
    const order = sessionOrderRef.current
    for (const s of sessions) {
      if (order[s.id] == null) {
        order[s.id] = sessionOrderNextRef.current++
      }
    }
    return [...sessions].sort((a, b) => (order[a.id] ?? 0) - (order[b.id] ?? 0))
  }, [status])

  return {
    providers,
    canClearErrors,
    clearErrors,
    clientSessions,
  }
}
