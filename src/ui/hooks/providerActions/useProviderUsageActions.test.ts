import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../../types'
import {
  applyProviderQuotaHardCapLocalPatch,
  setProviderQuotaHardCapFieldWithRefresh,
} from './useProviderUsageActions'

function buildConfig(): Config {
  return {
    listen: { host: '127.0.0.1', port: 4000 },
    routing: {
      preferred_provider: 'p1',
      auto_return_to_preferred: true,
      preferred_stable_seconds: 30,
      failure_threshold: 2,
      cooldown_seconds: 30,
      request_timeout_seconds: 60,
    },
    providers: {
      p1: {
        display_name: 'P1',
        base_url: 'https://example.com/v1',
        has_key: false,
        quota_hard_cap: { daily: true, weekly: true, monthly: true },
      },
    },
    provider_order: ['p1'],
  }
}

describe('applyProviderQuotaHardCapLocalPatch', () => {
  it('updates only the selected field locally', () => {
    const next = applyProviderQuotaHardCapLocalPatch(buildConfig(), 'p1', 'weekly', false)
    expect(next?.providers.p1.quota_hard_cap).toEqual({
      daily: true,
      weekly: false,
      monthly: true,
    })
  })
})

describe('setProviderQuotaHardCapFieldWithRefresh', () => {
  it('invokes backend command and refreshes on success', async () => {
    let cfg: Config | null = buildConfig()
    const setConfig = vi.fn((updater: (prev: Config | null) => Config | null) => {
      cfg = updater(cfg)
    })
    const invokeFn = vi.fn().mockResolvedValue(undefined)
    const refreshConfig = vi.fn().mockResolvedValue(undefined)
    const refreshStatus = vi.fn().mockResolvedValue(undefined)
    const flashToast = vi.fn()

    await setProviderQuotaHardCapFieldWithRefresh({
      provider: 'p1',
      field: 'weekly',
      enabled: false,
      invokeFn,
      setConfig: setConfig as any,
      refreshConfig,
      refreshStatus,
      flashToast,
    })

    expect(cfg?.providers.p1.quota_hard_cap).toEqual({
      daily: true,
      weekly: false,
      monthly: true,
    })
    expect(invokeFn).toHaveBeenCalledWith('set_provider_quota_hard_cap_field', {
      provider: 'p1',
      field: 'weekly',
      enabled: false,
    })
    expect(refreshConfig).toHaveBeenCalledTimes(1)
    expect(refreshStatus).toHaveBeenCalledTimes(1)
    expect(flashToast).toHaveBeenCalledWith('Hard cap updated: p1.weekly')
  })

  it('still refreshes and keeps optimistic state on invoke failure', async () => {
    let cfg: Config | null = buildConfig()
    const setConfig = vi.fn((updater: (prev: Config | null) => Config | null) => {
      cfg = updater(cfg)
    })
    const invokeFn = vi.fn().mockRejectedValue(new Error('boom'))
    const refreshConfig = vi.fn().mockResolvedValue(undefined)
    const refreshStatus = vi.fn().mockResolvedValue(undefined)
    const flashToast = vi.fn()

    await setProviderQuotaHardCapFieldWithRefresh({
      provider: 'p1',
      field: 'daily',
      enabled: false,
      invokeFn,
      setConfig: setConfig as any,
      refreshConfig,
      refreshStatus,
      flashToast,
    })

    expect(cfg?.providers.p1.quota_hard_cap).toEqual({
      daily: false,
      weekly: true,
      monthly: true,
    })
    expect(refreshConfig).toHaveBeenCalledTimes(1)
    expect(refreshStatus).toHaveBeenCalledTimes(1)
    expect(flashToast).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error')
  })
})
