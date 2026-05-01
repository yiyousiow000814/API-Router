import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMainContentCallbacks } from './useMainContentCallbacks'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'

type RotateGatewayTokenResult = {
  token: string
  failed_targets?: string[]
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useMainContentCallbacks', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('shows an error toast when rotate has failed sync targets', async () => {
    const flashToast = vi.fn()
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        token: 'ao_new',
        failed_targets: ['C:\\Users\\a\\.codex'],
      } as RotateGatewayTokenResult)
      .mockResolvedValueOnce('ao_new******token')

    const callbacks = useMainContentCallbacks({
      status: null,
      flashToast,
      setGatewayModalOpen: vi.fn(),
      setGatewayTokenReveal: vi.fn(),
      setGatewayTokenPreview: vi.fn(),
      setCodexRefreshing: vi.fn(),
      refreshStatus: vi.fn(async () => {}),
      codexSwapDir1: 'C:\\Users\\a\\.codex',
      codexSwapDir2: '\\\\wsl.localhost\\Ubuntu\\home\\a\\.codex',
      codexSwapUseWindows: true,
      codexSwapUseWsl: true,
      codexSwapTarget: 'both',
      providerSwitchStatus: null,
      setProviderSwitchTarget: vi.fn(async () => {}),
      setCodexSwapModalOpen: vi.fn(),
      override: '',
      setOverride: vi.fn(),
      overrideDirtyRef: { current: false },
      applyOverride: vi.fn(async () => true),
    })

    callbacks.onShowGatewayRotate()
    await flushAsync()
    await flushAsync()

    expect(flashToast).toHaveBeenCalledWith(
      expect.stringContaining('Failed to sync'),
      'error',
    )
    expect(invoke).toHaveBeenCalledWith('rotate_gateway_token', {
      cliHomes: ['C:\\Users\\a\\.codex', '\\\\wsl.localhost\\Ubuntu\\home\\a\\.codex'],
    })
  })

  it('blocks quick swap toggle while switchboard status is loading', async () => {
    const flashToast = vi.fn()
    const setProviderSwitchTarget = vi.fn(async () => {})
    const callbacks = useMainContentCallbacks({
      status: null,
      flashToast,
      setGatewayModalOpen: vi.fn(),
      setGatewayTokenReveal: vi.fn(),
      setGatewayTokenPreview: vi.fn(),
      setCodexRefreshing: vi.fn(),
      refreshStatus: vi.fn(async () => {}),
      codexSwapDir1: 'C:\\Users\\a\\.codex',
      codexSwapDir2: '\\\\wsl.localhost\\Ubuntu\\home\\a\\.codex',
      codexSwapUseWindows: true,
      codexSwapUseWsl: false,
      codexSwapTarget: 'windows',
      providerSwitchStatus: null,
      setProviderSwitchTarget,
      setCodexSwapModalOpen: vi.fn(),
      override: '',
      setOverride: vi.fn(),
      overrideDirtyRef: { current: false },
      applyOverride: vi.fn(async () => true),
    })

    callbacks.onCodexSwapAuthConfig()
    await flushAsync()

    expect(setProviderSwitchTarget).not.toHaveBeenCalled()
    expect(flashToast).toHaveBeenCalledWith(
      expect.stringContaining('Switchboard status is loading'),
      'error',
    )
  })

  it('rolls back local override when applyOverride fails', async () => {
    const setOverride = vi.fn()
    const overrideDirtyRef = { current: false }
    const applyOverride = vi.fn(async () => false)

    const callbacks = useMainContentCallbacks({
      status: null,
      flashToast: vi.fn(),
      setGatewayModalOpen: vi.fn(),
      setGatewayTokenReveal: vi.fn(),
      setGatewayTokenPreview: vi.fn(),
      setCodexRefreshing: vi.fn(),
      refreshStatus: vi.fn(async () => {}),
      codexSwapDir1: '',
      codexSwapDir2: '',
      codexSwapUseWindows: true,
      codexSwapUseWsl: true,
      codexSwapTarget: 'both',
      providerSwitchStatus: null,
      setProviderSwitchTarget: vi.fn(async () => {}),
      setCodexSwapModalOpen: vi.fn(),
      override: 'p1',
      setOverride,
      overrideDirtyRef,
      applyOverride,
    })

    const ok = await callbacks.onOverrideChange('p2')

    expect(ok).toBe(false)
    expect(applyOverride).toHaveBeenCalledWith('p2')
    expect(setOverride).toHaveBeenNthCalledWith(1, 'p2')
    expect(setOverride).toHaveBeenNthCalledWith(2, 'p1')
    expect(overrideDirtyRef.current).toBe(false)
  })

  it('refreshes all official account usage and the current codex session from the hero refresh button', async () => {
    const flashToast = vi.fn()
    const setCodexRefreshing = vi.fn()
    const refreshStatus = vi.fn(async () => {})
    vi.mocked(invoke).mockResolvedValueOnce({ ok: true, refreshed: 2, failures: [] })

    const callbacks = useMainContentCallbacks({
      status: {
        codex_account: {
          signed_in: true,
        },
      } as any,
      flashToast,
      setGatewayModalOpen: vi.fn(),
      setGatewayTokenReveal: vi.fn(),
      setGatewayTokenPreview: vi.fn(),
      setCodexRefreshing,
      refreshStatus,
      codexSwapDir1: '',
      codexSwapDir2: '',
      codexSwapUseWindows: true,
      codexSwapUseWsl: true,
      codexSwapTarget: 'both',
      providerSwitchStatus: null,
      setProviderSwitchTarget: vi.fn(async () => {}),
      setCodexSwapModalOpen: vi.fn(),
      override: '',
      setOverride: vi.fn(),
      overrideDirtyRef: { current: false },
      applyOverride: vi.fn(async () => true),
    })

    callbacks.onCodexRefresh()
    await flushAsync()
    await flushAsync()

    expect(flashToast).toHaveBeenCalledWith('Refreshing all official accounts...')
    expect(flashToast).toHaveBeenCalledWith('Official accounts refreshed: 2')
    expect(setCodexRefreshing).toHaveBeenCalledWith(true)
    expect(invoke).toHaveBeenCalledWith('codex_account_refresh')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(refreshStatus).toHaveBeenCalled()
    expect(setCodexRefreshing).toHaveBeenLastCalledWith(false)
  })

  it('shows partial official account refresh failures from the hero refresh button', async () => {
    const flashToast = vi.fn()
    const setCodexRefreshing = vi.fn()
    const refreshStatus = vi.fn(async () => {})
    vi.mocked(invoke).mockResolvedValueOnce({
      ok: false,
      refreshed: 1,
      failures: [
        {
          profileId: 'profile_2',
          email: 'yiyousiow1234@gmail.com',
          error: 'official account rate limits unavailable',
        },
      ],
    })

    const callbacks = useMainContentCallbacks({
      status: {
        codex_account: {
          signed_in: true,
        },
      } as any,
      flashToast,
      setGatewayModalOpen: vi.fn(),
      setGatewayTokenReveal: vi.fn(),
      setGatewayTokenPreview: vi.fn(),
      setCodexRefreshing,
      refreshStatus,
      codexSwapDir1: '',
      codexSwapDir2: '',
      codexSwapUseWindows: true,
      codexSwapUseWsl: true,
      codexSwapTarget: 'both',
      providerSwitchStatus: null,
      setProviderSwitchTarget: vi.fn(async () => {}),
      setCodexSwapModalOpen: vi.fn(),
      override: '',
      setOverride: vi.fn(),
      overrideDirtyRef: { current: false },
      applyOverride: vi.fn(async () => true),
    })

    callbacks.onCodexRefresh()
    await flushAsync()
    await flushAsync()

    expect(flashToast).toHaveBeenCalledWith(
      'Official account refresh partial: 1 updated, 1 unavailable (yiyousiow1234@gmail.com: official account rate limits unavailable)',
      'error',
    )
    expect(refreshStatus).toHaveBeenCalled()
    expect(setCodexRefreshing).toHaveBeenLastCalledWith(false)
  })
})
