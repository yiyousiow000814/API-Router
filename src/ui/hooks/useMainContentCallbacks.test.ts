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
    vi.clearAllMocks()
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
      codexSwapDir1: '',
      codexSwapDir2: '',
      codexSwapUseWindows: true,
      codexSwapUseWsl: true,
      codexSwapTarget: 'both',
      providerSwitchStatus: null,
      setProviderSwitchTarget: vi.fn(async () => {}),
      setCodexSwapModalOpen: vi.fn(),
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
})
