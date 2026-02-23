import { describe, expect, it } from 'vitest'
import { orderUsageProvidersByConfig } from './usageStatisticsView'

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
