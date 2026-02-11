import type { ReactNode, RefObject } from 'react'

import type { Config } from '../types'
import { ConfigModal } from './ConfigModal'
import { GatewayTokenModal } from './GatewayTokenModal'
import { InstructionModal } from './InstructionModal'
import { KeyModal } from './KeyModal'
import { UsageBaseModal } from './UsageBaseModal'

type KeyModalState = {
  open: boolean
  provider: string
  value: string
}

type UsageBaseModalState = {
  open: boolean
  provider: string
  value: string
  auto: boolean
  explicitValue: string
  effectiveValue: string
}

type Props = {
  keyModal: KeyModalState
  usageBaseModal: UsageBaseModalState
  instructionModalOpen: boolean
  configModalOpen: boolean
  gatewayModalOpen: boolean
  gatewayTokenPreview: string
  gatewayTokenReveal: string
  config: Config | null
  allProviderPanelsOpen: boolean
  newProviderName: string
  newProviderBaseUrl: string
  nextProviderPlaceholder: string
  providerListRef: RefObject<HTMLDivElement | null>
  orderedConfigProviders: string[]
  dragPreviewOrder: string[] | null
  draggingProvider: string | null
  dragCardHeight: number
  setKeyModal: (next: KeyModalState | ((prev: KeyModalState) => KeyModalState)) => void
  setUsageBaseModal: (
    next: UsageBaseModalState | ((prev: UsageBaseModalState) => UsageBaseModalState),
  ) => void
  setInstructionModalOpen: (open: boolean) => void
  setConfigModalOpen: (open: boolean) => void
  setGatewayModalOpen: (open: boolean) => void
  setGatewayTokenReveal: (token: string) => void
  setAllProviderPanels: (open: boolean) => void
  setNewProviderName: (name: string) => void
  setNewProviderBaseUrl: (url: string) => void
  onSaveKey: () => Promise<void>
  onClearUsageBaseUrl: (provider: string) => Promise<void>
  onSaveUsageBaseUrl: () => Promise<void>
  onAddProvider: () => Promise<void>
  renderProviderCard: (providerName: string) => ReactNode
  onGatewayReveal: () => Promise<void>
  onGatewayRotate: () => Promise<void>
}

export function AppCoreModals({
  keyModal,
  usageBaseModal,
  instructionModalOpen,
  configModalOpen,
  gatewayModalOpen,
  gatewayTokenPreview,
  gatewayTokenReveal,
  config,
  allProviderPanelsOpen,
  newProviderName,
  newProviderBaseUrl,
  nextProviderPlaceholder,
  providerListRef,
  orderedConfigProviders,
  dragPreviewOrder,
  draggingProvider,
  dragCardHeight,
  setKeyModal,
  setUsageBaseModal,
  setInstructionModalOpen,
  setConfigModalOpen,
  setGatewayModalOpen,
  setGatewayTokenReveal,
  setAllProviderPanels,
  setNewProviderName,
  setNewProviderBaseUrl,
  onSaveKey,
  onClearUsageBaseUrl,
  onSaveUsageBaseUrl,
  onAddProvider,
  renderProviderCard,
  onGatewayReveal,
  onGatewayRotate,
}: Props) {
  return (
    <>
      <KeyModal
        open={keyModal.open}
        provider={keyModal.provider}
        value={keyModal.value}
        onChange={(value) => setKeyModal((m) => ({ ...m, value }))}
        onCancel={() => setKeyModal({ open: false, provider: '', value: '' })}
        onSave={() => void onSaveKey()}
      />

      <UsageBaseModal
        open={usageBaseModal.open}
        provider={usageBaseModal.provider}
        value={usageBaseModal.value}
        explicitValue={usageBaseModal.explicitValue}
        onChange={(value) =>
          setUsageBaseModal((m) => ({
            ...m,
            value,
            auto: false,
            explicitValue: value,
          }))
        }
        onCancel={() =>
          setUsageBaseModal({
            open: false,
            provider: '',
            value: '',
            auto: false,
            explicitValue: '',
            effectiveValue: '',
          })
        }
        onClear={() => void onClearUsageBaseUrl(usageBaseModal.provider)}
        onSave={() => void onSaveUsageBaseUrl()}
      />

      <InstructionModal
        open={instructionModalOpen}
        onClose={() => setInstructionModalOpen(false)}
        codeText={`model_provider = "api_router"

[model_providers.api_router]
name = "API Router"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true`}
      />

      <ConfigModal
        open={configModalOpen}
        config={config}
        allProviderPanelsOpen={allProviderPanelsOpen}
        setAllProviderPanels={setAllProviderPanels}
        newProviderName={newProviderName}
        newProviderBaseUrl={newProviderBaseUrl}
        nextProviderPlaceholder={nextProviderPlaceholder}
        setNewProviderName={setNewProviderName}
        setNewProviderBaseUrl={setNewProviderBaseUrl}
        onAddProvider={() => void onAddProvider()}
        onClose={() => setConfigModalOpen(false)}
        providerListRef={providerListRef}
        orderedConfigProviders={orderedConfigProviders}
        dragPreviewOrder={dragPreviewOrder}
        draggingProvider={draggingProvider}
        dragCardHeight={dragCardHeight}
        renderProviderCard={renderProviderCard}
      />

      <GatewayTokenModal
        open={gatewayModalOpen}
        tokenPreview={gatewayTokenPreview}
        tokenReveal={gatewayTokenReveal}
        onClose={() => {
          setGatewayModalOpen(false)
          setGatewayTokenReveal('')
        }}
        onReveal={onGatewayReveal}
        onRotate={onGatewayRotate}
      />
    </>
  )
}
