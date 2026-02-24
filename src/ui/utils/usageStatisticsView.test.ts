import { describe, expect, it } from 'vitest'
import {
  buildUsageProviderDisplayGroups,
  buildUsageProviderFilterDisplayOptions,
  orderUsageProvidersByConfig,
} from './usageStatisticsView'

function makeRow(provider: string, apiKeyRef: string) {
  return {
    provider,
    api_key_ref: apiKeyRef,
    requests: 1,
    total_tokens: 100,
    estimated_total_cost_usd: 0,
    estimated_cost_request_count: 1,
  }
}

describe('orderUsageProvidersByConfig', () => {
  it('follows ordered providers and appends unknown providers', () => {
    const rows = [
      makeRow('packycode3', 'k3'),
      makeRow('packycode', 'k1'),
      makeRow('packycode2', 'k2'),
      makeRow('other', 'k4'),
    ]

    const ordered = orderUsageProvidersByConfig(rows, ['packycode', 'packycode2', 'packycode3'])

    expect(ordered.map((row) => row.provider)).toEqual([
      'packycode',
      'packycode2',
      'packycode3',
      'other',
    ])
  })

  it('keeps original row order inside the same provider', () => {
    const rows = [
      makeRow('packycode3', 'k3-a'),
      makeRow('packycode3', 'k3-b'),
      makeRow('packycode', 'k1-a'),
      makeRow('packycode', 'k1-b'),
    ]

    const ordered = orderUsageProvidersByConfig(rows, ['packycode', 'packycode3'])

    expect(ordered.map((row) => `${row.provider}:${row.api_key_ref}`)).toEqual([
      'packycode:k1-a',
      'packycode:k1-b',
      'packycode3:k3-a',
      'packycode3:k3-b',
    ])
  })
})

describe('buildUsageProviderDisplayGroups', () => {
  it('merges providers under an explicit group label', () => {
    const rows = [makeRow('provider_a', '-'), makeRow('provider_b', '-')]
    const groups = buildUsageProviderDisplayGroups(
      rows,
      {
        effectiveDailyByRowKey: new Map(),
        effectiveTotalByRowKey: new Map(),
      },
      {
        providerDisplayName: (provider) => provider,
        providerGroupName: (provider) => (provider.startsWith('provider_') ? 'team-alpha' : null),
      },
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].displayName).toBe('team-alpha')
    expect(groups[0].detailLabel).toBe('provider_a / provider_b')
    expect(groups[0].requests).toBe(2)
  })
})

describe('buildUsageProviderFilterDisplayOptions', () => {
  it('keeps case-distinct group names as separate filter options', () => {
    const options = buildUsageProviderFilterDisplayOptions(['provider_a', 'provider_b'], {
      providerGroupName: (provider) => (provider === 'provider_a' ? 'TeamA' : 'teama'),
    })

    expect(options.map((option) => option.label)).toEqual(['TeamA', 'teama'])
    expect(options[0].providers).toEqual(['provider_a'])
    expect(options[1].providers).toEqual(['provider_b'])
  })

  it('does not merge case-distinct provider ids when ungrouped', () => {
    const options = buildUsageProviderFilterDisplayOptions(['ProviderA', 'providera'])
    expect(options).toHaveLength(2)
    expect(new Set(options.map((option) => option.id))).toEqual(new Set(['provider:ProviderA', 'provider:providera']))
    expect(new Set(options.flatMap((option) => option.providers))).toEqual(new Set(['ProviderA', 'providera']))
  })
})
