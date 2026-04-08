import { describe, expect, it } from 'vitest'

import { fmtPricingSource } from './usageDisplay'

describe('fmtPricingSource', () => {
  it('treats missing pricing source as monthly credit', () => {
    expect(fmtPricingSource()).toBe('monthly credit')
    expect(fmtPricingSource(null)).toBe('monthly credit')
    expect(fmtPricingSource('none')).toBe('monthly credit')
  })
})
