import { describe, expect, it, vi } from 'vitest'
import {
  applyProviderSwitchStatusResult,
  mergeProviderSwitchDirs,
  runGatewaySwitchPreflight,
  summarizeProviderSwitchState,
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
  it('does not call legacy WSL gateway access commands for gateway mode', async () => {
    const invokeFn = vi.fn()
    const confirmFn = vi.fn()
    const flashToast = vi.fn()

    const ok = await runGatewaySwitchPreflight(
      'gateway',
      ['\\\\wsl.localhost\\Ubuntu\\home\\a\\.codex'],
      4000,
      (home) => home.toLowerCase().startsWith('\\\\wsl.localhost\\'),
      invokeFn as any,
      confirmFn,
      flashToast,
    )

    expect(ok).toBe(true)
    expect(invokeFn).not.toHaveBeenCalled()
    expect(confirmFn).not.toHaveBeenCalled()
    expect(flashToast).toHaveBeenCalledWith(
      'WSL2 gateway access is now native; no Windows authorization is required.',
      'info',
    )
  })
})

describe('summarizeProviderSwitchState', () => {
  it('returns mixed when merged dirs are not globally gateway', () => {
    const mergedDirs = [
      { cli_home: 'C:\\Users\\a\\.codex', mode: 'gateway', model_provider: null },
      { cli_home: '\\\\wsl.localhost\\Ubuntu\\home\\a\\.codex', mode: 'official', model_provider: null },
    ]
    const summary = summarizeProviderSwitchState(mergedDirs)
    expect(summary.mode).toBe('mixed')
  })
})

describe('applyProviderSwitchStatusResult', () => {
  it('re-summarizes top-level mode after partial merge', () => {
    const prevStatus = {
      ok: true,
      mode: 'mixed' as const,
      model_provider: null,
      dirs: [
        { cli_home: 'C:\\Users\\a\\.codex', mode: 'gateway', model_provider: null },
        { cli_home: '\\\\wsl.localhost\\Ubuntu\\home\\a\\.codex', mode: 'official', model_provider: null },
      ],
      provider_options: ['packycode'],
    }
    const partialRes = {
      ok: true,
      mode: 'gateway' as const,
      model_provider: null,
      dirs: [{ cli_home: 'C:\\Users\\a\\.codex', mode: 'gateway', model_provider: null }],
      provider_options: ['packycode'],
    }

    const merged = applyProviderSwitchStatusResult(prevStatus, partialRes, true)
    expect(merged.mode).toBe('mixed')
  })
})
