import { describe, expect, it } from 'vitest'

import { shouldSuppressInvokeError, shouldSuppressSlowInvokeSuccess } from './tauriCore'

describe('shouldSuppressInvokeError', () => {
  it('suppresses missing optional WSL home probe failures', () => {
    expect(
      shouldSuppressInvokeError('codex_cli_default_wsl_home', 'missing WSL distro/HOME'),
    ).toBe(true)
  })

  it('does not suppress unrelated invoke failures', () => {
    expect(
      shouldSuppressInvokeError('codex_cli_default_wsl_home', 'unexpected command failure'),
    ).toBe(false)
    expect(
      shouldSuppressInvokeError('provider_switchboard_status', 'missing WSL distro/HOME'),
    ).toBe(false)
  })
})

describe('shouldSuppressSlowInvokeSuccess', () => {
  it('suppresses high-frequency polling commands', () => {
    expect(shouldSuppressSlowInvokeSuccess('get_config')).toBe(true)
    expect(shouldSuppressSlowInvokeSuccess('provider_switchboard_status')).toBe(true)
    expect(shouldSuppressSlowInvokeSuccess('codex_account_refresh')).toBe(true)
  })

  it('keeps regular commands observable', () => {
    expect(shouldSuppressSlowInvokeSuccess('get_status')).toBe(false)
    expect(shouldSuppressSlowInvokeSuccess('get_usage_statistics')).toBe(false)
  })
})
