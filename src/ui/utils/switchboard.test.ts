import { describe, expect, it } from 'vitest'
import { buildCodexSwapBadge } from './switchboard'
import type { ProviderSwitchboardStatus } from '../types'

describe('buildCodexSwapBadge', () => {
  it('returns Mixed when scoped provider dirs use different providers', () => {
    const status: ProviderSwitchboardStatus = {
      ok: true,
      mode: 'provider',
      model_provider: 'packycode',
      dirs: [
        { cli_home: 'C:\\Users\\u\\.codex', mode: 'provider', model_provider: 'packycode' },
        {
          cli_home: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex',
          mode: 'provider',
          model_provider: 'pumpkinai',
        },
      ],
      provider_options: ['packycode', 'pumpkinai'],
    }
    const badge = buildCodexSwapBadge(null, status)
    expect(badge.badgeText).toBe('Mixed')
  })

  it('keeps DP label when scoped provider dirs agree on provider', () => {
    const status: ProviderSwitchboardStatus = {
      ok: true,
      mode: 'provider',
      model_provider: 'packycode',
      dirs: [
        { cli_home: 'C:\\Users\\u\\.codex', mode: 'provider', model_provider: 'packycode' },
        {
          cli_home: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex',
          mode: 'provider',
          model_provider: 'packycode',
        },
      ],
      provider_options: ['packycode'],
    }
    const badge = buildCodexSwapBadge(null, status)
    expect(badge.badgeText).toBe('DP:packycode')
  })
})
