import { useMemo, type ReactNode } from "react";
import type { UsageProviderFilterDisplayOption } from "../utils/usageStatisticsView";
import { buildUsageModelFilterDisplayOptions } from "../utils/usageStatisticsView";

type Props = {
  usageWindowHours: number;
  setUsageWindowHours: (hours: number) => void;
  usageStatisticsLoading: boolean;
  usageFilterNodes: string[];
  setUsageFilterNodes: (nodes: string[]) => void;
  usageNodeFilterOptions: string[];
  toggleUsageNodeFilter: (nodeName: string) => void;
  usageFilterProviders: string[];
  setUsageFilterProviders: (providers: string[]) => void;
  usageProviderFilterDisplayOptions: UsageProviderFilterDisplayOption[];
  toggleUsageProviderFilterDisplayOption: (providers: string[]) => void;
  usageFilterModels: string[];
  setUsageFilterModels: (models: string[]) => void;
  usageModelFilterOptions: string[];
  usageFilterOrigins: string[];
  setUsageFilterOrigins: (origins: string[]) => void;
  usageOriginFilterOptions: string[];
  toggleUsageOriginFilter: (originName: string) => void;
  headerExtraAction?: ReactNode;
};

export function UsageStatsFiltersBar({
  usageWindowHours,
  setUsageWindowHours,
  usageStatisticsLoading,
  usageFilterNodes,
  setUsageFilterNodes,
  usageNodeFilterOptions,
  toggleUsageNodeFilter,
  usageFilterProviders,
  setUsageFilterProviders,
  usageProviderFilterDisplayOptions,
  toggleUsageProviderFilterDisplayOption,
  usageFilterModels,
  setUsageFilterModels,
  usageModelFilterOptions,
  usageFilterOrigins,
  setUsageFilterOrigins,
  usageOriginFilterOptions,
  toggleUsageOriginFilter,
  headerExtraAction,
}: Props) {
  const originOptionsLoaded = usageOriginFilterOptions.length > 0;
  const usageModelFilterDisplayOptions = useMemo(
    () => buildUsageModelFilterDisplayOptions(usageModelFilterOptions),
    [usageModelFilterOptions],
  );
  return (
    <>
      <div className="aoUsageStatsHeader">
        <div>
          <div className="aoPagePlaceholderTitle">Usage Statistics</div>
          <div className="aoHint">
            Requests, tokens, model mix, and provider-aware estimated request
            pricing.
          </div>
        </div>
        <div className="aoUsageStatsActions">
          <div
            className="aoUsageStatsActionGroup"
            role="group"
            aria-label="Usage origin"
          >
            <button
              className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnOrigin${usageFilterOrigins.length === 0 ? " aoUsageWindowBtnActive" : ""}`}
              onClick={() => setUsageFilterOrigins([])}
              disabled={usageStatisticsLoading}
              aria-pressed={usageFilterOrigins.length === 0}
            >
              All
            </button>
            <button
              className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnOrigin${usageFilterOrigins.includes("windows") ? " aoUsageWindowBtnActive" : ""}`}
              onClick={() => toggleUsageOriginFilter("windows")}
              disabled={usageStatisticsLoading}
              title={originOptionsLoaded ? undefined : "No origin data yet"}
              aria-pressed={usageFilterOrigins.includes("windows")}
            >
              Windows
            </button>
            <button
              className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnOrigin${usageFilterOrigins.includes("wsl2") ? " aoUsageWindowBtnActive" : ""}`}
              onClick={() => toggleUsageOriginFilter("wsl2")}
              disabled={usageStatisticsLoading}
              title={originOptionsLoaded ? undefined : "No origin data yet"}
              aria-pressed={usageFilterOrigins.includes("wsl2")}
            >
              WSL2
            </button>
          </div>
          <span className="aoUsageStatsActionsDivider" aria-hidden="true" />
          <div
            className="aoUsageStatsActionGroup"
            role="group"
            aria-label="Usage window"
          >
            <button
              className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 24 ? " aoUsageWindowBtnActive" : ""}`}
              onClick={() => setUsageWindowHours(24)}
              disabled={usageStatisticsLoading}
              aria-pressed={usageWindowHours === 24}
            >
              24h
            </button>
            <button
              className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 7 * 24 ? " aoUsageWindowBtnActive" : ""}`}
              onClick={() => setUsageWindowHours(7 * 24)}
              disabled={usageStatisticsLoading}
              aria-pressed={usageWindowHours === 7 * 24}
            >
              7d
            </button>
            <button
              className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours === 30 * 24 ? " aoUsageWindowBtnActive" : ""}`}
              onClick={() => setUsageWindowHours(30 * 24)}
              disabled={usageStatisticsLoading}
              aria-pressed={usageWindowHours === 30 * 24}
            >
              1M
            </button>
          </div>
          {headerExtraAction ? (
            <>
              <span className="aoUsageStatsActionsDivider" aria-hidden="true" />
              <div
                className="aoUsageStatsActionGroup"
                role="group"
                aria-label="Usage extra action"
              >
                {headerExtraAction}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="aoUsageFilterCard">
        <div className="aoUsageFilterSection aoUsageFilterSectionCompact">
          <div className="aoUsageFilterSectionHead">
            <span className="aoMiniLabel">Nodes</span>
          </div>
          <div className="aoUsageFilterChips">
            <button
              className={`aoUsageFilterChip${usageFilterNodes.length === 0 ? " is-active" : ""}`}
              disabled={usageStatisticsLoading}
              onClick={() => setUsageFilterNodes([])}
            >
              All nodes
            </button>
            {usageNodeFilterOptions.map((nodeName) => (
              <button
                key={nodeName}
                className={`aoUsageFilterChip${usageFilterNodes.includes(nodeName) ? " is-active" : ""}`}
                disabled={usageStatisticsLoading}
                onClick={() => toggleUsageNodeFilter(nodeName)}
              >
                {nodeName}
              </button>
            ))}
          </div>
        </div>
        <div className="aoUsageFilterSection aoUsageFilterSectionCompact">
          <div className="aoUsageFilterSectionHead">
            <span className="aoMiniLabel">Providers</span>
          </div>
          <div className="aoUsageFilterChips">
            <button
              className={`aoUsageFilterChip${usageFilterProviders.length === 0 ? " is-active" : ""}`}
              disabled={usageStatisticsLoading}
              onClick={() => setUsageFilterProviders([])}
            >
              All providers
            </button>
            {usageProviderFilterDisplayOptions.map((option) => (
              <button
                key={option.id}
                className={`aoUsageFilterChip${
                  option.providers.length > 0 &&
                  option.providers.every((providerName) =>
                    usageFilterProviders.includes(providerName),
                  )
                    ? " is-active"
                    : ""
                }`}
                disabled={usageStatisticsLoading}
                onClick={() =>
                  toggleUsageProviderFilterDisplayOption(option.providers)
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="aoUsageFilterSection aoUsageFilterSectionCompact">
          <div className="aoUsageFilterSectionHead">
            <span className="aoMiniLabel">Models</span>
          </div>
          <div className="aoUsageFilterChips">
            <button
              className={`aoUsageFilterChip${usageFilterModels.length === 0 ? " is-active" : ""}`}
              disabled={usageStatisticsLoading}
              onClick={() => setUsageFilterModels([])}
            >
              All models
            </button>
            {usageModelFilterDisplayOptions.map((option) => {
              const allSelected =
                option.models.length > 0 &&
                option.models.every((modelName) =>
                  usageFilterModels.includes(modelName),
                );
              return (
                <button
                  key={option.id}
                  className={`aoUsageFilterChip${allSelected ? " is-active" : ""}`}
                  disabled={usageStatisticsLoading}
                  onClick={() => {
                    const next = allSelected
                      ? usageModelFilterOptions.filter(
                          (modelName) =>
                            usageFilterModels.includes(modelName) &&
                            !option.models.includes(modelName),
                        )
                      : usageModelFilterOptions.filter(
                          (modelName) =>
                            usageFilterModels.includes(modelName) ||
                            option.models.includes(modelName),
                        );
                    setUsageFilterModels(next);
                  }}
                  title={option.models.join(" · ")}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
