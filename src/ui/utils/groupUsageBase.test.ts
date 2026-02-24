import { describe, expect, it } from 'vitest'
import type { Config } from '../types'
import { resolveGroupUsageBaseAction } from './groupUsageBase'

function buildConfig(overrides: Record<string, string | null | undefined>): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: 'provider_1',
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 2,
      cooldown_seconds: 5,
      request_timeout_seconds: 60,
    },
    providers: Object.fromEntries(
      Object.entries(overrides).map(([name, usageBaseUrl]) => [
        name,
        {
          display_name: name,
          base_url: `https://${name}.example.com/v1`,
          usage_base_url: usageBaseUrl ?? null,
          has_key: false,
        },
      ]),
    ),
  }
}

describe('resolveGroupUsageBaseAction', () => {
  it('returns noop when only one explicit usage base exists and others are empty', () => {
    const config = buildConfig({
      provider_1: 'https://usage.example.com/v1',
      provider_2: '',
    })
    expect(
      resolveGroupUsageBaseAction(config, ['provider_1', 'provider_2'], null),
    ).toEqual({ mode: 'noop', value: null })
  })

  it('returns clear when multiple explicit usage bases differ', () => {
    const config = buildConfig({
      provider_1: 'https://usage-a.example.com/v1',
      provider_2: 'https://usage-b.example.com/v1',
    })
    expect(
      resolveGroupUsageBaseAction(config, ['provider_1', 'provider_2'], null),
    ).toEqual({ mode: 'clear', value: null })
  })
})
