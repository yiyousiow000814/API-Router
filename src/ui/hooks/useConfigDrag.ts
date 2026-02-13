import { useReorderDrag } from './useReorderDrag'

type Params = {
  orderedConfigProviders: string[]
  applyProviderOrder: (next: string[]) => Promise<void>
  configModalOpen: boolean
}

export function useConfigDrag(params: Params) {
  const { orderedConfigProviders, applyProviderOrder, configModalOpen } = params
  const providerDrag = useReorderDrag<string>({
    items: orderedConfigProviders,
    onReorder: (next) => void applyProviderOrder(next),
    enabled: configModalOpen,
  })
  return {
    providerListRef: providerDrag.listRef,
    registerProviderCardRef: providerDrag.registerItemRef,
    onProviderHandlePointerDown: providerDrag.onHandlePointerDown,
    draggingProvider: providerDrag.draggingId,
    dragOverProvider: providerDrag.dragOverId,
    dragPreviewOrder: providerDrag.dragPreviewOrder,
    dragOffsetY: providerDrag.dragOffsetY,
    dragBaseTop: providerDrag.dragBaseTop,
    dragCardHeight: providerDrag.dragCardHeight,
  }
}
