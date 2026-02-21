import { useMemo, useRef } from 'react'
import type { Config, Status } from '../types'

type UseStatusDerivationsOptions = {
  status: Status | null
  config: Config | null
}

export function useStatusDerivations({
  status,
  config,
}: UseStatusDerivationsOptions) {
  const providers = useMemo(() => {
    const statusProviders = Object.keys(status?.providers ?? {}).filter((name) => !config?.providers?.[name]?.disabled)
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
    clientSessions,
  }
}
