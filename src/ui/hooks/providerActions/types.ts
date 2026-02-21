import type { Dispatch, SetStateAction } from 'react'
import type { Config, Status } from '../../types'

export type KeyModalState = {
  open: boolean
  provider: string
  value: string
}

export type UsageBaseModalState = {
  open: boolean
  provider: string
  value: string
  auto: boolean
  explicitValue: string
  effectiveValue: string
}

export type UseProviderActionsParams = {
  config: Config | null
  status: Status | null
  isDevPreview: boolean
  setConfig: Dispatch<SetStateAction<Config | null>>
  keyModal: KeyModalState
  usageBaseModal: UsageBaseModalState
  newProviderName: string
  newProviderBaseUrl: string
  setKeyModal: Dispatch<SetStateAction<KeyModalState>>
  setUsageBaseModal: Dispatch<SetStateAction<UsageBaseModalState>>
  setNewProviderName: Dispatch<SetStateAction<string>>
  setNewProviderBaseUrl: Dispatch<SetStateAction<string>>
  setRefreshingProviders: Dispatch<SetStateAction<Record<string, boolean>>>
  refreshStatus: (options?: { refreshSwapStatus?: boolean }) => Promise<void>
  refreshConfig: (options?: { refreshProviderSwitchStatus?: boolean }) => Promise<void>
  flashToast: (msg: string, kind?: 'info' | 'error') => void
}

export type RefreshQuotaOptions = {
  silent?: boolean
}

export type UseProviderActionsResult = {
  saveProvider: (name: string) => Promise<void>
  setProviderDisabled: (name: string, disabled: boolean) => Promise<void>
  deleteProvider: (name: string) => Promise<void>
  saveKey: () => Promise<void>
  clearKey: (name: string) => Promise<void>
  refreshQuota: (name: string) => Promise<void>
  refreshQuotaAll: (opts?: RefreshQuotaOptions) => Promise<void>
  saveUsageBaseUrl: () => Promise<void>
  clearUsageBaseUrl: (name: string) => Promise<void>
  openKeyModal: (provider: string) => Promise<void>
  openUsageBaseModal: (provider: string, current: string | null | undefined) => Promise<void>
  addProvider: () => Promise<void>
}
