const HALF_HOUR_MS = 30 * 60 * 1000
const MIN_IDLE_LEAD_MS = 60 * 1000
const ACTIVE_BASE_MS = 5 * 60 * 1000

export function computeIdleRefreshDelayMs(nowMs: number, jitterMs: number): number {
  const now = new Date(nowMs)
  const next = new Date(nowMs)
  next.setSeconds(0, 0)
  if (now.getMinutes() < 30) {
    next.setMinutes(30)
  } else {
    next.setMinutes(60)
  }
  let target = next.getTime() + jitterMs
  const minTarget = nowMs + MIN_IDLE_LEAD_MS
  while (target <= minTarget) {
    target += HALF_HOUR_MS
  }
  return target - nowMs
}

export function computeActiveRefreshDelayMs(jitterMs: number): number {
  return ACTIVE_BASE_MS + jitterMs
}
