import { useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'

import type { Config, Status } from '../types'
import { ConfigProviderCard } from '../components/ConfigProviderCard'
import { fmtWhen } from '../utils/format'

type Args = {
  config: Config | null
  status: Status | null
  orderedConfigProviders: string[]
  providerPanelsOpen: Record<string, boolean>
  setProviderPanelsOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  editingProviderName: string | null
  setEditingProviderName: React.Dispatch<React.SetStateAction<string | null>>
  providerNameDrafts: Record<string, string>
  setProviderNameDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>
  baselineBaseUrls: Record<string, string>
  dragOverProvider: string | null
  dragBaseTop: number
  dragOffsetY: number
  registerProviderCardRef: (id: string) => (element: HTMLDivElement | null) => void
  onProviderHandlePointerDown: (id: string, event: React.PointerEvent<Element>) => void
  saveProvider: (name: string) => Promise<void>
  openKeyModal: (provider: string) => Promise<void>
  clearKey: (name: string) => Promise<void>
  deleteProvider: (name: string) => Promise<void>
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>
  openUsageBaseModal: (provider: string, current: string | null | undefined) => Promise<void>
  clearUsageBaseUrl: (name: string) => Promise<void>
  refreshStatus: () => Promise<void>
  refreshConfig: () => Promise<void>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
}

export function useProviderCards(args: Args) {
  const isProviderOpen = useCallback(
    (name: string) => args.providerPanelsOpen[name] ?? true,
    [args.providerPanelsOpen],
  )

  const toggleProviderOpen = useCallback((name: string) => {
    args.setProviderPanelsOpen((prev) => ({ ...prev, [name]: !(prev[name] ?? true) }))
  }, [args])

  const setAllProviderPanels = useCallback(
    (open: boolean) => {
      args.setProviderPanelsOpen((prev) => {
        const next: Record<string, boolean> = { ...prev }
        for (const name of args.orderedConfigProviders) {
          next[name] = open
        }
        return next
      })
    },
    [args],
  )

  const allProviderPanelsOpen = useMemo(
    () => args.orderedConfigProviders.every((name) => args.providerPanelsOpen[name] ?? true),
    [args.orderedConfigProviders, args.providerPanelsOpen],
  )

  const beginRenameProvider = useCallback((name: string) => {
    args.setEditingProviderName(name)
    args.setProviderNameDrafts((prev) => ({ ...prev, [name]: prev[name] ?? name }))
  }, [args])

  const commitRenameProvider = useCallback(
    async (name: string) => {
      const next = (args.providerNameDrafts[name] ?? '').trim()
      args.setEditingProviderName(null)
      if (!next || next === name) {
        args.setProviderNameDrafts((prev) => ({ ...prev, [name]: name }))
        return
      }
      try {
        await invoke('rename_provider', { oldName: name, newName: next })
        args.setProviderPanelsOpen((prev) => {
          if (!(name in prev)) return prev
          const { [name]: value, ...rest } = prev
          return { ...rest, [next]: value }
        })
        args.flashToast(`Renamed: ${name} -> ${next}`)
      } catch (error) {
        args.flashToast(String(error), 'error')
      }
      await args.refreshStatus()
      await args.refreshConfig()
    },
    [args],
  )

  const renderProviderCard = useCallback(
    (name: string, overlay = false) => {
      const provider = args.config?.providers?.[name]
      if (!provider) return null
      return (
        <ConfigProviderCard
          name={name}
          overlay={overlay}
          provider={provider}
          baselineBaseUrl={args.baselineBaseUrls[name] ?? ''}
          isDragOver={args.dragOverProvider === name}
          dragBaseTop={args.dragBaseTop}
          dragOffsetY={args.dragOffsetY}
          isOpen={isProviderOpen(name)}
          editingProviderName={args.editingProviderName}
          providerNameDraft={args.providerNameDrafts[name] ?? name}
          quotaUpdatedAtUnixMs={args.status?.quota?.[name]?.updated_at_unix_ms}
          quotaLastError={args.status?.quota?.[name]?.last_error}
          registerProviderCardRef={args.registerProviderCardRef}
          onProviderHandlePointerDown={args.onProviderHandlePointerDown}
          onSetProviderNameDraft={(providerName, value) =>
            args.setProviderNameDrafts((previous) => ({ ...previous, [providerName]: value }))
          }
          onCommitRenameProvider={commitRenameProvider}
          onBeginRenameProvider={beginRenameProvider}
          onCancelRenameProvider={(providerName) => {
            args.setEditingProviderName(null)
            args.setProviderNameDrafts((previous) => ({ ...previous, [providerName]: providerName }))
          }}
          onSaveProvider={args.saveProvider}
          onOpenKeyModal={args.openKeyModal}
          onClearKey={args.clearKey}
          onDeleteProvider={args.deleteProvider}
          onSetProviderBaseUrl={(providerName, value) =>
            args.setConfig((current) =>
              current
                ? {
                    ...current,
                    providers: {
                      ...current.providers,
                      [providerName]: { ...current.providers[providerName], base_url: value },
                    },
                  }
                : current,
            )
          }
          onToggleProviderOpen={toggleProviderOpen}
          onOpenUsageBaseModal={args.openUsageBaseModal}
          onClearUsageBaseUrl={args.clearUsageBaseUrl}
          fmtWhen={fmtWhen}
        />
      )
    },
    [args, beginRenameProvider, commitRenameProvider, isProviderOpen, toggleProviderOpen],
  )

  return {
    isProviderOpen,
    toggleProviderOpen,
    setAllProviderPanels,
    allProviderPanelsOpen,
    beginRenameProvider,
    commitRenameProvider,
    renderProviderCard,
  }
}
