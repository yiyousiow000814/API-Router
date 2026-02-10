import { useAppEffects } from "./appEffects";
import { useAppState } from "./appState";
import { useAppSwitchboard } from "./appSwitchboard";
import { useAppUsage } from "./appUsage";

export function useAppViewModel() {
  const core = useAppState();

  const usage = useAppUsage({
    config: core.config,
    flashToast: core.flashToast,
    refreshConfig: core.refreshConfig,
  });

  const switchboard = useAppSwitchboard({
    config: core.config,
    status: core.status,
    providers: core.providers,
    flashToast: core.flashToast,
    refreshStatus: core.refreshStatus,
    codexSwapDir1: core.codexSwapDir1,
    setCodexSwapDir1: core.setCodexSwapDir1,
    codexSwapDir2: core.codexSwapDir2,
    setCodexSwapDir2: core.setCodexSwapDir2,
    codexSwapApplyBoth: core.codexSwapApplyBoth,
    setCodexSwapApplyBoth: core.setCodexSwapApplyBoth,
  });

  useAppEffects({
    core: {
      activePage: core.activePage,
      setClearErrorsBeforeMs: core.setClearErrorsBeforeMs,
      refreshStatus: core.refreshStatus,
      refreshConfig: core.refreshConfig,
      refreshGatewayTokenPreview: core.refreshGatewayTokenPreview,
      flashToast: core.flashToast,
    },
    usage: {
      refreshUsageStatistics: usage.refreshUsageStatistics,
      refreshUsageHistory: usage.refreshUsageHistory,
      usagePricingModalOpen: usage.usagePricingModalOpen,
      usageHistoryModalOpen: usage.usageHistoryModalOpen,
      primeUsagePricingDrafts: usage.primeUsagePricingDrafts,
    },
    switchboard: {
      refreshCodexSwapStatus: switchboard.refreshCodexSwapStatus,
      refreshProviderSwitchStatus: switchboard.refreshProviderSwitchStatus,
    },
  });

  return {
    ...core,
    ...usage,
    ...switchboard,
  };
}

export type AppViewModel = ReturnType<typeof useAppViewModel>;
