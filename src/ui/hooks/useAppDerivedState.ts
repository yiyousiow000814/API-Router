import { useMemo, useRef } from 'react'

import type { CodexSwapStatus, Config, ProviderSwitchboardStatus, Status } from '../types'

type Args = {
  status: Status | null
  config: Config | null
  clearErrorsBeforeMs: number
  codexSwapStatus: CodexSwapStatus | null
  providerSwitchStatus: ProviderSwitchboardStatus | null
}

export function useAppDerivedState({
  status,
  config,
  clearErrorsBeforeMs,
  codexSwapStatus,
  providerSwitchStatus,
}: Args) {
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
  }, [config, status])

  const visibleEvents = useMemo(() => {
    const events = status?.recent_events ?? []
    if (!clearErrorsBeforeMs) return events
    return events.filter((event) => event.level !== 'error' || event.unix_ms > clearErrorsBeforeMs)
  }, [clearErrorsBeforeMs, status])

  const canClearErrors = useMemo(() => visibleEvents.some((event) => event.level === 'error'), [visibleEvents])

  const sessionOrderRef = useRef<Record<string, number>>({})
  const sessionOrderNextRef = useRef(1)
  const clientSessions = useMemo(() => {
    const sessions = status?.client_sessions ?? []
    const order = sessionOrderRef.current
    for (const session of sessions) {
      if (order[session.id] == null) {
        order[session.id] = sessionOrderNextRef.current++
      }
    }
    return [...sessions].sort((a, b) => {
      return (order[a.id] ?? 0) - (order[b.id] ?? 0)
    })
  }, [status])

  const orderedConfigProviders = useMemo(() => {
    if (!config) return []
    const names = Object.keys(config.providers ?? {})
    const order = config.provider_order ?? []
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const name of order) {
      if (names.includes(name) && !seen.has(name)) {
        ordered.push(name)
        seen.add(name)
      }
    }
    for (const name of names) {
      if (!seen.has(name)) ordered.push(name)
    }
    return ordered
  }, [config])

  const nextProviderPlaceholder = useMemo(() => {
    const keys = Object.keys(config?.providers ?? {})
    let maxN = 0
    for (const key of keys) {
      const match = /^provider_(\d+)$/.exec(key)
      if (!match) continue
      const n = Number(match[1])
      if (Number.isFinite(n) && n > maxN) maxN = n
    }
    return `provider_${maxN > 0 ? maxN + 1 : 1}`
  }, [config])

  const codexSwapBadge = useMemo(() => {
    if (!codexSwapStatus && !providerSwitchStatus) {
      return { badgeText: '', badgeTitle: 'Codex CLI swap status: loading' }
    }
    const mode = providerSwitchStatus?.mode
    const switchboardLabel =
      mode === 'provider'
        ? 'DP' + (providerSwitchStatus?.model_provider ? ':' + providerSwitchStatus.model_provider : '')
        : mode === 'official'
          ? 'Auth'
          : mode === 'gateway'
            ? 'API'
            : mode === 'mixed'
              ? 'Mixed'
              : null
    const overall = codexSwapStatus?.overall
    const swapFallbackLabel =
      overall === 'swapped'
        ? 'Auth'
        : overall === 'original'
          ? 'API'
          : overall === 'mixed'
            ? 'Mixed'
            : overall === 'error'
              ? 'Error'
              : 'Loading'
    const badgeText = switchboardLabel ?? swapFallbackLabel
    const parts =
      providerSwitchStatus?.dirs?.length
        ? providerSwitchStatus.dirs.map((dir) => {
            const modeText = dir.mode === 'provider' ? 'provider:' + (dir.model_provider ?? '-') : dir.mode
            return dir.cli_home + ': ' + modeText
          })
        : codexSwapStatus?.dirs?.length
          ? codexSwapStatus.dirs.map((dir) => dir.cli_home + ': ' + dir.state)
          : []
    const badgeTitle = parts.length
      ? 'Codex CLI swap status: ' + badgeText + '. ' + parts.join(' | ')
      : 'Codex CLI swap status: ' + badgeText
    return { badgeText, badgeTitle }
  }, [codexSwapStatus, providerSwitchStatus])

  return {
    providers,
    visibleEvents,
    canClearErrors,
    clientSessions,
    orderedConfigProviders,
    nextProviderPlaceholder,
    codexSwapBadge,
  }
}
