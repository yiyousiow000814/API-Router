export function normalizePathForCompare(input: string): string {
  const normalized = input.trim().replace(/[\\/]+/g, '/').toLowerCase()
  if (!normalized || normalized === '/') return normalized
  return normalized.replace(/\/+$/, '')
}
