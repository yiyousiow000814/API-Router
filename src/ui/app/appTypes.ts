import type {
  Config,
  ProviderSwitchboardStatus,
  Status,
  UsageStatistics,
} from "../types";

export type TopPage = "dashboard" | "usage_statistics" | "provider_switchboard";

export type KeyModalState = {
  open: boolean;
  provider: string;
  value: string;
};

export type UsageBaseModalState = {
  open: boolean;
  provider: string;
  value: string;
  auto: boolean;
  explicitValue: string;
  effectiveValue: string;
};

export type UsagePricingMode = "none" | "per_request" | "package_total";

export type UsagePricingDraft = {
  mode: UsagePricingMode;
  amountText: string;
};

export type UsagePricingSaveState = "idle" | "saving" | "saved" | "error";

export type UsageScheduleMode = "per_request" | "package_total";

export type UsageScheduleDraft = {
  id: string;
  provider: string;
  mode: UsageScheduleMode;
  startText: string;
  endText: string;
  amountText: string;
};

export type UsageScheduleSaveState =
  | "idle"
  | "saving"
  | "saved"
  | "invalid"
  | "error";

export type SpendHistoryRow = {
  provider: string;
  day_key: string;
  req_count: number;
  total_tokens: number;
  effective_total_usd?: number | null;
  effective_usd_per_req?: number | null;
  source?: string | null;
};

export type SwitchboardProviderCard = {
  name: string;
  baseUrl: string;
  hasKey: boolean;
  usageHeadline: string;
  usageDetail: string;
  usageSub: string;
  usagePct: number | null;
};

export type AppCoreContext = {
  status: Status | null;
  config: Config | null;
  providers: string[];
  activePage: TopPage;
  flashToast: (message: string, level?: "info" | "error") => void;
  refreshStatus: () => Promise<void>;
  refreshConfig: () => Promise<void>;
};

export type AppUsageContext = AppCoreContext & {
  usageStatistics: UsageStatistics | null;
  usageWindowHours: number;
  usageFilterProviders: string[];
  usageFilterModels: string[];
  usageStatisticsLoading: boolean;
  refreshUsageStatistics: (options?: { silent?: boolean }) => Promise<void>;
  usagePricingModalOpen: boolean;
  usageHistoryModalOpen: boolean;
  usageScheduleModalOpen: boolean;
};

export type AppSwitchboardContext = AppCoreContext & {
  providerSwitchStatus: ProviderSwitchboardStatus | null;
};
