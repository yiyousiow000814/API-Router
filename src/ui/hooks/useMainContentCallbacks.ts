import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Status } from '../types'
import { resolveCliHomes } from '../utils/switchboard'

type Params = {
  status: Status | null
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  setGatewayModalOpen: Dispatch<SetStateAction<boolean>>
  setGatewayTokenReveal: Dispatch<SetStateAction<string>>
  setCodexRefreshing: Dispatch<SetStateAction<boolean>>
  refreshStatus: () => Promise<void>
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  toggleCodexSwap: (homes: string[]) => Promise<void>
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
    setCodexRefreshing,
    refreshStatus,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapUseWindows,
    codexSwapUseWsl,
    toggleCodexSwap,
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
    setGatewayModalOpen(true)
    setGatewayTokenReveal('')
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
        const homes = resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapUseWindows, codexSwapUseWsl)
        await toggleCodexSwap(homes)
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
