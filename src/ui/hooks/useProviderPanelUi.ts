import { useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createProviderCardRenderer } from '../utils/providerCardRenderer'

type Params = Record<string, any>

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
    setProviderPanelsOpen((prev: Record<string, boolean>) => {
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
    setProviderPanelsOpen((prev: Record<string, boolean>) => ({ ...prev, [name]: !(prev[name] ?? true) }))
  }, [])

  const beginRename = useCallback((name: string) => {
    setEditingProviderName(name)
    setProviderNameDrafts((prev: Record<string, string>) => ({ ...prev, [name]: prev[name] ?? name }))
  }, [])

  const commitRename = useCallback(
    async (name: string) => {
      const next = (providerNameDrafts[name] ?? '').trim()
      setEditingProviderName(null)
      if (!next || next === name) {
        setProviderNameDrafts((prev: Record<string, string>) => ({ ...prev, [name]: name }))
        return
      }
      try {
        await invoke('rename_provider', { oldName: name, newName: next })
        setProviderPanelsOpen((prev: Record<string, boolean>) => {
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
