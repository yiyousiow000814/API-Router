import { describe, expect, it } from 'vitest'
import { isPreferredProviderDisabled } from './HeroRoutingCard'

describe('HeroRoutingCard', () => {
  it('disables preferred provider picker in balanced mode', () => {
    expect(isPreferredProviderDisabled('balanced_auto')).toBe(true)
    expect(isPreferredProviderDisabled('follow_preferred_auto')).toBe(false)
  })
})
