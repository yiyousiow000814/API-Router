import type { Dispatch, SetStateAction } from 'react'
import type { Config, Status } from '../../types'

export type KeyModalState = {
  open: boolean
  provider: string
  value: string
  storage: 'auth_json' | 'config_toml_experimental_bearer_token'
  loading: boolean
  loadFailed: boolean
}

export type UsageBaseModalState = {
  open: boolean
  provider: string
  baseUrl: string
  showUrlInput: boolean
  value: string
  auto: boolean
  explicitValue: string
  effectiveValue: string
  token: string
  username: string
  password: string
  loading: boolean
  loadFailed: boolean
}

export type UsageAuthModalState = {
  open: boolean
  provider: string
  baseUrl: string
  token: string
  username: string
  password: string
  loading: boolean
  loadFailed: boolean
}

export type ProviderEmailModalState = {
  open: boolean
  provider: string
  value: string
}

export type ProviderBaseUrlModalState = {
  open: boolean
  provider: string
  value: string
}

export type ProviderAdvancedModalState = {
  open: boolean
  provider: string
  supportsWebsockets: boolean
}

export type UseProviderActionsParams = {
  config: Config | null
  status: Status | null
  setStatus: Dispatch<SetStateAction<Status | null>>
  isDevPreview: boolean
  setConfig: Dispatch<SetStateAction<Config | null>>
  keyModal: KeyModalState
  usageBaseModal: UsageBaseModalState
  usageAuthModal: UsageAuthModalState
  providerEmailModal: ProviderEmailModalState
  providerBaseUrlModal: ProviderBaseUrlModalState
  providerAdvancedModal: ProviderAdvancedModalState
  newProviderName: string
  newProviderBaseUrl: string
  newProviderKey: string
  newProviderKeyStorage: 'auth_json' | 'config_toml_experimental_bearer_token'
  setKeyModal: Dispatch<SetStateAction<KeyModalState>>
  setUsageBaseModal: Dispatch<SetStateAction<UsageBaseModalState>>
  setUsageAuthModal: Dispatch<SetStateAction<UsageAuthModalState>>
  setProviderEmailModal: Dispatch<SetStateAction<ProviderEmailModalState>>
  setProviderBaseUrlModal: Dispatch<SetStateAction<ProviderBaseUrlModalState>>
  setProviderAdvancedModal: Dispatch<SetStateAction<ProviderAdvancedModalState>>
  setNewProviderName: Dispatch<SetStateAction<string>>
  setNewProviderBaseUrl: Dispatch<SetStateAction<string>>
  setNewProviderKey: Dispatch<SetStateAction<string>>
  setNewProviderKeyStorage: Dispatch<SetStateAction<'auth_json' | 'config_toml_experimental_bearer_token'>>
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
  setProviderGroup: (name: string, group: string | null) => Promise<void>
  setProvidersGroup: (providers: string[], group: string | null) => Promise<void>
  setProviderDisabled: (name: string, disabled: boolean) => Promise<void>
  deleteProvider: (name: string) => Promise<void>
  saveKey: () => Promise<void>
  clearKey: (name: string) => Promise<void>
  refreshQuota: (name: string) => Promise<void>
  refreshQuotaAll: (opts?: RefreshQuotaOptions) => Promise<void>
  saveUsageBaseUrl: () => Promise<void>
  saveUsageAuth: () => Promise<void>
  clearUsageAuth: (provider: string) => Promise<void>
  saveProviderEmail: () => Promise<void>
  clearProviderEmail: (provider: string) => Promise<void>
  saveProviderBaseUrl: () => Promise<void>
  saveProviderAdvanced: () => Promise<void>
  setUsageBaseUrl: (provider: string, url: string) => Promise<void>
  clearUsageBaseUrl: (name: string) => Promise<void>
  setProviderQuotaHardCap: (
    provider: string,
    field: 'daily' | 'weekly' | 'monthly',
    enabled: boolean,
  ) => Promise<void>
  openKeyModal: (provider: string) => Promise<void>
  openProviderBaseUrlModal: (provider: string, current: string) => void
  openProviderAdvancedModal: (provider: string, supportsWebsockets: boolean) => void
  openUsageBaseModal: (
    provider: string,
    current: string | null | undefined,
    options?: { showUrlInput?: boolean },
  ) => Promise<void>
  openUsageAuthModal: (provider: string) => Promise<void>
  openProviderEmailModal: (provider: string, current: string | null | undefined) => void
  addProvider: () => Promise<void>
}
