import { useState, type MutableRefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { CodexSwapStatus, Config, ProviderSwitchboardStatus, Status } from '../types'
import { GATEWAY_MODEL_PROVIDER_ID } from '../constants'
import { resolveCliHomes } from '../utils/switchboard'

type UseSwitchboardStatusActionsOptions = {
  isDevPreview: boolean
  devStatus: Status
  devConfig: Config
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  codexSwapDir1Ref: MutableRefObject<string>
  codexSwapDir2Ref: MutableRefObject<string>
  codexSwapUseWindowsRef: MutableRefObject<boolean>
  codexSwapUseWslRef: MutableRefObject<boolean>
  overrideDirtyRef: MutableRefObject<boolean>
  setStatus: (next: Status) => void
  setOverride: (next: string) => void
  setConfig: (next: Config) => void
  setBaselineBaseUrls: (next: Record<string, string>) => void
  setGatewayTokenPreview: (next: string) => void
  setCodexSwapStatus: (next: CodexSwapStatus) => void
  providerSwitchStatus: ProviderSwitchboardStatus | null
  setProviderSwitchStatus: (next: ProviderSwitchboardStatus) => void
  flashToast: (msg: string, kind?: 'info' | 'error') => void
}

export function useSwitchboardStatusActions({
  isDevPreview,
  devStatus,
  devConfig,
  codexSwapDir1,
  codexSwapDir2,
  codexSwapUseWindows,
  codexSwapUseWsl,
  codexSwapDir1Ref,
  codexSwapDir2Ref,
  codexSwapUseWindowsRef,
  codexSwapUseWslRef,
  overrideDirtyRef,
  setStatus,
  setOverride,
  setConfig,
  setBaselineBaseUrls,
  setGatewayTokenPreview,
  setCodexSwapStatus,
  providerSwitchStatus,
  setProviderSwitchStatus,
  flashToast,
}: UseSwitchboardStatusActionsOptions) {
  const [providerSwitchBusy, setProviderSwitchBusy] = useState<boolean>(false)

  async function refreshCodexSwapStatus(cliHomes?: string[]) {
    if (isDevPreview) return
    try {
      const homes =
        cliHomes && cliHomes.length
          ? cliHomes
          : resolveCliHomes(
              codexSwapDir1Ref.current,
              codexSwapDir2Ref.current,
              codexSwapUseWindowsRef.current,
              codexSwapUseWslRef.current,
            )
      const res = await invoke<CodexSwapStatus>('codex_cli_swap_status', {
        cli_homes: homes,
      })
      setCodexSwapStatus(res)
    } catch {
      setCodexSwapStatus({ ok: true, overall: 'error', dirs: [] })
    }
  }

  async function refreshProviderSwitchStatus(cliHomes?: string[]) {
    const homes =
      cliHomes && cliHomes.length
        ? cliHomes
        : resolveCliHomes(
            codexSwapDir1Ref.current,
            codexSwapDir2Ref.current,
            codexSwapUseWindowsRef.current,
            codexSwapUseWslRef.current,
          )
    if (isDevPreview) {
      setProviderSwitchStatus({
        ok: true,
        mode: 'gateway',
        model_provider: GATEWAY_MODEL_PROVIDER_ID,
        dirs: homes.map((h) => ({ cli_home: h, mode: 'gateway', model_provider: null })),
        provider_options: (devConfig.provider_order ?? []).filter((n) => n !== 'official'),
      })
      return
    }
    try {
      const res = await invoke<ProviderSwitchboardStatus>('provider_switchboard_status', {
        cli_homes: homes,
      })
      setProviderSwitchStatus(res)
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function refreshStatus(options?: { refreshSwapStatus?: boolean }) {
    const shouldRefreshSwapStatus = options?.refreshSwapStatus ?? true
    if (isDevPreview) {
      setStatus(devStatus)
      if (shouldRefreshSwapStatus) {
        void refreshCodexSwapStatus()
      }
      return
    }
    try {
      const s = await invoke<Status>('get_status')
      setStatus(s)
      if (!overrideDirtyRef.current) setOverride(s.manual_override ?? '')
      if (shouldRefreshSwapStatus) {
        void refreshCodexSwapStatus()
      }
    } catch (e) {
      console.error(e)
    }
  }

  async function refreshConfig(options?: { refreshProviderSwitchStatus?: boolean }) {
    const shouldRefreshProviderSwitchStatus = options?.refreshProviderSwitchStatus ?? true
    if (isDevPreview) {
      setConfig(devConfig)
      setBaselineBaseUrls(Object.fromEntries(Object.entries(devConfig.providers).map(([name, p]) => [name, p.base_url])))
      setGatewayTokenPreview('ao_dev********7f2a')
      if (shouldRefreshProviderSwitchStatus) {
        void refreshProviderSwitchStatus()
      }
      return
    }
    try {
      const c = await invoke<Config>('get_config')
      setConfig(c)
      setBaselineBaseUrls(Object.fromEntries(Object.entries(c.providers).map(([name, p]) => [name, p.base_url])))
      const p = await invoke<string>('get_gateway_token_preview')
      setGatewayTokenPreview(p)
      const homes = resolveCliHomes(
        codexSwapDir1Ref.current,
        codexSwapDir2Ref.current,
        codexSwapUseWindowsRef.current,
        codexSwapUseWslRef.current,
      )
      if (homes.length > 0 && shouldRefreshProviderSwitchStatus) {
        void refreshProviderSwitchStatus(homes)
      }
    } catch (e) {
      console.error(e)
    }
  }

  async function toggleCodexSwap(cliHomes: string[]) {
    const homes = cliHomes.map((s) => s.trim()).filter(Boolean)
    const res = await invoke<{ ok: boolean; mode: 'swapped' | 'restored'; cli_homes: string[] }>(
      'codex_cli_toggle_auth_config_swap',
      { cli_homes: homes },
    )
    flashToast(res.mode === 'swapped' ? 'Swapped Codex auth/config' : 'Restored Codex auth/config')
    await refreshStatus({ refreshSwapStatus: false })
    await Promise.all([
      refreshCodexSwapStatus(homes),
      refreshProviderSwitchStatus(homes),
      refreshConfig({ refreshProviderSwitchStatus: false }),
    ])
  }

  async function setProviderSwitchTarget(
    target: 'gateway' | 'official' | 'provider',
    provider?: string,
    cliHomes?: string[],
  ) {
    const homes =
      cliHomes && cliHomes.length
        ? cliHomes
        : resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapUseWindows, codexSwapUseWsl)
    setProviderSwitchBusy(true)
    try {
      if (isDevPreview) {
        const targetProvider = target === 'provider' ? provider ?? null : null
        const existingDirs =
          providerSwitchStatus?.dirs ??
          homes.map((home) => ({ cli_home: home, mode: 'gateway', model_provider: null }))
        const updatedDirs = existingDirs.map((dir) =>
          homes.includes(dir.cli_home)
            ? { ...dir, mode: target, model_provider: targetProvider }
            : dir,
        )
        const modes = Array.from(new Set(updatedDirs.map((dir) => dir.mode)))
        const providerModes = updatedDirs
          .filter((dir) => dir.mode === 'provider')
          .map((dir) => dir.model_provider ?? '')
        const providerValues = Array.from(new Set(providerModes))
        const mode =
          modes.length === 1 && (modes[0] !== 'provider' || providerValues.length <= 1)
            ? (modes[0] as 'gateway' | 'official' | 'provider')
            : 'mixed'
        const modelProvider = mode === 'provider' ? providerValues[0] ?? null : null
        setProviderSwitchStatus({
          ok: true,
          mode,
          model_provider: modelProvider,
          dirs: updatedDirs,
          provider_options: (devConfig.provider_order ?? []).filter((n) => n !== 'official'),
        })
        const msg =
          target === 'provider'
            ? 'Switched to provider: ' + provider
            : target === 'gateway'
              ? 'Switched to gateway'
              : 'Switched to official'
        flashToast(msg)
        return
      }
      const res = await invoke<ProviderSwitchboardStatus>('provider_switchboard_set_target', {
        cli_homes: homes,
        target,
        provider: provider ?? null,
      })
      setProviderSwitchStatus(res)
      const msg =
        target === 'provider' ? 'Switched to provider: ' + provider : target === 'gateway' ? 'Switched to gateway' : 'Switched to official'
      flashToast(msg)
      await refreshStatus({ refreshSwapStatus: false })
      await Promise.all([refreshCodexSwapStatus(homes), refreshConfig({ refreshProviderSwitchStatus: false })])
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      setProviderSwitchBusy(false)
    }
  }

  return {
    providerSwitchBusy,
    toggleCodexSwap,
    refreshCodexSwapStatus,
    refreshProviderSwitchStatus,
    refreshStatus,
    refreshConfig,
    setProviderSwitchTarget,
  }
}
