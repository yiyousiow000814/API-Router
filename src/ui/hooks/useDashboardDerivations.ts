import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo } from "react";
import type {
  Config,
  ProviderSwitchboardStatus,
  Status,
  UsageStatistics,
  UsageStatisticsOverview,
} from "../types";
import { computeUsageAnomalies } from "../utils/usageAnomalies";
import {
  buildUsageChartModel,
} from "../utils/usageDisplay";
import {
  buildManagedProviderNames,
  buildProviderGroupLabelByName,
  buildProviderNamesByKeyLabel,
  buildSwitchboardModelProviderLabel,
  buildSwitchboardProviderCards,
  linkedProvidersForApiKey as resolveLinkedProvidersForApiKey,
} from "../utils/switchboard";
import {
  buildUsageModelFilterDisplayOptions,
  buildUsageModelFilterOptions,
  buildUsageOriginFilterOptions,
  buildUsagePricingGroups,
  buildUsageProviderDisplayGroups,
  buildUsageProviderFilterDisplayOptions,
  buildUsageProviderFilterOptions,
  buildUsageSharedCostView,
  computeUsageProviderTotalsAndAverages,
  orderUsageProvidersByConfig,
  usageProviderRowKey,
} from "../utils/usageStatisticsView";
import {
  buildProviderGroupMaps,
  normalizeProviderGroupName,
  resolveProviderDisplayName,
} from "../utils/providerGroups";

type Params = {
  config: Config | null;
  orderedConfigProviders: string[];
  providerSwitchStatus: ProviderSwitchboardStatus | null;
  status: Status | null;
  providerApiKeyLabel: (providerName: string) => string;
  fmtPct: (value: number | null) => string;
  fmtAmount: (value: number | null | undefined) => string;
  fmtUsd: (value: number | null | undefined) => string;
  pctOf: (part?: number | null, total?: number | null) => number | null;
  usageOverview: UsageStatisticsOverview | null;
  usageStatistics: UsageStatistics | null;
  setUsageFilterNodes: Dispatch<SetStateAction<string[]>>;
  setUsageFilterProviders: Dispatch<SetStateAction<string[]>>;
  setUsageFilterOrigins: Dispatch<SetStateAction<string[]>>;
  usageWindowHours: number;
  formatUsdMaybe: (value: number | null | undefined) => string;
};

export function useDashboardDerivations(params: Params) {
  const {
    config,
    orderedConfigProviders,
    providerSwitchStatus,
    status,
    providerApiKeyLabel,
    fmtPct,
    fmtAmount,
    fmtUsd,
    pctOf,
    usageOverview,
    usageStatistics,
    setUsageFilterNodes,
    setUsageFilterProviders,
    setUsageFilterOrigins,
    usageWindowHours,
    formatUsdMaybe,
  } = params;

  const managedProviderNames = useMemo(
    () =>
      buildManagedProviderNames(
        config,
        orderedConfigProviders,
        providerSwitchStatus,
        status,
      ),
    [config, orderedConfigProviders, providerSwitchStatus, status],
  );
  const providerGroupLabelByName = useMemo(
    () =>
      buildProviderGroupLabelByName(managedProviderNames, providerApiKeyLabel),
    [managedProviderNames, providerApiKeyLabel],
  );
  const providerNamesByKeyLabel = useMemo(
    () =>
      buildProviderNamesByKeyLabel(managedProviderNames, providerApiKeyLabel),
    [managedProviderNames, providerApiKeyLabel],
  );
  const linkedProvidersForApiKey = useCallback(
    (apiKeyRef: string, fallbackProvider: string): string[] =>
      resolveLinkedProvidersForApiKey(
        providerNamesByKeyLabel,
        apiKeyRef,
        fallbackProvider,
      ),
    [providerNamesByKeyLabel],
  );
  const switchboardProviderCards = useMemo(
    () =>
      buildSwitchboardProviderCards(managedProviderNames, config, status, {
        fmtPct,
        fmtAmount,
        fmtUsd,
        pctOf,
      }),
    [config, managedProviderNames, pctOf, status, fmtAmount, fmtPct, fmtUsd],
  );

  const switchboardModeLabel = providerSwitchStatus?.mode ?? "-";
  const switchboardModelProviderLabel = useMemo(
    () => buildSwitchboardModelProviderLabel(providerSwitchStatus),
    [providerSwitchStatus],
  );
  const switchboardTargetDirsLabel =
    providerSwitchStatus?.dirs?.map((d) => d.cli_home).join(" | ") || "-";

  const usageSummary = usageOverview?.summary ?? null;
  const providerGroupMaps = useMemo(
    () => buildProviderGroupMaps(config),
    [config],
  );
  const usageTimelineRaw = usageSummary?.timeline ?? [];
  const usageTimeline = useMemo(
    () =>
      [...usageTimelineRaw].sort((a, b) => a.bucket_unix_ms - b.bucket_unix_ms),
    [usageTimelineRaw],
  );
  const usageByModel = usageStatistics?.summary?.by_model ?? [];
  const usageByProvider = usageSummary?.by_provider ?? [];
  const orderedUsageByProvider = useMemo(
    () => orderUsageProvidersByConfig(usageByProvider, orderedConfigProviders),
    [usageByProvider, orderedConfigProviders],
  );
  const usageMaxTimelineRequests = Math.max(
    1,
    ...usageTimeline.map((x) => x.requests ?? 0),
  );
  const usageMaxTimelineTokens = Math.max(
    1,
    ...usageTimeline.map((x) => x.total_tokens ?? 0),
  );
  const usageTotalInputTokens = usageSummary?.input_tokens ?? 0;
  const usageTotalOutputTokens = usageSummary?.output_tokens ?? 0;
  const usageAvgTokensPerRequest =
    (usageSummary?.total_requests ?? 0) > 0
      ? Math.round(
          (usageSummary?.total_tokens ?? 0) /
            (usageSummary?.total_requests ?? 1),
        )
      : 0;
  const usageTopModel = usageSummary?.top_model ?? null;
  const usageCatalogProviders = usageStatistics?.catalog?.providers ?? [];
  const usageCatalogModels = usageStatistics?.catalog?.models ?? [];
  const usageCatalogNodes = usageStatistics?.catalog?.nodes ?? [];
  const usageCatalogOrigins = usageStatistics?.catalog?.origins ?? [];
  const usageNodeFilterOptions = useMemo(
    () => [...usageCatalogNodes].sort((a, b) => a.localeCompare(b)),
    [usageCatalogNodes],
  );
  const usageProviderFilterOptions = useMemo(
    () => buildUsageProviderFilterOptions(usageCatalogProviders),
    [usageCatalogProviders],
  );
  const usageProviderFilterDisplayOptions = useMemo(
    () =>
      buildUsageProviderFilterDisplayOptions(usageCatalogProviders, {
        providerDisplayName: (provider) =>
          resolveProviderDisplayName(
            providerGroupMaps.displayNameByProvider,
            provider,
          ),
        providerGroupName: (provider) =>
          normalizeProviderGroupName(config?.providers?.[provider]?.group) ||
          null,
      }),
    [
      config?.providers,
      providerGroupMaps.displayNameByProvider,
      usageCatalogProviders,
    ],
  );
  const usageModelFilterOptions = useMemo(
    () => buildUsageModelFilterOptions(usageCatalogModels),
    [usageCatalogModels],
  );
  const usageModelFilterDisplayOptions = useMemo(
    () => buildUsageModelFilterDisplayOptions(usageModelFilterOptions),
    [usageModelFilterOptions],
  );
  const usageOriginFilterOptions = useMemo(
    () => buildUsageOriginFilterOptions(usageCatalogOrigins),
    [usageCatalogOrigins],
  );
  const usageSharedCostView = useMemo(
    () => buildUsageSharedCostView(orderedUsageByProvider),
    [orderedUsageByProvider],
  );
  const usageProviderDisplayGroups = useMemo(
    () =>
      buildUsageProviderDisplayGroups(
        orderedUsageByProvider,
        usageSharedCostView,
        {
          providerDisplayName: (provider) =>
            resolveProviderDisplayName(
              providerGroupMaps.displayNameByProvider,
              provider,
            ),
          providerGroupName: (provider) =>
            normalizeProviderGroupName(config?.providers?.[provider]?.group) ||
            null,
        },
      ),
    [
      config?.providers,
      orderedUsageByProvider,
      providerGroupMaps.displayNameByProvider,
      usageSharedCostView,
    ],
  );
  const usagePricedRequestCount = orderedUsageByProvider.reduce(
    (sum: number, row) => {
      const total = usageSharedCostView.effectiveTotalByRowKey.get(
        usageProviderRowKey(row),
      );
      if (total == null || !Number.isFinite(total) || total <= 0) return sum;
      return sum + (row.requests ?? 0);
    },
    0,
  );
  const usageDedupedTotalUsedUsd = orderedUsageByProvider.reduce(
    (sum: number, row) => {
      const total = usageSharedCostView.effectiveTotalByRowKey.get(
        usageProviderRowKey(row),
      );
      if (total != null && Number.isFinite(total) && total > 0)
        return sum + total;
      return sum;
    },
    0,
  );
  const usagePricedCoveragePct =
    (usageSummary?.total_requests ?? 0) > 0
      ? Math.round(
          (usagePricedRequestCount / (usageSummary?.total_requests ?? 1)) * 100,
        )
      : 0;
  const usageActiveWindowHours = useMemo(() => {
    const summaryActiveHours = usageSummary?.active_window_hours;
    if (
      summaryActiveHours != null &&
      Number.isFinite(summaryActiveHours) &&
      summaryActiveHours > 0
    ) {
      return summaryActiveHours;
    }
    const bucketSeconds = usageOverview?.bucket_seconds ?? 0;
    if (bucketSeconds <= 0) return 0;
    const activeBucketCount = usageTimeline.reduce(
      (sum: number, point) => sum + ((point.requests ?? 0) > 0 ? 1 : 0),
      0,
    );
    if (activeBucketCount <= 0) return 0;
    return (activeBucketCount * bucketSeconds) / 3600;
  }, [
    usageSummary?.active_window_hours,
    usageTimeline,
    usageOverview?.bucket_seconds,
  ]);
  const usageAvgRequestsPerHour =
    (usageSummary?.total_requests ?? 0) > 0 && usageActiveWindowHours > 0
      ? (usageSummary?.total_requests ?? 0) / usageActiveWindowHours
      : 0;
  const usageAvgTokensPerHour =
    (usageSummary?.total_tokens ?? 0) > 0 && usageActiveWindowHours > 0
      ? (usageSummary?.total_tokens ?? 0) / usageActiveWindowHours
      : 0;
  const usageWindowLabel = useMemo(() => {
    if (usageWindowHours === 24) return "24 hours";
    if (usageWindowHours === 7 * 24) return "7 days";
    if (usageWindowHours === 30 * 24) return "1 month";
    return `${usageWindowHours} hours`;
  }, [usageWindowHours]);
  const usageProviderTotalsAndAverages = useMemo(
    () =>
      computeUsageProviderTotalsAndAverages(
        orderedUsageByProvider,
        usageSharedCostView,
      ),
    [orderedUsageByProvider, usageSharedCostView],
  );
  const usagePricingProviderNames = managedProviderNames;
  const usagePricingGroups = useMemo(
    () =>
      buildUsagePricingGroups(
        usagePricingProviderNames,
        config,
        providerApiKeyLabel,
      ),
    [usagePricingProviderNames, config, providerApiKeyLabel],
  );
  const usageScheduleProviderOptions = managedProviderNames;
  const usageAnomalies = useMemo(
    () =>
      computeUsageAnomalies(
        usageTimeline,
        orderedUsageByProvider,
        usageOverview?.window_hours ?? 24,
        usageProviderRowKey,
        formatUsdMaybe,
      ),
    [
      formatUsdMaybe,
      orderedUsageByProvider,
      usageOverview?.window_hours,
      usageProviderRowKey,
      usageTimeline,
    ],
  );

  const toggleUsageProviderFilterDisplayOption = useCallback(
    (providers: string[]) => {
      const names = providers.map((name) => name.trim()).filter(Boolean);
      if (!names.length) return;
      setUsageFilterProviders((prev: string[]) => {
        const next = new Set(prev);
        const allSelected = names.every((name) => next.has(name));
        names.forEach((name) => {
          if (allSelected) next.delete(name);
          else next.add(name);
        });
        return [...next];
      });
    },
    [setUsageFilterProviders],
  );
  const toggleUsageOriginFilter = useCallback(
    (name: string) => {
      setUsageFilterOrigins((prev: string[]) =>
        prev.includes(name) ? prev.filter((v) => v !== name) : [name],
      );
    },
    [setUsageFilterOrigins],
  );
  const toggleUsageNodeFilter = useCallback(
    (name: string) => {
      setUsageFilterNodes((prev: string[]) =>
        prev.includes(name) ? prev.filter((v) => v !== name) : [name],
      );
    },
    [setUsageFilterNodes],
  );

  const usageChart = useMemo(
    () =>
      buildUsageChartModel(
        usageTimeline,
        usageMaxTimelineRequests,
        usageMaxTimelineTokens,
      ),
    [usageTimeline, usageMaxTimelineRequests, usageMaxTimelineTokens],
  );

  return {
    managedProviderNames,
    providerGroupLabelByName,
    linkedProvidersForApiKey,
    switchboardProviderCards,
    switchboardModeLabel,
    switchboardModelProviderLabel,
    switchboardTargetDirsLabel,
    usageSummary,
    usageTimeline,
    usageByModel,
    usageByProvider: orderedUsageByProvider,
    usageTotalInputTokens,
    usageTotalOutputTokens,
    usageAvgTokensPerRequest,
    usageTopModel,
    usageProviderFilterOptions,
    usageProviderFilterDisplayOptions,
    usageModelFilterOptions,
    usageModelFilterDisplayOptions,
    usageNodeFilterOptions,
    usageOriginFilterOptions,
    usageProviderDisplayGroups,
    usagePricedRequestCount,
    usageDedupedTotalUsedUsd,
    usagePricedCoveragePct,
    usageActiveWindowHours,
    usageAvgRequestsPerHour,
    usageAvgTokensPerHour,
    usageWindowLabel,
    usageProviderTotalsAndAverages,
    usagePricingProviderNames,
    usagePricingGroups,
    usageScheduleProviderOptions,
    usageAnomalies,
    toggleUsageProviderFilterDisplayOption,
    toggleUsageNodeFilter,
    toggleUsageOriginFilter,
    usageChart,
  };
}
