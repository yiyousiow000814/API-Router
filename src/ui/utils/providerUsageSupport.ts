export function supportsUsageAuthHost(baseUrl?: string | null): boolean {
  const text = `${baseUrl ?? ''}`.trim().toLowerCase()
  return text.includes('codex-for') || text.includes('yfy.zhouyang168.top')
}

export function hidesUsageUrlForHost(baseUrl?: string | null): boolean {
  const text = `${baseUrl ?? ''}`.trim().toLowerCase()
  return text.includes('codex-for')
}
