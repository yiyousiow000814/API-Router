import type { Config } from '../types'

type ConfigSource = NonNullable<Config['config_source']>['sources'][number]

export type RemoteUpdatePendingStage = {
  stage: 'requesting' | 'refreshing'
  detail: string
  startedAtUnixMs: number
}

export function remoteUpdateStatusObservedAtUnixMs(source: ConfigSource): number {
  const status = source.remote_update_status
  if (!status) return 0
  return Math.max(
    status.finished_at_unix_ms ?? 0,
    status.started_at_unix_ms ?? 0,
    status.updated_at_unix_ms ?? 0,
    status.accepted_at_unix_ms ?? 0,
  )
}

export function isRemoteUpdateStatusCurrentForPending(
  source: ConfigSource,
  pendingStage: RemoteUpdatePendingStage | undefined,
): boolean {
  if (!pendingStage) return true
  const observedAtUnixMs = remoteUpdateStatusObservedAtUnixMs(source)
  if (!observedAtUnixMs) return false
  return observedAtUnixMs >= pendingStage.startedAtUnixMs
}
