import { invoke } from '@tauri-apps/api/core'
import { resolveCliHomes } from '../utils/switchboard'

type Params = Record<string, any>

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
    codexSwapApplyBoth,
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
        const homes = resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapApplyBoth)
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
