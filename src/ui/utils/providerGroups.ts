import type { Config } from '../types'

type ProviderGroupMaps = {
  displayNameByProvider: Record<string, string>
  membersByProvider: Record<string, string[]>
}

export function normalizeProviderGroupName(value: string | null | undefined): string {
  return String(value ?? '').trim()
}

function orderedProviderNames(config: Config): string[] {
  const providerNames = Object.keys(config.providers ?? {})
  const ordered = (config.provider_order ?? []).filter((name) => providerNames.includes(name))
  const leftovers = providerNames.filter((name) => !ordered.includes(name))
  return [...ordered, ...leftovers]
}

export function buildProviderGroupMaps(config: Config | null): ProviderGroupMaps {
  if (!config) {
    return { displayNameByProvider: {}, membersByProvider: {} }
  }
  const providers = orderedProviderNames(config)
  const providersByGroup = new Map<string, string[]>()
  const displayNameByProvider: Record<string, string> = {}

  for (const provider of providers) {
    const group = normalizeProviderGroupName(config.providers?.[provider]?.group)
    const displayName = group || provider
    displayNameByProvider[provider] = displayName
    if (!group) continue
    const members = providersByGroup.get(group) ?? []
    members.push(provider)
    providersByGroup.set(group, members)
  }

  const membersByProvider: Record<string, string[]> = {}
  for (const provider of providers) {
    const group = normalizeProviderGroupName(config.providers?.[provider]?.group)
    if (!group) {
      membersByProvider[provider] = [provider]
      continue
    }
    membersByProvider[provider] = [...(providersByGroup.get(group) ?? [provider])]
  }

  return {
    displayNameByProvider,
    membersByProvider,
  }
}

export function resolveProviderDisplayName(
  displayNameByProvider: Record<string, string>,
  provider: string,
): string {
  return displayNameByProvider[provider] ?? provider
}
