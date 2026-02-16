import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ProviderSwitchboardStatus, Status } from '../types'
import { resolveCliHomes } from '../utils/switchboard'

type Params = {
  status: Status | null
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  setGatewayModalOpen: Dispatch<SetStateAction<boolean>>
  setGatewayTokenReveal: Dispatch<SetStateAction<string>>
  setGatewayTokenPreview: Dispatch<SetStateAction<string>>
  setCodexRefreshing: Dispatch<SetStateAction<boolean>>
  refreshStatus: () => Promise<void>
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  codexSwapTarget: 'windows' | 'wsl2' | 'both'
  providerSwitchStatus: ProviderSwitchboardStatus | null
  setProviderSwitchTarget: (
    target: 'gateway' | 'official' | 'provider',
    provider?: string,
    cliHomes?: string[],
  ) => Promise<void>
  setCodexSwapModalOpen: Dispatch<SetStateAction<boolean>>
  setOverride: Dispatch<SetStateAction<string>>
  overrideDirtyRef: MutableRefObject<boolean>
  applyOverride: (next: string) => Promise<void>
}

export function useMainContentCallbacks(params: Params) {
  const {
    status,
    flashToast,
    setGatewayModalOpen,
    setGatewayTokenReveal,
    setGatewayTokenPreview,
    setCodexRefreshing,
    refreshStatus,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
    codexSwapTarget,
    providerSwitchStatus,
    setProviderSwitchTarget,
    setCodexSwapModalOpen,
    setOverride,
    overrideDirtyRef,
    applyOverride,
  } = params

  const onCopyToken = () => {
    void (async () => {
      try {
        const tok = await invoke<string>('get_gateway_token')
        await navigator.clipboard.writeText(tok)
        flashToast('Gateway token copied')
      } catch (e) {
        flashToast(String(e), 'error')
      }
    })()
  }

  const onShowGatewayRotate = () => {
    void (async () => {
      try {
        await invoke<string>('rotate_gateway_token')
        const p = await invoke<string>('get_gateway_token_preview')
        setGatewayTokenPreview(p)
        setGatewayTokenReveal('')
        setGatewayModalOpen(false)
        flashToast('Gateway token rotated')
      } catch (e) {
        flashToast(String(e), 'error')
      }
    })()
  }

  const onCodexLoginLogout = () => {
    void (async () => {
      try {
        if (status?.codex_account?.signed_in) {
          await invoke('codex_account_logout')
          flashToast('Codex logged out')
        } else {
          await invoke('codex_account_login')
          flashToast('Codex login opened in browser')
        }
      } catch (e) {
        flashToast(String(e), 'error')
      }
    })()
  }

  const onCodexRefresh = () => {
    void (async () => {
      flashToast('Checking...')
      setCodexRefreshing(true)
      try {
        await invoke('codex_account_refresh')
        await refreshStatus()
      } catch (e) {
        flashToast(String(e), 'error')
      } finally {
        setCodexRefreshing(false)
      }
    })()
  }

  const onCodexSwapAuthConfig = () => {
    void (async () => {
      try {
        const windowsHome = codexSwapUseWindows ? codexSwapDir1.trim() : ''
        const wslHome = codexSwapUseWsl ? codexSwapDir2.trim() : ''
        const homes =
          codexSwapTarget === 'windows'
            ? windowsHome
              ? [windowsHome]
              : []
            : codexSwapTarget === 'wsl2'
              ? wslHome
                ? [wslHome]
                : []
              : resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapUseWindows, codexSwapUseWsl)
        if (!homes.length) {
          flashToast('No enabled swap target. Open Configure Dirs first.', 'error')
          return
        }
        const modeByHome = new Map((providerSwitchStatus?.dirs ?? []).map((d) => [d.cli_home.trim(), d.mode]))
        const allSelectedGateway = homes.every((h) => modeByHome.get(h) === 'gateway')
        const nextTarget: 'gateway' | 'official' = allSelectedGateway ? 'official' : 'gateway'
        await setProviderSwitchTarget(nextTarget, undefined, homes)
      } catch (e) {
        flashToast(String(e), 'error')
      }
    })()
  }

  const onOpenCodexSwapOptions = () => setCodexSwapModalOpen(true)

  const onOverrideChange = (next: string) => {
    setOverride(next)
    overrideDirtyRef.current = true
    void applyOverride(next)
  }

  return {
    onCopyToken,
    onShowGatewayRotate,
    onCodexLoginLogout,
    onCodexRefresh,
    onCodexSwapAuthConfig,
    onOpenCodexSwapOptions,
    onOverrideChange,
  }
}
