export function normalizeCodexPath(v: string): string {
  const normalized = v.trim().replace(/\//g, '\\')
  return normalized.replace(/\\+$/g, '')
}

export function isWslCodexPrefix(v: string): boolean {
  const lower = normalizeCodexPath(v).toLowerCase()
  return lower.startsWith('\\\\wsl.localhost\\') || lower.startsWith('\\\\wsl$\\')
}

export function isValidWindowsCodexPath(v: string): boolean {
  const n = normalizeCodexPath(v)
  return /^[a-zA-Z]:\\/.test(n) && !isWslCodexPrefix(n) && n.toLowerCase().endsWith('\\.codex')
}

export function isValidWslCodexPath(v: string): boolean {
  const n = normalizeCodexPath(v)
  return isWslCodexPrefix(n) && n.toLowerCase().endsWith('\\.codex')
}
