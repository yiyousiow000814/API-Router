export type HotkeyEventLike = {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  defaultPrevented?: boolean
}

export function isSaveHotkey(e: HotkeyEventLike): boolean {
  if (e.defaultPrevented) return false
  if (e.altKey) return false
  if (e.shiftKey) return false
  if (!(e.ctrlKey || e.metaKey)) return false
  if (e.code === 'KeyS') return true
  return e.key.toLowerCase() === 's'
}

export function resolvePreferredTarget<T extends string>(
  orderedTargets: T[],
  focusedTarget: T | null,
  canUseTarget: (target: T) => boolean,
): T | null {
  if (focusedTarget) {
    return canUseTarget(focusedTarget) ? focusedTarget : null
  }
  return orderedTargets.find((target) => canUseTarget(target)) ?? null
}
