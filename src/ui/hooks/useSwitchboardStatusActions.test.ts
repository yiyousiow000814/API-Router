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

  it('rechecks quick status after legacy cleanup before authorization decision', async () => {
    const invokeFn = vi.fn(async (cmd: string) => {
      if (cmd === 'wsl_gateway_access_quick_status') {
        if (invokeFn.mock.calls.filter(([name]) => name === cmd).length === 1) {
          return { ok: true, authorized: true, legacy_conflict: true }
        }
        return { ok: true, authorized: false, legacy_conflict: false }
      }
      if (cmd === 'wsl_gateway_revoke_access') {
        return { ok: true, authorized: false }
      }
      throw new Error(`unexpected command: ${cmd}`)
    })
    const confirmFn = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
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
    expect(
      invokeFn.mock.calls.filter(([name]) => name === 'wsl_gateway_access_quick_status').length,
    ).toBe(2)
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
