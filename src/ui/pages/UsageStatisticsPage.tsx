import { fmtWhen } from "../utils/format";
import type { AppViewModel } from "../app/useAppViewModel";

type UsageStatisticsPageProps = {
  vm: AppViewModel;
};

function fmtUsdMaybe(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000)
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function fmtSource(value?: string | null): string {
  if (!value || value === "none") return "-";
  if (value === "manual_per_request" || value === "manual_total")
    return "manual";
  if (
    value === "tracked+manual_per_request" ||
    value === "tracked+manual_total"
  )
    return "tracked+manual";
  if (value === "scheduled_package_total") return "scheduled";
  return value;
}

export function UsageStatisticsPage({ vm }: UsageStatisticsPageProps) {
  const {
    config,
    usageStatistics,
    usageSummary,
    usageByModel,
    usageByProvider,
    usageTimeline,
    usageWindowHours,
    setUsageWindowHours,
    usageFilterProviders,
    setUsageFilterProviders,
    usageFilterModels,
    setUsageFilterModels,
    usageStatisticsLoading,
    usageProviderFilterOptions,
    usageModelFilterOptions,
    usageScheduleProviderOptions,
    toggleUsageProviderFilter,
    toggleUsageModelFilter,
    refreshUsageStatistics,
    setUsagePricingModalOpen,
    setUsageHistoryModalOpen,
    openUsageScheduleModal,
  } = vm;

  const topModel = usageByModel[0];
  const avgRequestsPerHour = usageSummary
    ? usageSummary.total_requests / Math.max(1, usageWindowHours)
    : 0;
  const avgTokensPerHour = usageSummary
    ? usageSummary.total_tokens / Math.max(1, usageWindowHours)
    : 0;

  return (
    <>
      <div className="aoUsageStatsHeader">
        <div>
          <div className="aoPagePlaceholderTitle">Usage Statistics</div>
          <div className="aoHint">
            Requests, tokens, model mix, and provider-aware estimated pricing.
          </div>
        </div>
        <div className="aoUsageStatsActions">
          <button
            className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours == 24 ? " aoUsageWindowBtnActive" : ""}`}
            onClick={() => setUsageWindowHours(24)}
            disabled={usageStatisticsLoading}
            aria-pressed={usageWindowHours == 24}
          >
            24h
          </button>
          <button
            className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours == 24 * 7 ? " aoUsageWindowBtnActive" : ""}`}
            onClick={() => setUsageWindowHours(24 * 7)}
            disabled={usageStatisticsLoading}
            aria-pressed={usageWindowHours == 24 * 7}
          >
            7d
          </button>
          <button
            className={`aoTinyBtn aoUsageActionBtn aoUsageActionBtnWindow${usageWindowHours == 24 * 30 ? " aoUsageWindowBtnActive" : ""}`}
            onClick={() => setUsageWindowHours(24 * 30)}
            disabled={usageStatisticsLoading}
            aria-pressed={usageWindowHours == 24 * 30}
          >
            1M
          </button>
          <button
            className="aoTinyBtn"
            disabled={usageStatisticsLoading}
            onClick={() => {
              void refreshUsageStatistics();
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="aoUsageFilterCard">
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
            {usageProviderFilterOptions.map((providerName) => (
              <button
                key={providerName}
                className={`aoUsageFilterChip${usageFilterProviders.includes(providerName) ? " is-active" : ""}`}
                disabled={usageStatisticsLoading}
                onClick={() => toggleUsageProviderFilter(providerName)}
              >
                {providerName}
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
            {usageModelFilterOptions.map((modelName) => (
              <button
                key={modelName}
                className={`aoUsageFilterChip${usageFilterModels.includes(modelName) ? " is-active" : ""}`}
                disabled={usageStatisticsLoading}
                onClick={() => toggleUsageModelFilter(modelName)}
              >
                {modelName}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="aoUsageStatsGrid">
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Total Requests</div>
          <div className="aoUsageKpiValue">
            {usageSummary ? usageSummary.total_requests.toLocaleString() : "-"}
          </div>
          <div className="aoHint">{usageWindowHours}h window</div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Total Tokens</div>
          <div className="aoUsageKpiValue">
            {usageSummary ? usageSummary.total_tokens.toLocaleString() : "-"}
          </div>
          <div className="aoHint">
            avg/h {Math.round(avgTokensPerHour).toLocaleString()}
          </div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Estimated Total</div>
          <div className="aoUsageKpiValue">
            {fmtUsdMaybe(usageSummary?.estimated_total_cost_usd)}
          </div>
          <div className="aoHint">
            avg req/h {avgRequestsPerHour.toFixed(2)}
          </div>
        </div>
        <div className="aoUsageKpiCard">
          <div className="aoMiniLabel">Top Model</div>
          <div className="aoUsageKpiValue">{topModel?.model ?? "-"}</div>
          <div className="aoHint">
            {topModel ? `${topModel.requests.toLocaleString()} req` : "No data"}
          </div>
        </div>
      </div>

      <div className="aoSection">
        <div className="aoSectionHeader">
          <div className="aoMiniLabel">Provider Statistics</div>
          <div
            style={{ display: "inline-flex", alignItems: "center", gap: 10 }}
          >
            <button
              className="aoTinyBtn"
              onClick={() => setUsageHistoryModalOpen(true)}
            >
              Daily History
            </button>
            <button
              className="aoTinyBtn"
              onClick={() => setUsagePricingModalOpen(true)}
            >
              Base Pricing
            </button>
            <button
              className="aoTinyBtn"
              onClick={() => {
                const providerName =
                  usageScheduleProviderOptions.find(
                    (name) =>
                      config?.providers?.[name]?.manual_pricing_mode ===
                      "package_total",
                  ) ?? usageScheduleProviderOptions[0];
                if (!providerName) return;
                void openUsageScheduleModal(providerName);
              }}
              disabled={!usageScheduleProviderOptions.length}
            >
              Pricing Timeline
            </button>
          </div>
        </div>

        {usageByProvider.length ? (
          <table className="aoUsageProviderTable">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Req</th>
                <th>Tokens</th>
                <th>tok/req</th>
                <th>$ / req</th>
                <th>$ / M tok</th>
                <th>Est $ / day</th>
                <th>Total $ Used</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {usageByProvider.map((row) => (
                <tr key={row.provider}>
                  <td className="aoUsageProviderName">{row.provider}</td>
                  <td>{row.requests.toLocaleString()}</td>
                  <td>{row.total_tokens.toLocaleString()}</td>
                  <td>
                    {row.tokens_per_request == null
                      ? "-"
                      : Math.round(row.tokens_per_request).toLocaleString()}
                  </td>
                  <td>{fmtUsdMaybe(row.estimated_avg_request_cost_usd)}</td>
                  <td>{fmtUsdMaybe(row.usd_per_million_tokens)}</td>
                  <td>{fmtUsdMaybe(row.estimated_daily_cost_usd)}</td>
                  <td>{fmtUsdMaybe(row.total_used_cost_usd)}</td>
                  <td>{fmtSource(row.pricing_source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="aoHint">No provider usage data yet.</div>
        )}
      </div>

      <div className="aoSection">
        <div className="aoSectionHeader">
          <div className="aoMiniLabel">Model Statistics</div>
          <div className="aoHint">
            Last update:{" "}
            {usageStatistics
              ? fmtWhen(usageStatistics.generated_at_unix_ms)
              : "-"}
          </div>
        </div>
        {usageByModel.length ? (
          <table className="aoUsageModelTable">
            <thead>
              <tr>
                <th>Model</th>
                <th>Req</th>
                <th>Input</th>
                <th>Output</th>
                <th>Total</th>
                <th>Share</th>
                <th>Est Total</th>
              </tr>
            </thead>
            <tbody>
              {usageByModel.map((row) => (
                <tr key={row.model}>
                  <td>{row.model}</td>
                  <td>{row.requests.toLocaleString()}</td>
                  <td>{row.input_tokens.toLocaleString()}</td>
                  <td>{row.output_tokens.toLocaleString()}</td>
                  <td>{row.total_tokens.toLocaleString()}</td>
                  <td>{row.share_pct.toFixed(1)}%</td>
                  <td>{fmtUsdMaybe(row.estimated_total_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="aoHint">No model usage data yet.</div>
        )}
      </div>

      <div className="aoSection">
        <div className="aoSectionHeader">
          <div className="aoMiniLabel">Timeline</div>
        </div>
        {usageTimeline.length ? (
          <table className="aoUsageTimelineTable">
            <thead>
              <tr>
                <th>Bucket</th>
                <th>Req</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {usageTimeline.map((row) => (
                <tr key={row.bucket_unix_ms}>
                  <td>{fmtWhen(row.bucket_unix_ms)}</td>
                  <td>{row.requests.toLocaleString()}</td>
                  <td>{row.total_tokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="aoHint">No timeline data yet.</div>
        )}
      </div>
    </>
  );
}
