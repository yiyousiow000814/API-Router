import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'
import { useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Config, Status } from '../types'
import { createProviderCardRenderer } from '../utils/providerCardRenderer'

type Params = {
  setProviderPanelsOpen: Dispatch<SetStateAction<Record<string, boolean>>>
  setEditingProviderName: Dispatch<SetStateAction<string | null>>
  setProviderNameDrafts: Dispatch<SetStateAction<Record<string, string>>>
  providerNameDrafts: Record<string, string>
  refreshConfig: () => Promise<void>
  refreshStatus: () => Promise<void>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
  registerProviderCardRef: (name: string) => (el: HTMLDivElement | null) => void
  dragOverProvider: string | null
  dragOffsetY: number
  dragBaseTop: number
  onProviderHandlePointerDown: (name: string, event: ReactPointerEvent<Element>) => void
  config: Config | null
  status: Status | null
  openProviderGroupManager: (provider: string) => void
  setProviderDisabled: (name: string, disabled: boolean) => Promise<void>
  deleteProvider: (name: string) => Promise<void>
  openProviderBaseUrlModal: (provider: string, current: string) => void
  openProviderAdvancedModal: (provider: string, supportsWebsockets: boolean) => void
  openKeyModal: (provider: string) => Promise<void>
  clearKey: (provider: string) => Promise<void>
  copyProviderFromConfigSource: (sourceNodeId: string, sharedProviderId: string) => Promise<void>
  openUsageBaseModal: (provider: string, current: string | null | undefined) => Promise<void>
  openUsageAuthModal: (provider: string) => Promise<void>
  openProviderEmailModal: (provider: string, current: string | null | undefined) => void
  clearUsageBaseUrl: (provider: string) => Promise<void>
  setProviderQuotaHardCap: (
    provider: string,
    field: 'daily' | 'weekly' | 'monthly',
    enabled: boolean,
  ) => Promise<void>
  editingProviderName: string | null
}

export function useProviderPanelUi(params: Params) {
  const {
    setProviderPanelsOpen,
    setEditingProviderName,
    setProviderNameDrafts,
    providerNameDrafts,
    refreshConfig,
    refreshStatus,
    flashToast,
    registerProviderCardRef,
    dragOverProvider,
    dragOffsetY,
    dragBaseTop,
    onProviderHandlePointerDown,
    config,
    status,
    openProviderGroupManager,
    setProviderDisabled,
    deleteProvider,
    openProviderBaseUrlModal,
    openProviderAdvancedModal,
    openKeyModal,
    clearKey,
    copyProviderFromConfigSource,
    openUsageBaseModal,
    openUsageAuthModal,
    openProviderEmailModal,
    clearUsageBaseUrl,
    setProviderQuotaHardCap,
    editingProviderName,
  } = params

  const beginRename = useCallback((name: string) => {
    setEditingProviderName(name)
    setProviderNameDrafts((prev) => ({ ...prev, [name]: prev[name] ?? name }))
  }, [])

  const commitRename = useCallback(
    async (name: string) => {
      const next = (providerNameDrafts[name] ?? '').trim()
      setEditingProviderName(null)
      if (!next || next === name) {
        setProviderNameDrafts((prev) => ({ ...prev, [name]: name }))
        return
      }
      try {
        await invoke('rename_provider', { oldName: name, newName: next })
        setProviderPanelsOpen((prev) => {
          if (!(name in prev)) return prev
          const { [name]: value, ...rest } = prev
          return { ...rest, [next]: value }
        })
        flashToast(`Renamed: ${name} -> ${next}`)
      } catch (e) {
        flashToast(String(e), 'error')
      }
      await refreshStatus()
      await refreshConfig()
    },
    [providerNameDrafts, refreshConfig, refreshStatus, flashToast],
  )

  const renderProviderCard = useMemo(
    () =>
      createProviderCardRenderer({
        registerProviderCardRef,
        dragOverProvider,
        dragOffsetY,
        dragBaseTop,
        onProviderHandlePointerDown,
        config,
        status,
        openProviderGroupManager,
        setProviderDisabled,
        deleteProvider,
        openProviderBaseUrlModal,
        openProviderAdvancedModal,
        openKeyModal,
        clearKey,
        copyProviderFromConfigSource,
        openUsageBaseModal,
        openUsageAuthModal,
        openProviderEmailModal,
        clearUsageBaseUrl,
        setProviderQuotaHardCap,
        beginRenameProvider: beginRename,
        commitRenameProvider: commitRename,
        editingProviderName,
        providerNameDrafts,
        setProviderNameDrafts,
        setEditingProviderName,
      }),
    [
      registerProviderCardRef,
      dragOverProvider,
      dragOffsetY,
      dragBaseTop,
      onProviderHandlePointerDown,
      config,
      status,
      openProviderGroupManager,
      setProviderDisabled,
      deleteProvider,
      openProviderBaseUrlModal,
      openProviderAdvancedModal,
      openKeyModal,
      clearKey,
      copyProviderFromConfigSource,
      openUsageBaseModal,
      openUsageAuthModal,
      openProviderEmailModal,
      clearUsageBaseUrl,
      setProviderQuotaHardCap,
      beginRename,
      commitRename,
      editingProviderName,
      providerNameDrafts,
      setProviderNameDrafts,
      setEditingProviderName,
    ],
  )

  return {
    renderProviderCard,
  }
}
