import { describe, expect, it, vi } from 'vitest'
import {
  applyProviderSwitchStatusResult,
  mergeProviderSwitchDirs,
  runGatewaySwitchPreflight,
  shouldRefreshConfigForRevision,
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
  it('does not call legacy WSL gateway access commands or toast for gateway mode', async () => {
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
    expect(flashToast).not.toHaveBeenCalled()
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

describe('shouldRefreshConfigForRevision', () => {
  it('refreshes only when a known revision changes', () => {
    expect(shouldRefreshConfigForRevision(null, 'rev-1')).toBe(false)
    expect(shouldRefreshConfigForRevision('', 'rev-1')).toBe(false)
    expect(shouldRefreshConfigForRevision('rev-1', 'rev-1')).toBe(false)
    expect(shouldRefreshConfigForRevision('rev-1', 'rev-2')).toBe(true)
  })
})
