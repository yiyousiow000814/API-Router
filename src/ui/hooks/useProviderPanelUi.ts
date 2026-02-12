import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'
import { useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Config, Status } from '../types'
import { createProviderCardRenderer } from '../utils/providerCardRenderer'

type Params = {
  orderedConfigProviders: string[]
  providerPanelsOpen: Record<string, boolean>
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
  setConfig: Dispatch<SetStateAction<Config | null>>
  baselineBaseUrls: Record<string, string>
  saveProvider: (name: string) => Promise<void>
  deleteProvider: (name: string) => Promise<void>
  openKeyModal: (provider: string) => Promise<void>
  clearKey: (provider: string) => Promise<void>
  openUsageBaseModal: (provider: string, current: string | null | undefined) => Promise<void>
  clearUsageBaseUrl: (provider: string) => Promise<void>
  editingProviderName: string | null
}

export function useProviderPanelUi(params: Params) {
  const {
    orderedConfigProviders,
    providerPanelsOpen,
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
    setConfig,
    baselineBaseUrls,
    saveProvider,
    deleteProvider,
    openKeyModal,
    clearKey,
    openUsageBaseModal,
    clearUsageBaseUrl,
    editingProviderName,
  } = params

  const setAllProviderPanels = useCallback((open: boolean) => {
    setProviderPanelsOpen((prev) => {
      const next: Record<string, boolean> = { ...prev }
      for (const name of orderedConfigProviders) {
        next[name] = open
      }
      return next
    })
  }, [orderedConfigProviders])

  const allProviderPanelsOpen = useMemo(
    () => orderedConfigProviders.every((name: string) => providerPanelsOpen[name] ?? true),
    [orderedConfigProviders, providerPanelsOpen],
  )

  const isProviderOpen = useCallback(
    (name: string) => providerPanelsOpen[name] ?? true,
    [providerPanelsOpen],
  )

  const toggleProviderOpen = useCallback((name: string) => {
    setProviderPanelsOpen((prev) => ({ ...prev, [name]: !(prev[name] ?? true) }))
  }, [])

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
    [providerNameDrafts, refreshConfig, refreshStatus],
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
        setConfig,
        baselineBaseUrls,
        saveProvider,
        deleteProvider,
        openKeyModal,
        clearKey,
        openUsageBaseModal,
        clearUsageBaseUrl,
        isProviderOpen,
        toggleProviderOpen,
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
      setConfig,
      baselineBaseUrls,
      saveProvider,
      deleteProvider,
      openKeyModal,
      clearKey,
      openUsageBaseModal,
      clearUsageBaseUrl,
      isProviderOpen,
      toggleProviderOpen,
      beginRename,
      commitRename,
      editingProviderName,
      providerNameDrafts,
      setProviderNameDrafts,
      setEditingProviderName,
    ],
  )

  return {
    setAllProviderPanels,
    allProviderPanelsOpen,
    renderProviderCard,
  }
}
