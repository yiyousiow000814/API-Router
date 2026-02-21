import { useProviderCrudActions } from './providerActions/useProviderCrudActions'
import { useProviderKeyActions } from './providerActions/useProviderKeyActions'
import { useProviderUsageActions } from './providerActions/useProviderUsageActions'
import type { UseProviderActionsParams, UseProviderActionsResult } from './providerActions/types'

export function useProviderActions({
  config,
  status,
  isDevPreview,
  setConfig,
  keyModal,
  usageBaseModal,
  newProviderName,
  newProviderBaseUrl,
  setKeyModal,
  setUsageBaseModal,
  setNewProviderName,
  setNewProviderBaseUrl,
  setRefreshingProviders,
  refreshStatus,
  refreshConfig,
  flashToast,
}: UseProviderActionsParams): UseProviderActionsResult {
  const { saveProvider, setProviderDisabled, deleteProvider, addProvider } = useProviderCrudActions({
    config,
    isDevPreview,
    setConfig,
    newProviderName,
    newProviderBaseUrl,
    setNewProviderName,
    setNewProviderBaseUrl,
    refreshStatus,
    refreshConfig,
    flashToast,
  })

  const { saveKey, clearKey, openKeyModal } = useProviderKeyActions({
    keyModal,
    isDevPreview,
    setKeyModal,
    refreshStatus,
    refreshConfig,
    flashToast,
  })

  const {
    refreshQuota,
    refreshQuotaAll,
    saveUsageBaseUrl,
    clearUsageBaseUrl,
    openUsageBaseModal,
  } = useProviderUsageActions({
    status,
    isDevPreview,
    usageBaseModal,
    setUsageBaseModal,
    setRefreshingProviders,
    refreshStatus,
    refreshConfig,
    flashToast,
  })

  return {
    saveProvider,
    setProviderDisabled,
    deleteProvider,
    saveKey,
    clearKey,
    refreshQuota,
    refreshQuotaAll,
    saveUsageBaseUrl,
    clearUsageBaseUrl,
    openKeyModal,
    openUsageBaseModal,
    addProvider,
  }
}
