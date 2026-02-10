import { useEffect } from "react";

type EffectsArgs = {
  core: {
    activePage: "dashboard" | "usage_statistics" | "provider_switchboard";
    setClearErrorsBeforeMs: (value: number) => void;
    refreshStatus: () => Promise<void>;
    refreshConfig: () => Promise<void>;
    refreshGatewayTokenPreview: () => Promise<void>;
    flashToast: (message: string, level?: "info" | "error") => void;
  };
  usage: {
    refreshUsageStatistics: (options?: { silent?: boolean }) => Promise<void>;
    refreshUsageHistory: (options?: { silent?: boolean }) => Promise<void>;
    usagePricingModalOpen: boolean;
    usageHistoryModalOpen: boolean;
    primeUsagePricingDrafts: () => void;
  };
  switchboard: {
    refreshCodexSwapStatus: () => Promise<void>;
    refreshProviderSwitchStatus: () => Promise<void>;
  };
};

export function useAppEffects({ core, usage, switchboard }: EffectsArgs) {
  const {
    activePage,
    setClearErrorsBeforeMs,
    refreshStatus,
    refreshConfig,
    refreshGatewayTokenPreview,
    flashToast,
  } = core;
  const {
    refreshUsageStatistics,
    refreshUsageHistory,
    usagePricingModalOpen,
    usageHistoryModalOpen,
    primeUsagePricingDrafts,
  } = usage;
  const { refreshCodexSwapStatus, refreshProviderSwitchStatus } = switchboard;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("ao.clearErrorsBeforeMs");
    if (!saved) return;
    const value = Number(saved);
    if (Number.isFinite(value) && value > 0) {
      setClearErrorsBeforeMs(value);
    }
  }, [setClearErrorsBeforeMs]);

  useEffect(() => {
    void (async () => {
      try {
        await refreshConfig();
        await refreshStatus();
        await refreshGatewayTokenPreview();
        await refreshCodexSwapStatus();
        await refreshProviderSwitchStatus();
        await refreshUsageStatistics();
      } catch (error) {
        flashToast(String(error), "error");
      }
    })();
  }, [
    flashToast,
    refreshCodexSwapStatus,
    refreshConfig,
    refreshGatewayTokenPreview,
    refreshProviderSwitchStatus,
    refreshStatus,
    refreshUsageStatistics,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshStatus();
      void refreshProviderSwitchStatus();
      void refreshCodexSwapStatus();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [refreshCodexSwapStatus, refreshProviderSwitchStatus, refreshStatus]);

  useEffect(() => {
    if (activePage !== "usage_statistics") return;
    void refreshUsageStatistics({ silent: true });
  }, [activePage, refreshUsageStatistics]);

  useEffect(() => {
    if (!usagePricingModalOpen) return;
    primeUsagePricingDrafts();
  }, [primeUsagePricingDrafts, usagePricingModalOpen]);

  useEffect(() => {
    if (!usageHistoryModalOpen) return;
    void refreshUsageHistory();
  }, [refreshUsageHistory, usageHistoryModalOpen]);
}
