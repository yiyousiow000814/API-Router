import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Config, Status } from '../types'
import { createProviderCardRenderer } from '../utils/providerCardRenderer'
import type { ProviderWsTooltipState } from '../components/ProviderWsTooltipPortal'

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
  setProviderSupportsWebsockets: (provider: string, enabled: boolean) => Promise<void>
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
  const [providerCapsMenuOpen, setProviderCapsMenuOpen] = useState<string | null>(null)
  const [providerWsTooltip, setProviderWsTooltip] = useState<ProviderWsTooltipState>(null)
  const providerCapsMenuRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const providerWsTooltipAnchorRef = useRef<HTMLButtonElement | null>(null)
  const providerWsTooltipTextRef = useRef<string>('')
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
    setProviderSupportsWebsockets,
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

  useEffect(() => {
    if (!providerCapsMenuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const wrap = providerCapsMenuRefs.current[providerCapsMenuOpen]
      if (wrap && event.target instanceof Node && !wrap.contains(event.target)) {
        setProviderCapsMenuOpen(null)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProviderCapsMenuOpen(null)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [providerCapsMenuOpen])

  const updateProviderWsTooltipPosition = useCallback(() => {
    const anchor = providerWsTooltipAnchorRef.current
    const text = providerWsTooltipTextRef.current
    if (!anchor || !text) {
      setProviderWsTooltip(null)
      return
    }
    const rect = anchor.getBoundingClientRect()
    setProviderWsTooltip({
      text,
      left: rect.left + rect.width / 2,
      top: rect.top - 8,
    })
  }, [])

  const showProviderWsTooltip = useCallback(
    (text: string, anchor: HTMLButtonElement) => {
      providerWsTooltipAnchorRef.current = anchor
      providerWsTooltipTextRef.current = text
      updateProviderWsTooltipPosition()
    },
    [updateProviderWsTooltipPosition],
  )

  const hideProviderWsTooltip = useCallback(() => {
    providerWsTooltipAnchorRef.current = null
    providerWsTooltipTextRef.current = ''
    setProviderWsTooltip(null)
  }, [])

  useEffect(() => {
    if (!providerWsTooltipAnchorRef.current) return

    const handleViewportChange = () => {
      updateProviderWsTooltipPosition()
    }

    window.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)
    return () => {
      window.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
    }
  }, [providerWsTooltip, updateProviderWsTooltipPosition])

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
        setProviderSupportsWebsockets,
        openKeyModal,
        clearKey,
        copyProviderFromConfigSource,
        openUsageBaseModal,
        openUsageAuthModal,
        openProviderEmailModal,
        clearUsageBaseUrl,
        setProviderQuotaHardCap,
        showProviderWsTooltip,
        hideProviderWsTooltip,
        openProviderCapsMenu: providerCapsMenuOpen,
        setOpenProviderCapsMenu: setProviderCapsMenuOpen,
        registerProviderCapsMenuRef: (name) => (el) => {
          providerCapsMenuRefs.current[name] = el
        },
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
      setProviderSupportsWebsockets,
      openKeyModal,
      clearKey,
      copyProviderFromConfigSource,
      openUsageBaseModal,
      openUsageAuthModal,
      openProviderEmailModal,
      clearUsageBaseUrl,
      setProviderQuotaHardCap,
      showProviderWsTooltip,
      hideProviderWsTooltip,
      providerCapsMenuOpen,
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
    providerWsTooltip,
  }
}
