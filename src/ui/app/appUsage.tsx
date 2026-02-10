import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo, useState } from "react";
import type { UsageStatistics } from "../types";
import type {
  SpendHistoryRow,
  UsagePricingDraft,
  UsagePricingMode,
  UsagePricingSaveState,
  UsageScheduleDraft,
  UsageScheduleSaveState,
} from "./appTypes";

type UsageArgs = {
  config: {
    providers: Record<
      string,
      {
        manual_pricing_mode?: "per_request" | "package_total" | null;
        manual_pricing_amount_usd?: number | null;
      }
    >;
  } | null;
  flashToast: (message: string, level?: "info" | "error") => void;
  refreshConfig: () => Promise<void>;
};

function toDateTimeLocalValue(unixMs?: number | null): string {
  if (!unixMs || !Number.isFinite(unixMs) || unixMs <= 0) return "";
  const date = new Date(unixMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function fromDateTimeLocalValue(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  const unixMs = Date.parse(value);
  if (!Number.isFinite(unixMs) || unixMs <= 0) return null;
  return unixMs;
}

function parsePositiveAmount(text: string): number | null {
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function buildPricingDraft(
  mode: UsagePricingMode | null | undefined,
  amountUsd: number | null | undefined,
): UsagePricingDraft {
  return {
    mode: mode ?? "none",
    amountText: amountUsd && amountUsd > 0 ? String(amountUsd) : "",
  };
}

export function useAppUsage({ config, flashToast, refreshConfig }: UsageArgs) {
  const [usageStatistics, setUsageStatistics] =
    useState<UsageStatistics | null>(null);
  const [usageWindowHours, setUsageWindowHours] = useState<number>(24);
  const [usageFilterProviders, setUsageFilterProviders] = useState<string[]>(
    [],
  );
  const [usageFilterModels, setUsageFilterModels] = useState<string[]>([]);
  const [usageStatisticsLoading, setUsageStatisticsLoading] =
    useState<boolean>(false);

  const [usagePricingModalOpen, setUsagePricingModalOpen] =
    useState<boolean>(false);
  const [usagePricingDrafts, setUsagePricingDrafts] = useState<
    Record<string, UsagePricingDraft>
  >({});
  const [usagePricingSaveState, setUsagePricingSaveState] = useState<
    Record<string, UsagePricingSaveState>
  >({});

  const [usageHistoryModalOpen, setUsageHistoryModalOpen] =
    useState<boolean>(false);
  const [usageHistoryRows, setUsageHistoryRows] = useState<SpendHistoryRow[]>(
    [],
  );
  const [usageHistoryLoading, setUsageHistoryLoading] =
    useState<boolean>(false);

  const [usageScheduleModalOpen, setUsageScheduleModalOpen] =
    useState<boolean>(false);
  const [usageScheduleProvider, setUsageScheduleProvider] =
    useState<string>("");
  const [usageScheduleRows, setUsageScheduleRows] = useState<
    UsageScheduleDraft[]
  >([]);
  const [usageScheduleLoading, setUsageScheduleLoading] =
    useState<boolean>(false);
  const [usageScheduleSaveState, setUsageScheduleSaveState] =
    useState<UsageScheduleSaveState>("idle");

  const usageSummary = useMemo(
    () => usageStatistics?.summary ?? null,
    [usageStatistics],
  );
  const usageByModel = useMemo(
    () => usageSummary?.by_model ?? [],
    [usageSummary],
  );
  const usageByProvider = useMemo(
    () => usageSummary?.by_provider ?? [],
    [usageSummary],
  );
  const usageTimeline = useMemo(
    () => usageSummary?.timeline ?? [],
    [usageSummary],
  );

  const usageProviderFilterOptions = useMemo(
    () =>
      usageStatistics?.catalog?.providers ??
      usageByProvider.map((row) => row.provider),
    [usageByProvider, usageStatistics],
  );

  const usageModelFilterOptions = useMemo(
    () =>
      usageStatistics?.catalog?.models ?? usageByModel.map((row) => row.model),
    [usageByModel, usageStatistics],
  );

  const usageScheduleProviderOptions = useMemo(() => {
    return usageByProvider.map((row) => row.provider);
  }, [usageByProvider]);

  const toggleUsageProviderFilter = useCallback((providerName: string) => {
    setUsageFilterProviders((prev) =>
      prev.includes(providerName)
        ? prev.filter((name) => name !== providerName)
        : [...prev, providerName],
    );
  }, []);

  const toggleUsageModelFilter = useCallback((modelName: string) => {
    setUsageFilterModels((prev) =>
      prev.includes(modelName)
        ? prev.filter((name) => name !== modelName)
        : [...prev, modelName],
    );
  }, []);

  const refreshUsageStatistics = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) setUsageStatisticsLoading(true);
      try {
        const result = await invoke<UsageStatistics>("get_usage_statistics", {
          hours: usageWindowHours,
          providers: usageFilterProviders.length ? usageFilterProviders : null,
          models: usageFilterModels.length ? usageFilterModels : null,
        });
        setUsageStatistics(result);
      } catch (error) {
        flashToast(String(error), "error");
      } finally {
        if (!silent) setUsageStatisticsLoading(false);
      }
    },
    [flashToast, usageFilterModels, usageFilterProviders, usageWindowHours],
  );

  const primeUsagePricingDrafts = useCallback(() => {
    if (!config) return;
    const next: Record<string, UsagePricingDraft> = {};
    Object.entries(config.providers).forEach(([providerName, provider]) => {
      next[providerName] = buildPricingDraft(
        provider.manual_pricing_mode,
        provider.manual_pricing_amount_usd,
      );
    });
    setUsagePricingDrafts(next);
  }, [config]);

  const saveUsagePricingRow = useCallback(
    async (providerName: string) => {
      const draft = usagePricingDrafts[providerName];
      if (!draft) return;
      const mode = draft.mode;
      const amount = parsePositiveAmount(draft.amountText);
      if (mode !== "none" && amount == null) {
        flashToast(`Invalid amount for ${providerName}`, "error");
        return;
      }

      setUsagePricingSaveState((prev) => ({
        ...prev,
        [providerName]: "saving",
      }));
      try {
        await invoke("set_provider_manual_pricing", {
          provider: providerName,
          mode: mode === "none" ? null : mode,
          amountUsd: mode === "none" ? null : amount,
        });
        await invoke("set_provider_gap_fill", {
          provider: providerName,
          mode: "per_day_average",
          amountUsd: null,
        });
        setUsagePricingSaveState((prev) => ({
          ...prev,
          [providerName]: "saved",
        }));
        flashToast(`Saved pricing for ${providerName}`);
        await refreshConfig();
      } catch (error) {
        setUsagePricingSaveState((prev) => ({
          ...prev,
          [providerName]: "error",
        }));
        flashToast(String(error), "error");
      }
    },
    [flashToast, refreshConfig, usagePricingDrafts],
  );

  const refreshUsageHistory = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) setUsageHistoryLoading(true);
      try {
        const result = await invoke<{ ok: boolean; rows: SpendHistoryRow[] }>(
          "get_spend_history",
          { days: 180 },
        );
        setUsageHistoryRows(result.rows ?? []);
      } catch (error) {
        flashToast(String(error), "error");
      } finally {
        if (!silent) setUsageHistoryLoading(false);
      }
    },
    [flashToast],
  );

  const clearUsageHistoryRow = useCallback(
    async (provider: string, dayKey: string) => {
      try {
        await invoke("set_spend_history_entry", {
          provider,
          dayKey,
          totalUsedUsd: null,
          usdPerReq: null,
        });
        await refreshUsageHistory({ silent: true });
        await refreshUsageStatistics({ silent: true });
        flashToast(`Cleared history for ${provider} ${dayKey}`);
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [flashToast, refreshUsageHistory, refreshUsageStatistics],
  );

  const openUsageScheduleModal = useCallback(
    async (providerName: string) => {
      if (!providerName) return;
      setUsageScheduleProvider(providerName);
      setUsageScheduleModalOpen(true);
      setUsageScheduleLoading(true);
      try {
        const result = await invoke<{
          ok: boolean;
          periods?: Array<{
            id: string;
            mode?: "per_request" | "package_total";
            amount_usd: number;
            started_at_unix_ms: number;
            ended_at_unix_ms?: number | null;
          }>;
        }>("get_provider_timeline", {
          provider: providerName,
        });
        const rows = (result.periods ?? []).map((period) => ({
          id: period.id,
          provider: providerName,
          mode: period.mode ?? "package_total",
          startText: toDateTimeLocalValue(period.started_at_unix_ms),
          endText: toDateTimeLocalValue(period.ended_at_unix_ms ?? null),
          amountText: String(period.amount_usd ?? ""),
        }));
        setUsageScheduleRows(rows);
        setUsageScheduleSaveState("idle");
      } catch (error) {
        flashToast(String(error), "error");
      } finally {
        setUsageScheduleLoading(false);
      }
    },
    [flashToast],
  );

  const addUsageScheduleRow = useCallback(() => {
    const providerName =
      usageScheduleProvider || usageScheduleProviderOptions[0];
    if (!providerName) return;
    setUsageScheduleSaveState("idle");
    setUsageScheduleRows((prev) => [
      ...prev,
      {
        id: "",
        provider: providerName,
        mode: "package_total",
        startText: toDateTimeLocalValue(Date.now()),
        endText: "",
        amountText: "",
      },
    ]);
  }, [usageScheduleProvider, usageScheduleProviderOptions]);

  const updateUsageScheduleRow = useCallback(
    (rowIndex: number, patch: Partial<UsageScheduleDraft>) => {
      setUsageScheduleSaveState("idle");
      setUsageScheduleRows((prev) =>
        prev.map((row, index) => {
          if (index !== rowIndex) return row;
          return { ...row, ...patch };
        }),
      );
    },
    [],
  );

  const deleteUsageScheduleRow = useCallback((rowIndex: number) => {
    setUsageScheduleSaveState("idle");
    setUsageScheduleRows((prev) =>
      prev.filter((_, index) => index !== rowIndex),
    );
  }, []);

  const saveUsageScheduleRows = useCallback(async () => {
    if (!usageScheduleProvider) return;

    const periods: Array<{
      id: string | null;
      mode: "per_request" | "package_total";
      amount_usd: number;
      api_key_ref: string;
      started_at_unix_ms: number;
      ended_at_unix_ms?: number;
    }> = [];

    for (const row of usageScheduleRows) {
      const amount = parsePositiveAmount(row.amountText);
      const start = fromDateTimeLocalValue(row.startText);
      const end = fromDateTimeLocalValue(row.endText);
      if (amount == null || start == null) {
        setUsageScheduleSaveState("invalid");
        flashToast("Invalid timeline rows", "error");
        return;
      }
      if (end != null && end <= start) {
        setUsageScheduleSaveState("invalid");
        flashToast("Invalid timeline rows", "error");
        return;
      }
      periods.push({
        id: row.id || null,
        mode: row.mode,
        amount_usd: amount,
        api_key_ref: "",
        started_at_unix_ms: start,
        ended_at_unix_ms: end ?? undefined,
      });
    }

    setUsageScheduleSaveState("saving");
    try {
      await invoke("set_provider_timeline", {
        provider: usageScheduleProvider,
        periods,
      });
      setUsageScheduleSaveState("saved");
      flashToast(`Saved timeline for ${usageScheduleProvider}`);
      await refreshUsageStatistics({ silent: true });
      await refreshConfig();
    } catch (error) {
      setUsageScheduleSaveState("error");
      flashToast(String(error), "error");
    }
  }, [
    flashToast,
    refreshConfig,
    refreshUsageStatistics,
    usageScheduleProvider,
    usageScheduleRows,
  ]);

  const usageScheduleSaveStatusText = useMemo(() => {
    if (usageScheduleSaveState === "saving") return "Saving...";
    if (usageScheduleSaveState === "saved") return "Saved";
    if (usageScheduleSaveState === "invalid") return "Invalid rows";
    if (usageScheduleSaveState === "error") return "Save failed";
    return "Idle";
  }, [usageScheduleSaveState]);

  return {
    usageStatistics,
    setUsageStatistics,
    usageWindowHours,
    setUsageWindowHours,
    usageFilterProviders,
    setUsageFilterProviders,
    usageFilterModels,
    setUsageFilterModels,
    usageStatisticsLoading,
    setUsageStatisticsLoading,
    usageSummary,
    usageByModel,
    usageByProvider,
    usageTimeline,
    usageProviderFilterOptions,
    usageModelFilterOptions,
    usageScheduleProviderOptions,
    toggleUsageProviderFilter,
    toggleUsageModelFilter,
    refreshUsageStatistics,
    usagePricingModalOpen,
    setUsagePricingModalOpen,
    usagePricingDrafts,
    setUsagePricingDrafts,
    usagePricingSaveState,
    setUsagePricingSaveState,
    primeUsagePricingDrafts,
    saveUsagePricingRow,
    usageHistoryModalOpen,
    setUsageHistoryModalOpen,
    usageHistoryRows,
    setUsageHistoryRows,
    usageHistoryLoading,
    setUsageHistoryLoading,
    refreshUsageHistory,
    clearUsageHistoryRow,
    usageScheduleModalOpen,
    setUsageScheduleModalOpen,
    usageScheduleProvider,
    setUsageScheduleProvider,
    usageScheduleRows,
    setUsageScheduleRows,
    usageScheduleLoading,
    setUsageScheduleLoading,
    usageScheduleSaveState,
    setUsageScheduleSaveState,
    usageScheduleSaveStatusText,
    openUsageScheduleModal,
    addUsageScheduleRow,
    updateUsageScheduleRow,
    deleteUsageScheduleRow,
    saveUsageScheduleRows,
  };
}
