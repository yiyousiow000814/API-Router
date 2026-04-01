import { describe, expect, it } from 'vitest'

import { shouldSuppressInvokeError } from './tauriCore'

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
