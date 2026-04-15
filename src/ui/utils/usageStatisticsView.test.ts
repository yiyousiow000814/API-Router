import { describe, expect, it } from 'vitest'

import { formatUsageModelDisplayName } from './usageStatisticsView'

describe('formatUsageModelDisplayName', () => {
  it('strips trailing date suffixes from model names', () => {
    expect(formatUsageModelDisplayName('gpt-5.4-mini-2026-03-17')).toBe('gpt-5.4-mini')
  })

  it('keeps model names without a trailing date suffix unchanged', () => {
    expect(formatUsageModelDisplayName('gpt-5.4-mini')).toBe('gpt-5.4-mini')
    expect(formatUsageModelDisplayName('gpt-5.4-mini-preview')).toBe('gpt-5.4-mini-preview')
  })
})
