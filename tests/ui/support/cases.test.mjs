import { describe, expect, it } from 'vitest'
import { selectDirectProviderName } from './cases.mjs'

describe('selectDirectProviderName', () => {
  it('prefers the first non-official provider', () => {
    expect(selectDirectProviderName(['official', 'provider_a', 'provider_b'])).toBe('provider_a')
  })

  it('deduplicates and trims provider names', () => {
    expect(selectDirectProviderName([' official ', 'provider_a', 'provider_a', ''])).toBe('provider_a')
  })

  it('falls back to official when it is the only provider', () => {
    expect(selectDirectProviderName(['official'])).toBe('official')
    expect(selectDirectProviderName([])).toBe('official')
  })
})
