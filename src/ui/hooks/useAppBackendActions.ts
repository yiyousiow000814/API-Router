import { useCallback } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'

import type { CodexSwapStatus, Config, ProviderSwitchboardStatus, Status, UsageStatistics } from '../types'
import { buildDevUsageStatistics } from '../utils/usageMock'

type Args = {
  isDevPreview: boolean
  usageWindowHours: number
  usageFilterProviders: string[]
  usageFilterModels: string[]
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapApplyBoth: boolean
  codexSwapDir1Ref: MutableRefObject<string>
  codexSwapDir2Ref: MutableRefObject<string>
  codexSwapApplyBothRef: MutableRefObject<boolean>
  overrideDirtyRef: MutableRefObject<boolean>
  status: Status | null
  setStatus: Dispatch<SetStateAction<Status | null>>
  setConfig: Dispatch<SetStateAction<Config | null>>
  setBaselineBaseUrls: Dispatch<SetStateAction<Record<string, string>>>
  setGatewayTokenPreview: Dispatch<SetStateAction<string>>
  setOverride: Dispatch<SetStateAction<string>>
  setCodexSwapStatus: Dispatch<SetStateAction<CodexSwapStatus | null>>
  setProviderSwitchStatus: Dispatch<SetStateAction<ProviderSwitchboardStatus | null>>
  setProviderSwitchBusy: Dispatch<SetStateAction<boolean>>
  setUsageStatistics: Dispatch<SetStateAction<UsageStatistics | null>>
  setUsageStatisticsLoading: Dispatch<SetStateAction<boolean>>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  resolveCliHomes: (dir1: string, dir2: string, applyBoth: boolean) => string[]
  devConfig: Config
  devStatus: Status
  onRefreshUsageHistoryWhenNeeded?: () => Promise<void>
}

export function useAppBackendActions(args: Args) {
  const refreshCodexSwapStatus = useCallback(
    async (cliHomes?: string[]) => {
      if (args.isDevPreview) return
      try {
        const homes =
          cliHomes && cliHomes.length
            ? cliHomes
            : args.resolveCliHomes(
                args.codexSwapDir1Ref.current,
                args.codexSwapDir2Ref.current,
                args.codexSwapApplyBothRef.current,
              )
        const res = await invoke<CodexSwapStatus>('codex_cli_swap_status', {
          cli_homes: homes,
        })
        args.setCodexSwapStatus(res)
      } catch {
        args.setCodexSwapStatus({ ok: true, overall: 'error', dirs: [] })
      }
    },
    [args],
  )

  const refreshProviderSwitchStatus = useCallback(
    async (cliHomes?: string[]) => {
      const homes =
        cliHomes && cliHomes.length
          ? cliHomes
          : args.resolveCliHomes(
              args.codexSwapDir1Ref.current,
              args.codexSwapDir2Ref.current,
              args.codexSwapApplyBothRef.current,
            )
      if (args.isDevPreview) {
        args.setProviderSwitchStatus({
          ok: true,
          mode: 'gateway',
          model_provider: 'api_router',
          dirs: homes.map((h) => ({ cli_home: h, mode: 'gateway', model_provider: null })),
          provider_options: (args.devConfig.provider_order ?? []).filter((name) => name !== 'official'),
        })
        return
      }
      try {
        const res = await invoke<ProviderSwitchboardStatus>('provider_switchboard_status', {
          cli_homes: homes,
        })
        args.setProviderSwitchStatus(res)
      } catch (error) {
        args.flashToast(String(error), 'error')
      }
    },
    [args],
  )

  const refreshUsageStatistics = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true
      if (args.isDevPreview) {
        const now = Date.now()
        args.setUsageStatistics(
          buildDevUsageStatistics(now, args.usageWindowHours, args.usageFilterProviders, args.usageFilterModels),
        )
        return
      }
      if (!silent) args.setUsageStatisticsLoading(true)
      try {
        const res = await invoke<UsageStatistics>('get_usage_statistics', {
          hours: args.usageWindowHours,
          providers: args.usageFilterProviders.length ? args.usageFilterProviders : null,
          models: args.usageFilterModels.length ? args.usageFilterModels : null,
        })
        args.setUsageStatistics(res)
      } catch (error) {
        args.flashToast(String(error), 'error')
      } finally {
        if (!silent) args.setUsageStatisticsLoading(false)
      }
    },
    [args],
  )

  const refreshStatus = useCallback(
    async (options?: { refreshSwapStatus?: boolean }) => {
      const shouldRefreshSwapStatus = options?.refreshSwapStatus ?? true
      if (args.isDevPreview) {
        args.setStatus(args.devStatus)
        if (shouldRefreshSwapStatus) {
          void refreshCodexSwapStatus()
        }
        return
      }
      try {
        const status = await invoke<Status>('get_status')
        args.setStatus(status)
        if (!args.overrideDirtyRef.current) args.setOverride(status.manual_override ?? '')
        if (shouldRefreshSwapStatus) {
          void refreshCodexSwapStatus()
        }
      } catch (error) {
        console.error(error)
      }
    },
    [args, refreshCodexSwapStatus],
  )

  const refreshConfig = useCallback(
    async (options?: { refreshProviderSwitchStatus?: boolean }) => {
      const shouldRefreshProviderSwitchStatus = options?.refreshProviderSwitchStatus ?? true
      if (args.isDevPreview) {
        args.setConfig(args.devConfig)
        args.setBaselineBaseUrls(
          Object.fromEntries(Object.entries(args.devConfig.providers).map(([name, provider]) => [name, provider.base_url])),
        )
        args.setGatewayTokenPreview('ao_dev********7f2a')
        if (shouldRefreshProviderSwitchStatus) {
          void refreshProviderSwitchStatus()
        }
        return
      }
      try {
        const config = await invoke<Config>('get_config')
        args.setConfig(config)
        args.setBaselineBaseUrls(
          Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, provider.base_url])),
        )
        const preview = await invoke<string>('get_gateway_token_preview')
        args.setGatewayTokenPreview(preview)
        const homes = args.resolveCliHomes(
          args.codexSwapDir1Ref.current,
          args.codexSwapDir2Ref.current,
          args.codexSwapApplyBothRef.current,
        )
        if (homes.length > 0 && shouldRefreshProviderSwitchStatus) {
          void refreshProviderSwitchStatus(homes)
        }
      } catch (error) {
        console.error(error)
      }
    },
    [args, refreshProviderSwitchStatus],
  )

  const toggleCodexSwap = useCallback(
    async (cliHomes: string[]) => {
      const homes = cliHomes.map((entry) => entry.trim()).filter(Boolean)
      const res = await invoke<{ ok: boolean; mode: 'swapped' | 'restored'; cli_homes: string[] }>(
        'codex_cli_toggle_auth_config_swap',
        { cli_homes: homes },
      )
      args.flashToast(res.mode === 'swapped' ? 'Swapped Codex auth/config' : 'Restored Codex auth/config')
      await refreshStatus({ refreshSwapStatus: false })
      await Promise.all([
        refreshCodexSwapStatus(homes),
        refreshProviderSwitchStatus(homes),
        refreshConfig({ refreshProviderSwitchStatus: false }),
      ])
    },
    [args, refreshCodexSwapStatus, refreshConfig, refreshProviderSwitchStatus, refreshStatus],
  )

  const setProviderSwitchTarget = useCallback(
    async (target: 'gateway' | 'official' | 'provider', provider?: string) => {
      const homes = args.resolveCliHomes(args.codexSwapDir1, args.codexSwapDir2, args.codexSwapApplyBoth)
      args.setProviderSwitchBusy(true)
      try {
        const res = await invoke<ProviderSwitchboardStatus>('provider_switchboard_set_target', {
          cli_homes: homes,
          target,
          provider: provider ?? null,
        })
        args.setProviderSwitchStatus(res)
        const msg =
          target === 'provider'
            ? `Switched to provider: ${provider}`
            : target === 'gateway'
              ? 'Switched to gateway'
              : 'Switched to official'
        args.flashToast(msg)
        await refreshStatus({ refreshSwapStatus: false })
        await Promise.all([refreshCodexSwapStatus(homes), refreshConfig({ refreshProviderSwitchStatus: false })])
      } catch (error) {
        args.flashToast(String(error), 'error')
      } finally {
        args.setProviderSwitchBusy(false)
      }
    },
    [args, refreshCodexSwapStatus, refreshConfig, refreshStatus],
  )

  const setSessionPreferred = useCallback(
    async (
      sessionId: string,
      provider: string | null,
      setUpdatingSessionPref: Dispatch<SetStateAction<Record<string, boolean>>>,
    ) => {
      setUpdatingSessionPref((map) => ({ ...map, [sessionId]: true }))
      try {
        const row = (args.status?.client_sessions ?? []).find((session) => session.id === sessionId)
        const codexSessionId = row?.codex_session_id ?? null
        if (!codexSessionId) {
          throw new Error('This session has no Codex session id yet. Send one request through the gateway first.')
        }
        if (provider) {
          await invoke('set_session_preferred_provider', { sessionId: codexSessionId, provider })
        } else {
          await invoke('clear_session_preferred_provider', { sessionId: codexSessionId })
        }
        await refreshStatus()
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to set session preference'
        args.flashToast(msg, 'error')
      } finally {
        setUpdatingSessionPref((map) => ({ ...map, [sessionId]: false }))
      }
    },
    [args, refreshStatus],
  )

  return {
    toggleCodexSwap,
    refreshCodexSwapStatus,
    refreshProviderSwitchStatus,
    refreshUsageStatistics,
    refreshStatus,
    refreshConfig,
    setProviderSwitchTarget,
    setSessionPreferred,
  }
}
