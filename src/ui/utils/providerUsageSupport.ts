import type { Config } from '../types'

export function supportsUsageAuthProvider(provider?: Pick<Config['providers'][string], 'supports_usage_login'> | null): boolean {
  return provider?.supports_usage_login === true
}
