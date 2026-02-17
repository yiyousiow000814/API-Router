import { describe, expect, it, vi } from 'vitest'
import {
  mergeProviderSwitchDirs,
  runGatewaySwitchPreflight,
} from './useSwitchboardStatusActions'

describe('mergeProviderSwitchDirs', () => {
  it('drops stale rows on full refresh', () => {
    const prevDirs = [
      { cli_home: 'C:\\Users\\a\\.codex', mode: 'gateway', model_provider: null },
      { cli_home: '\\\\wsl.localhost\\Ubuntu\\home\\a\\.codex', mode: 'gateway', model_provider: null },
    ]
    const nextDirs = [
      { cli_home: 'C:\\Users\\a\\.codex', mode: 'provider', model_provider: 'packycode' },
    ]

    const merged = mergeProviderSwitchDirs(prevDirs, nextDirs)
    expect(merged).toEqual(nextDirs)
  })
})

describe('runGatewaySwitchPreflight', () => {
  it('blocks gateway switch when wsl authorization is declined', async () => {
    const invokeFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, authorized: false, legacy_conflict: false })
    const confirmFn = vi.fn().mockReturnValue(false)
    const flashToast = vi.fn()

    const ok = await runGatewaySwitchPreflight(
      'gateway',
      ['\\\\wsl.localhost\\Ubuntu\\home\\a\\.codex'],
      (home) => home.toLowerCase().startsWith('\\\\wsl.localhost\\'),
      invokeFn as any,
      confirmFn,
      flashToast,
    )

    expect(ok).toBe(false)
  })
})

