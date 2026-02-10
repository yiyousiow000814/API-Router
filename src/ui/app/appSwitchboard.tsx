import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CodexSwapStatus,
  Config,
  ProviderSwitchboardStatus,
  Status,
} from "../types";
import { normalizePathForCompare } from "../utils/path";
import type { SwitchboardProviderCard } from "./appTypes";

type SwitchboardArgs = {
  config: Config | null;
  status: Status | null;
  providers: string[];
  flashToast: (message: string, level?: "info" | "error") => void;
  refreshStatus: () => Promise<void>;
  codexSwapDir1: string;
  setCodexSwapDir1: (value: string) => void;
  codexSwapDir2: string;
  setCodexSwapDir2: (value: string) => void;
  codexSwapApplyBoth: boolean;
  setCodexSwapApplyBoth: (value: boolean) => void;
};

type SwitchTarget = "gateway" | "official" | "provider";

const SWAP_PREFS_KEY = "ao.codex.swap.prefs.v1";

export function useAppSwitchboard({
  config,
  status,
  providers,
  flashToast,
  refreshStatus,
  codexSwapDir1,
  setCodexSwapDir1,
  codexSwapDir2,
  setCodexSwapDir2,
  codexSwapApplyBoth,
  setCodexSwapApplyBoth,
}: SwitchboardArgs) {
  const [codexSwapStatus, setCodexSwapStatus] =
    useState<CodexSwapStatus | null>(null);
  const [providerSwitchStatus, setProviderSwitchStatus] =
    useState<ProviderSwitchboardStatus | null>(null);
  const [providerSwitchBusy, setProviderSwitchBusy] = useState<boolean>(false);
  const [codexRefreshing, setCodexRefreshing] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(SWAP_PREFS_KEY);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as {
        dir1?: string;
        dir2?: string;
        applyBoth?: boolean;
      };
      if (parsed.dir1) setCodexSwapDir1(parsed.dir1);
      if (parsed.dir2) setCodexSwapDir2(parsed.dir2);
      setCodexSwapApplyBoth(Boolean(parsed.applyBoth));
    } catch {
      // Ignore malformed local cache.
    }
  }, [setCodexSwapApplyBoth, setCodexSwapDir1, setCodexSwapDir2]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = {
      dir1: codexSwapDir1,
      dir2: codexSwapDir2,
      applyBoth: codexSwapApplyBoth,
    };
    window.localStorage.setItem(SWAP_PREFS_KEY, JSON.stringify(payload));
  }, [codexSwapApplyBoth, codexSwapDir1, codexSwapDir2]);

  const resolveCliHomes = useCallback(
    (dir1Raw: string, dir2Raw: string, applyBoth: boolean) => {
      const dir1 = dir1Raw.trim();
      const dir2 = dir2Raw.trim();
      if (!dir1) return [];
      if (!applyBoth || !dir2) return [dir1];
      if (normalizePathForCompare(dir1) === normalizePathForCompare(dir2))
        return [dir1];
      return [dir1, dir2];
    },
    [],
  );

  const refreshProviderSwitchStatus = useCallback(async () => {
    try {
      const result = await invoke<ProviderSwitchboardStatus>(
        "provider_switchboard_status",
        {
          cli_homes: resolveCliHomes(
            codexSwapDir1,
            codexSwapDir2,
            codexSwapApplyBoth,
          ),
        },
      );
      setProviderSwitchStatus(result);
    } catch (error) {
      flashToast(String(error), "error");
    }
  }, [
    codexSwapApplyBoth,
    codexSwapDir1,
    codexSwapDir2,
    flashToast,
    resolveCliHomes,
  ]);

  const refreshCodexSwapStatus = useCallback(async () => {
    try {
      const result = await invoke<CodexSwapStatus>("codex_cli_swap_status", {
        cli_homes: resolveCliHomes(
          codexSwapDir1,
          codexSwapDir2,
          codexSwapApplyBoth,
        ),
      });
      setCodexSwapStatus(result);
    } catch (error) {
      flashToast(String(error), "error");
    }
  }, [
    codexSwapApplyBoth,
    codexSwapDir1,
    codexSwapDir2,
    flashToast,
    resolveCliHomes,
  ]);

  const toggleCodexSwap = useCallback(
    async (homes?: string[]) => {
      const cliHomes =
        homes ??
        resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapApplyBoth);
      const result = await invoke<{
        ok: boolean;
        mode: "swapped" | "restored";
        cli_homes: string[];
      }>("codex_cli_toggle_auth_config_swap", {
        cli_homes: cliHomes,
      });
      flashToast(
        result.mode === "swapped"
          ? "Swapped Codex auth/config"
          : "Restored Codex auth/config",
      );
      await refreshCodexSwapStatus();
      await refreshProviderSwitchStatus();
    },
    [
      codexSwapApplyBoth,
      codexSwapDir1,
      codexSwapDir2,
      flashToast,
      refreshCodexSwapStatus,
      refreshProviderSwitchStatus,
      resolveCliHomes,
    ],
  );

  const setProviderSwitchTarget = useCallback(
    async (mode: SwitchTarget, provider?: string) => {
      setProviderSwitchBusy(true);
      try {
        await invoke("provider_switchboard_set_target", {
          target: mode,
          provider: provider ?? null,
          cli_homes: resolveCliHomes(
            codexSwapDir1,
            codexSwapDir2,
            codexSwapApplyBoth,
          ),
        });
        await refreshProviderSwitchStatus();
        await refreshStatus();
        flashToast(
          mode === "provider" && provider
            ? `Switched to provider ${provider}`
            : `Switched to ${mode}`,
        );
      } catch (error) {
        flashToast(String(error), "error");
      } finally {
        setProviderSwitchBusy(false);
      }
    },
    [
      codexSwapApplyBoth,
      codexSwapDir1,
      codexSwapDir2,
      flashToast,
      refreshProviderSwitchStatus,
      refreshStatus,
      resolveCliHomes,
    ],
  );

  const switchboardProviderCards = useMemo<SwitchboardProviderCard[]>(() => {
    return providers.map((providerName) => {
      const providerConfig = config?.providers?.[providerName];
      const quota = status?.quota?.[providerName];
      const hasKey = Boolean(providerConfig?.has_key);
      const monthlyBudget = quota?.monthly_budget_usd ?? null;
      const monthlySpent = quota?.monthly_spent_usd ?? null;
      const usagePct =
        monthlyBudget && monthlyBudget > 0 && monthlySpent != null
          ? Math.max(0, Math.min(100, (monthlySpent / monthlyBudget) * 100))
          : null;

      return {
        name: providerName,
        baseUrl: providerConfig?.base_url ?? "",
        hasKey,
        usageHeadline:
          monthlySpent != null || monthlyBudget != null
            ? `Monthly: $${monthlySpent ?? 0} / $${monthlyBudget ?? 0}`
            : "No monthly quota data",
        usageDetail:
          quota?.remaining != null
            ? `Remaining: ${quota.remaining}`
            : "Remaining: n/a",
        usageSub: quota?.last_error || "",
        usagePct,
      };
    });
  }, [config, providers, status]);

  const switchboardModeLabel = providerSwitchStatus?.mode ?? "-";

  const switchboardModelProviderLabel = useMemo(() => {
    if (providerSwitchStatus?.mode === "provider") {
      return providerSwitchStatus.model_provider ?? "-";
    }
    if (providerSwitchStatus?.mode === "gateway") return "api_router";
    if (providerSwitchStatus?.mode === "official") return "official";
    return "-";
  }, [providerSwitchStatus]);

  const switchboardTargetDirsLabel = useMemo(() => {
    const dirs = providerSwitchStatus?.dirs ?? [];
    if (!dirs.length) return "-";
    return dirs.map((item) => item.cli_home).join(" | ");
  }, [providerSwitchStatus]);

  const codexSwapBadge = useMemo(() => {
    if (!codexSwapStatus)
      return { badgeText: "", badgeTitle: "Codex swap status: loading" };
    if (!codexSwapStatus.ok)
      return { badgeText: "Error", badgeTitle: "Codex swap status: error" };
    const overall = codexSwapStatus.overall;
    const badgeText =
      overall === "swapped" ? "Auth" : overall === "mixed" ? "Mixed" : "User";
    return {
      badgeText,
      badgeTitle: `Codex swap status: ${overall}`,
    };
  }, [codexSwapStatus]);

  return {
    codexSwapStatus,
    setCodexSwapStatus,
    providerSwitchStatus,
    setProviderSwitchStatus,
    providerSwitchBusy,
    setProviderSwitchBusy,
    codexRefreshing,
    setCodexRefreshing,
    resolveCliHomes,
    toggleCodexSwap,
    refreshCodexSwapStatus,
    refreshProviderSwitchStatus,
    setProviderSwitchTarget,
    switchboardProviderCards,
    switchboardModeLabel,
    switchboardModelProviderLabel,
    switchboardTargetDirsLabel,
    codexSwapBadge,
  };
}
