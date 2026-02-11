import { normalizePathForCompare } from './path'

export function resolveCliHomes(dir1: string, dir2: string, applyBoth: boolean): string[] {
  const first = dir1.trim()
  const second = dir2.trim()
  if (!first) return []
  if (!applyBoth || !second) return [first]
  if (normalizePathForCompare(first) === normalizePathForCompare(second)) return [first]
  return [first, second]
}
