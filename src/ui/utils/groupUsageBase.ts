import type { Config } from '../types'

export const SHARED_PPCHAT_USAGE_BASE = 'https://his.ppchat.vip'
export const SHARED_PACKYCODE_USAGE_BASE = 'https://codex.packycode.com'

export type GroupUsageBaseAction = { mode: 'set' | 'clear' | 'noop'; value: string | null }

export function inferGroupUsageBase(config: Config | null, providers: string[]): string | null {
  if (!config || providers.length === 0) return null
  const parsed = providers
    .map((name) => config.providers?.[name]?.base_url?.trim() ?? '')
    .map((baseUrl) => {
      try {
        return baseUrl ? new URL(baseUrl) : null
      } catch {
        return null
      }
    })
  if (parsed.some((item) => !item)) return null

  const urls = parsed as URL[]
  const hosts = urls.map((u) => u.hostname.toLowerCase())
  const isPackycode = (host: string): boolean => host.endsWith('packycode.com')
  const isPpchat = (host: string): boolean => host.endsWith('ppchat.vip')
  const isPumpkin = (host: string): boolean => host.endsWith('pumpkinai.vip')

  if (hosts.every((host) => isPpchat(host) || isPumpkin(host))) {
    return SHARED_PPCHAT_USAGE_BASE
  }

  if (hosts.every((host) => isPackycode(host))) {
    return SHARED_PACKYCODE_USAGE_BASE
  }

  return null
}

export function resolveGroupUsageBaseAction(
  config: Config | null,
  providers: string[],
  inferredUsageBase: string | null,
): GroupUsageBaseAction {
  if (inferredUsageBase) {
    return { mode: 'set', value: inferredUsageBase }
  }
  if (!config || providers.length === 0) {
    return { mode: 'noop', value: null }
  }
  const explicitUsageBases = providers
    .map((name) => (config.providers?.[name]?.usage_base_url ?? '').trim())
    .filter((value) => value.length > 0)
  const uniqueExplicit = new Set(explicitUsageBases)
  if (uniqueExplicit.size <= 1) {
    return { mode: 'noop', value: null }
  }
  // Mixed explicit usage bases are ambiguous at group-level; clear them so the group
  // can be configured from a single canonical usage base.
  return { mode: 'clear', value: null }
}
