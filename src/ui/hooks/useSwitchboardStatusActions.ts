import { useRef, useState, type MutableRefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { CodexSwapStatus, Config, ProviderSwitchboardStatus, Status } from '../types'
import { GATEWAY_MODEL_PROVIDER_ID } from '../constants'
import { normalizePathForCompare } from '../utils/path'
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
  codexSwapStatus: CodexSwapStatus | null
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
  codexSwapStatus,
  setCodexSwapStatus,
  providerSwitchStatus,
  setProviderSwitchStatus,
  flashToast,
}: UseSwitchboardStatusActionsOptions) {
  const [providerSwitchBusy, setProviderSwitchBusy] = useState<boolean>(false)
  const providerSwitchBusyRef = useRef<boolean>(false)

  function tryEnterProviderSwitchBusy(): boolean {
    if (providerSwitchBusyRef.current) return false
    providerSwitchBusyRef.current = true
    setProviderSwitchBusy(true)
    return true
  }

  function leaveProviderSwitchBusy() {
    providerSwitchBusyRef.current = false
    setProviderSwitchBusy(false)
  }

  function isWslHomePath(home: string): boolean {
    const s = home.trim().replace(/\//g, '\\').toLowerCase()
    return s.startsWith('\\\\wsl.localhost\\') || s.startsWith('\\\\wsl$\\')
  }

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
        cliHomes: homes,
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
        cliHomes: homes,
      })
      const allEnabledHomes = resolveCliHomes(
        codexSwapDir1Ref.current,
        codexSwapDir2Ref.current,
        codexSwapUseWindowsRef.current,
        codexSwapUseWslRef.current,
      )
      const isPartialRefresh =
        Boolean(cliHomes && cliHomes.length) && homes.length < allEnabledHomes.length
      if (!isPartialRefresh) {
        setProviderSwitchStatus(res)
        return
      }
      const prevDirs = providerSwitchStatus?.dirs ?? []
      const nextByHome = new Map(
        (res.dirs ?? []).map((d) => [normalizePathForCompare(d.cli_home), d] as const),
      )
      const mergedFromPrev = prevDirs.map(
        (d) => nextByHome.get(normalizePathForCompare(d.cli_home)) ?? d,
      )
      const extraNew = (res.dirs ?? []).filter(
        (d) =>
          !prevDirs.some(
            (p) => normalizePathForCompare(p.cli_home) === normalizePathForCompare(d.cli_home),
          ),
      )
      setProviderSwitchStatus({
        ...res,
        dirs: [...mergedFromPrev, ...extraNew],
      })
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
    if (!tryEnterProviderSwitchBusy()) return
    const homes = cliHomes.map((s) => s.trim()).filter(Boolean)
    try {
      if (isDevPreview) {
        if (!homes.length) {
          flashToast('No enabled swap target. Open Configure Dirs first.', 'error')
          return
        }
        const allHomes = resolveCliHomes(
          codexSwapDir1Ref.current,
          codexSwapDir2Ref.current,
          codexSwapUseWindowsRef.current,
          codexSwapUseWslRef.current,
        )
        const knownHomes = allHomes.length ? allHomes : homes
        const prevByHome = new Map((codexSwapStatus?.dirs ?? []).map((d) => [d.cli_home.trim(), d.state]))
        const anySwapped = homes.some((h) => (prevByHome.get(h) ?? 'original') === 'swapped')
        const nextTargetState = anySwapped ? 'original' : 'swapped'
        const nextDirs = knownHomes.map((h) => ({
          cli_home: h,
          state: homes.includes(h) ? nextTargetState : (prevByHome.get(h) ?? 'original'),
        }))
        const hasSwapped = nextDirs.some((d) => d.state === 'swapped')
        const hasOriginal = nextDirs.some((d) => d.state === 'original')
        const overall = hasSwapped && hasOriginal ? 'mixed' : hasSwapped ? 'swapped' : 'original'
        setCodexSwapStatus({
          ok: true,
          overall,
          dirs: nextDirs,
        })
        const nextModeForHomes: 'gateway' | 'official' = anySwapped ? 'gateway' : 'official'
        const existingProviderDirs =
          providerSwitchStatus?.dirs ??
          knownHomes.map((home) => ({ cli_home: home, mode: 'gateway', model_provider: null }))
        const updatedProviderDirs = existingProviderDirs.map((dir) =>
          homes.includes(dir.cli_home)
            ? { ...dir, mode: nextModeForHomes, model_provider: null }
            : dir,
        )
        const uniqueModes = Array.from(new Set(updatedProviderDirs.map((dir) => dir.mode)))
        const providerMode =
          uniqueModes.length === 1 && (uniqueModes[0] === 'gateway' || uniqueModes[0] === 'official')
            ? (uniqueModes[0] as 'gateway' | 'official')
            : 'mixed'
        setProviderSwitchStatus({
          ok: true,
          mode: providerMode,
          model_provider: null,
          dirs: updatedProviderDirs,
          provider_options: (devConfig.provider_order ?? []).filter((n) => n !== 'official'),
        })
        flashToast(anySwapped ? 'Switched to gateway [TEST]' : 'Switched to official [TEST]')
        return
      }

      const prevByHome = new Map((codexSwapStatus?.dirs ?? []).map((d) => [d.cli_home.trim(), d.state]))
      const anySwapped = homes.some((h) => (prevByHome.get(h) ?? 'original') === 'swapped')
      const switchingToGateway = anySwapped
      if (switchingToGateway) {
        const access = await invoke<{ ok: boolean; legacy_conflict?: boolean }>('wsl_gateway_access_quick_status')
        if (access.legacy_conflict) {
          const shouldCleanup = window.confirm(
            'A legacy WSL2 portproxy rule is using port 4000 (this can also break Windows access to the gateway).\n\nClick OK to clean it now (requires admin), or Cancel to abort switching.',
          )
          if (!shouldCleanup) return
          await invoke('wsl_gateway_revoke_access')
          flashToast('Removed legacy WSL2 portproxy conflict')
        }
      }

      const res = await invoke<{ ok: boolean; mode: 'swapped' | 'restored'; cli_homes: string[] }>(
        'codex_cli_toggle_auth_config_swap',
        { cliHomes: homes },
      )
      flashToast(res.mode === 'swapped' ? 'Switched to official' : 'Switched to gateway')
      await refreshStatus({ refreshSwapStatus: false })
      await Promise.all([
        refreshCodexSwapStatus(homes),
        refreshProviderSwitchStatus(homes),
        refreshConfig({ refreshProviderSwitchStatus: false }),
      ])
    } finally {
      leaveProviderSwitchBusy()
    }
  }

  async function setProviderSwitchTarget(
    target: 'gateway' | 'official' | 'provider',
    provider?: string,
    cliHomes?: string[],
  ) {
    if (!tryEnterProviderSwitchBusy()) return
    const allHomes = resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapUseWindows, codexSwapUseWsl)
    const homes =
      cliHomes && cliHomes.length
        ? cliHomes
        : allHomes
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

      if (target === 'gateway') {
        const access = await invoke<{ ok: boolean; authorized: boolean; legacy_conflict?: boolean }>('wsl_gateway_access_quick_status')
        if (access.legacy_conflict) {
          const shouldCleanup = window.confirm(
            'A legacy WSL2 portproxy rule is using port 4000 (this can also break Windows access to the gateway).\n\nClick OK to clean it now (requires admin), or Cancel to abort switching.',
          )
          if (!shouldCleanup) return
          await invoke('wsl_gateway_revoke_access')
          flashToast('Removed legacy WSL2 portproxy conflict')
        }
      }

      if (target === 'gateway' && homes.some((h) => isWslHomePath(h))) {
        const access = await invoke<{ ok: boolean; authorized: boolean }>('wsl_gateway_access_quick_status')
        if (!access.authorized) {
          const shouldAuthorize = window.confirm(
            'WSL2 access to the local gateway requires Windows network authorization first.\n\nClick OK to authorize now (Admin), or Cancel to skip switching for now.',
          )
          if (!shouldAuthorize) return
          await invoke('wsl_gateway_authorize_access')
          flashToast('WSL2 gateway access authorized')
        }
      }

      const res = await invoke<ProviderSwitchboardStatus>('provider_switchboard_set_target', {
        cliHomes: homes,
        target,
        provider: provider ?? null,
      })
      const prevDirs = providerSwitchStatus?.dirs ?? []
      const nextByHome = new Map(
        (res.dirs ?? []).map((d) => [normalizePathForCompare(d.cli_home), d]),
      )
      const mergedFromPrev = prevDirs.map(
        (d) => nextByHome.get(normalizePathForCompare(d.cli_home)) ?? d,
      )
      const extraNew = (res.dirs ?? []).filter(
        (d) =>
          !prevDirs.some(
            (p) => normalizePathForCompare(p.cli_home) === normalizePathForCompare(d.cli_home),
          ),
      )
      const mergedDirs = [...mergedFromPrev, ...extraNew]
      setProviderSwitchStatus({
        ...res,
        dirs: mergedDirs,
      })
      const msg =
        target === 'provider' ? 'Switched to provider: ' + provider : target === 'gateway' ? 'Switched to gateway' : 'Switched to official'
      flashToast(msg)
      // Avoid full-page flicker: trust set_target response as source of truth here,
      // and only refresh swap state in background for badge consistency.
      void refreshCodexSwapStatus(homes)
    } catch (e) {
      flashToast(String(e), 'error')
    } finally {
      leaveProviderSwitchBusy()
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
