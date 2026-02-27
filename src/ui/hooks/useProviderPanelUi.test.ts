import { describe, expect, it } from 'vitest'
import * as useProviderPanelUiModule from './useProviderPanelUi'

describe('useProviderPanelUi exports', () => {
  it('keeps only the canonical hook export for hard-cap behavior', () => {
    expect(typeof useProviderPanelUiModule.useProviderPanelUi).toBe('function')
  })

  it('does not expose legacy auto-disable helpers', () => {
    expect('findMissingBudgetHardCapToggleToDisable' in useProviderPanelUiModule).toBe(false)
    expect('canStartMissingHardCapAutoDisable' in useProviderPanelUiModule).toBe(false)
    expect('canAutoDisableMissingHardCap' in useProviderPanelUiModule).toBe(false)
    expect('markMissingHardCapAutoDisableAttempt' in useProviderPanelUiModule).toBe(false)
    expect('toMissingHardCapRetryKey' in useProviderPanelUiModule).toBe(false)
  })
})
