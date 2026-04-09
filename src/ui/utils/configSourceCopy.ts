export function nextCopiedProviderName(
  providerNames: Iterable<string>,
  baseName: string,
): string {
  const existing = new Set(providerNames)
  const trimmed = baseName.trim()
  const first = trimmed ? `${trimmed} [copy]` : '[copy]'
  if (!existing.has(first)) return first
  let index = 2
  while (true) {
    const candidate = trimmed ? `${trimmed} [copy ${index}]` : `[copy ${index}]`
    if (!existing.has(candidate)) return candidate
    index += 1
  }
}

export function normalizedProviderKey(keyPreview?: string | null): string | null {
  const normalized = keyPreview?.trim() ?? ''
  return normalized ? normalized : null
}

export function deriveLocalCopyState(args: {
  sharedProviderId?: string | null
  providerKey?: string | null
  copiedSharedProviderIds: ReadonlySet<string>
  localSnapshotKeys: ReadonlySet<string>
}): 'copied' | 'linked' | null {
  const { sharedProviderId, providerKey, copiedSharedProviderIds, localSnapshotKeys } = args
  if (sharedProviderId && copiedSharedProviderIds.has(sharedProviderId)) {
    return 'copied'
  }
  const normalizedKey = normalizedProviderKey(providerKey)
  if (normalizedKey && localSnapshotKeys.has(normalizedKey)) {
    return 'linked'
  }
  return null
}
