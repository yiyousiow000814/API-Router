import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { Config, Status } from "../types";
import type { KeyModalState, TopPage, UsageBaseModalState } from "./appTypes";

function defaultKeyModal(): KeyModalState {
  return { open: false, provider: "", value: "" };
}

function defaultUsageBaseModal(): UsageBaseModalState {
  return {
    open: false,
    provider: "",
    value: "",
    auto: false,
    explicitValue: "",
    effectiveValue: "",
  };
}

function nextProviderName(existing: string[]): string {
  let index = 1;
  while (existing.includes(`provider_${index}`)) {
    index += 1;
  }
  return `provider_${index}`;
}

type ToastLevel = "info" | "error";

export function useAppState() {
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [baselineBaseUrls, setBaselineBaseUrls] = useState<
    Record<string, string>
  >({});
  const [toast, setToast] = useState<string>("");
  const [clearErrorsBeforeMs, setClearErrorsBeforeMs] = useState<number>(0);
  const toastTimerRef = useRef<number | null>(null);

  const [activePage, setActivePage] = useState<TopPage>("dashboard");
  const [override, setOverride] = useState<string>("");
  const overrideDirtyRef = useRef<boolean>(false);

  const [keyModal, setKeyModal] = useState<KeyModalState>(defaultKeyModal);
  const [usageBaseModal, setUsageBaseModal] = useState<UsageBaseModalState>(
    defaultUsageBaseModal,
  );
  const [gatewayTokenPreview, setGatewayTokenPreview] = useState<string>("");
  const [gatewayTokenReveal, setGatewayTokenReveal] = useState<string>("");
  const [gatewayModalOpen, setGatewayModalOpen] = useState<boolean>(false);
  const [configModalOpen, setConfigModalOpen] = useState<boolean>(false);
  const [instructionModalOpen, setInstructionModalOpen] =
    useState<boolean>(false);
  const [codexSwapModalOpen, setCodexSwapModalOpen] = useState<boolean>(false);
  const [codexSwapDir1, setCodexSwapDir1] = useState<string>("");
  const [codexSwapDir2, setCodexSwapDir2] = useState<string>("");
  const [codexSwapApplyBoth, setCodexSwapApplyBoth] = useState<boolean>(false);

  const [newProviderName, setNewProviderName] = useState<string>("");
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState<string>("");
  const [providerPanelsOpen, setProviderPanelsOpen] = useState<
    Record<string, boolean>
  >({});
  const [providerBaseUrlDrafts, setProviderBaseUrlDrafts] = useState<
    Record<string, string>
  >({});
  const [editingProviderName, setEditingProviderName] = useState<string | null>(
    null,
  );
  const [providerNameDrafts, setProviderNameDrafts] = useState<
    Record<string, string>
  >({});
  const [refreshingProviders, setRefreshingProviders] = useState<
    Record<string, boolean>
  >({});
  const [updatingSessionPref, setUpdatingSessionPref] = useState<
    Record<string, boolean>
  >({});

  const providerListRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mainAreaRef = useRef<HTMLDivElement | null>(null);
  const sessionOrderRef = useRef<Record<string, number>>({});
  const sessionOrderNextRef = useRef<number>(1);

  const draggingProvider: string | null = null;
  const dragPreviewOrder: string[] | null = null;
  const dragCardHeight = 0;

  const flashToast = useCallback(
    (message: string, level: ToastLevel = "info") => {
      const text = String(message);
      setToast(level === "error" ? `Error: ${text}` : text);
      if (toastTimerRef.current != null) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => {
        setToast("");
        toastTimerRef.current = null;
      }, 2200);
    },
    [],
  );

  const scrollToTop = useCallback(() => {
    const node = mainAreaRef.current;
    if (node) {
      node.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const switchPage = useCallback(
    (page: TopPage) => {
      setActivePage(page);
      window.setTimeout(scrollToTop, 0);
    },
    [scrollToTop],
  );

  const refreshStatus = useCallback(async () => {
    const next = await invoke<Status>("get_status");
    setStatus(next);
    if (!overrideDirtyRef.current) {
      setOverride(next.manual_override ?? "");
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    const next = await invoke<Config>("get_config");
    setConfig(next);
    const map: Record<string, string> = {};
    Object.entries(next.providers).forEach(([name, provider]) => {
      map[name] = provider.base_url;
    });
    setBaselineBaseUrls(map);
  }, []);

  const refreshGatewayTokenPreview = useCallback(async () => {
    const preview = await invoke<string>("get_gateway_token_preview");
    setGatewayTokenPreview(preview);
  }, []);

  const providers = useMemo(() => {
    const byOrder =
      config?.provider_order?.filter((name) => config.providers[name]) ?? [];
    const configNames = config
      ? Object.keys(config.providers).filter((name) => !byOrder.includes(name))
      : [];
    const statusNames = status ? Object.keys(status.providers) : [];
    return Array.from(new Set([...byOrder, ...configNames, ...statusNames]));
  }, [config, status]);

  const orderedConfigProviders = useMemo(() => {
    if (!config) return [];
    const order =
      config.provider_order?.filter((name) => config.providers[name]) ?? [];
    const tail = Object.keys(config.providers).filter(
      (name) => !order.includes(name),
    );
    return [...order, ...tail];
  }, [config]);

  const nextProviderPlaceholder = useMemo(
    () => nextProviderName(orderedConfigProviders),
    [orderedConfigProviders],
  );

  const visibleEvents = useMemo(() => {
    const events = status?.recent_events ?? [];
    if (!clearErrorsBeforeMs) return events;
    return events.filter(
      (event) => event.level !== "error" || event.unix_ms > clearErrorsBeforeMs,
    );
  }, [status, clearErrorsBeforeMs]);

  const canClearErrors = useMemo(
    () => visibleEvents.some((event) => event.level === "error"),
    [visibleEvents],
  );

  const clearErrors = useCallback(() => {
    const now = Date.now();
    setClearErrorsBeforeMs(now);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("ao.clearErrorsBeforeMs", String(now));
    }
  }, []);

  const clientSessions = useMemo(() => {
    const sessions = status?.client_sessions ?? [];
    sessions.forEach((session) => {
      if (!sessionOrderRef.current[session.id]) {
        sessionOrderRef.current[session.id] = sessionOrderNextRef.current;
        sessionOrderNextRef.current += 1;
      }
    });
    return [...sessions].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.last_seen_unix_ms !== b.last_seen_unix_ms)
        return b.last_seen_unix_ms - a.last_seen_unix_ms;
      return (
        (sessionOrderRef.current[a.id] ?? 0) -
        (sessionOrderRef.current[b.id] ?? 0)
      );
    });
  }, [status]);

  const setSessionPreferred = useCallback(
    async (sessionId: string, provider: string | null) => {
      setUpdatingSessionPref((prev) => ({ ...prev, [sessionId]: true }));
      try {
        if (provider) {
          await invoke("set_session_preferred_provider", {
            sessionId,
            provider,
          });
        } else {
          await invoke("clear_session_preferred_provider", { sessionId });
        }
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      } finally {
        setUpdatingSessionPref((prev) => ({ ...prev, [sessionId]: false }));
      }
    },
    [flashToast, refreshStatus],
  );

  const applyOverride = useCallback(
    async (next: string) => {
      try {
        await invoke("set_manual_override", {
          provider: next === "" ? null : next,
        });
        overrideDirtyRef.current = false;
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [flashToast, refreshStatus],
  );

  const setPreferred = useCallback(
    async (provider: string) => {
      try {
        await invoke("set_preferred_provider", { provider });
        await refreshConfig();
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  );

  const saveProvider = useCallback(
    async (name: string, baseUrl?: string) => {
      const source =
        baseUrl ??
        providerBaseUrlDrafts[name] ??
        config?.providers[name]?.base_url ??
        "";
      const nextBaseUrl = source.trim();
      if (!name.trim() || !nextBaseUrl) {
        flashToast("Provider name and base URL are required", "error");
        return;
      }
      try {
        await invoke("upsert_provider", { name, baseUrl: nextBaseUrl });
        setProviderBaseUrlDrafts((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
        flashToast(`Saved provider ${name}`);
        await refreshConfig();
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [config, flashToast, providerBaseUrlDrafts, refreshConfig, refreshStatus],
  );

  const deleteProvider = useCallback(
    async (name: string) => {
      try {
        await invoke("delete_provider", { name });
        flashToast(`Deleted provider ${name}`);
        await refreshConfig();
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  );

  const saveKey = useCallback(
    async (provider: string, key: string) => {
      try {
        await invoke("set_provider_key", { provider, key: key.trim() });
        setKeyModal(defaultKeyModal());
        flashToast(`Saved key for ${provider}`);
        await refreshConfig();
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  );

  const clearKey = useCallback(
    async (provider: string) => {
      try {
        await invoke("clear_provider_key", { provider });
        flashToast(`Cleared key for ${provider}`);
        await refreshConfig();
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  );

  const refreshQuota = useCallback(
    async (provider: string) => {
      setRefreshingProviders((prev) => ({ ...prev, [provider]: true }));
      try {
        await invoke("refresh_quota_shared", { provider });
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      } finally {
        setRefreshingProviders((prev) => ({ ...prev, [provider]: false }));
      }
    },
    [flashToast, refreshStatus],
  );

  const refreshQuotaAll = useCallback(async () => {
    try {
      await invoke("refresh_quota_all");
      await refreshStatus();
    } catch (error) {
      flashToast(String(error), "error");
    }
  }, [flashToast, refreshStatus]);

  const openKeyModal = useCallback(
    (provider: string) => {
      setKeyModal({ open: true, provider, value: "" });
    },
    [setKeyModal],
  );

  const openUsageBaseModal = useCallback(
    (provider: string) => {
      const explicit = config?.providers[provider]?.usage_base_url ?? "";
      const effective =
        status?.quota?.[provider]?.effective_usage_base ?? explicit;
      setUsageBaseModal({
        open: true,
        provider,
        value: explicit || effective || "",
        auto: !explicit,
        explicitValue: explicit,
        effectiveValue: effective ?? "",
      });
    },
    [config, status],
  );

  const saveUsageBaseUrl = useCallback(async () => {
    const provider = usageBaseModal.provider;
    const url = usageBaseModal.value.trim();
    if (!provider || !url) return;
    try {
      await invoke("set_usage_base_url", { provider, url });
      setUsageBaseModal(defaultUsageBaseModal());
      flashToast(`Saved usage base URL for ${provider}`);
      await refreshConfig();
      await refreshStatus();
    } catch (error) {
      flashToast(String(error), "error");
    }
  }, [flashToast, refreshConfig, refreshStatus, usageBaseModal]);

  const clearUsageBaseUrl = useCallback(
    async (provider: string) => {
      try {
        await invoke("clear_usage_base_url", { provider });
        setUsageBaseModal(defaultUsageBaseModal());
        flashToast(`Cleared usage base URL for ${provider}`);
        await refreshConfig();
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [flashToast, refreshConfig, refreshStatus],
  );

  const applyProviderOrder = useCallback(
    async (order: string[]) => {
      try {
        await invoke("set_provider_order", { order });
        await refreshConfig();
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [flashToast, refreshConfig],
  );

  const addProvider = useCallback(async () => {
    const name = newProviderName.trim();
    const baseUrl = newProviderBaseUrl.trim();
    if (!name || !baseUrl) {
      flashToast("Provider name and base URL are required", "error");
      return;
    }
    try {
      await invoke("upsert_provider", { name, baseUrl });
      setNewProviderName("");
      setNewProviderBaseUrl("");
      flashToast(`Added provider ${name}`);
      await refreshConfig();
      await refreshStatus();
    } catch (error) {
      flashToast(String(error), "error");
    }
  }, [
    flashToast,
    newProviderBaseUrl,
    newProviderName,
    refreshConfig,
    refreshStatus,
  ]);

  const isProviderOpen = useCallback(
    (name: string) => {
      if (providerPanelsOpen[name] != null) return providerPanelsOpen[name];
      return true;
    },
    [providerPanelsOpen],
  );

  const toggleProviderOpen = useCallback((name: string) => {
    setProviderPanelsOpen((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const setAllProviderPanels = useCallback(
    (open: boolean) => {
      setProviderPanelsOpen((prev) => {
        const next = { ...prev };
        orderedConfigProviders.forEach((name) => {
          next[name] = open;
        });
        return next;
      });
    },
    [orderedConfigProviders],
  );

  const allProviderPanelsOpen = useMemo(
    () =>
      orderedConfigProviders.length > 0 &&
      orderedConfigProviders.every((name) => isProviderOpen(name)),
    [isProviderOpen, orderedConfigProviders],
  );

  const beginRenameProvider = useCallback((name: string) => {
    setEditingProviderName(name);
    setProviderNameDrafts((prev) => ({ ...prev, [name]: name }));
  }, []);

  const commitRenameProvider = useCallback(
    async (name: string) => {
      const next = providerNameDrafts[name]?.trim() ?? "";
      if (!next || next === name) {
        setEditingProviderName(null);
        return;
      }
      try {
        await invoke("rename_provider", { oldName: name, newName: next });
        flashToast(`Renamed ${name} to ${next}`);
        setEditingProviderName(null);
        await refreshConfig();
        await refreshStatus();
      } catch (error) {
        flashToast(String(error), "error");
      }
    },
    [flashToast, providerNameDrafts, refreshConfig, refreshStatus],
  );

  const renderProviderCard = useCallback(
    (name: string): ReactNode => {
      const provider = config?.providers[name];
      if (!provider) return null;
      const baseDraft = providerBaseUrlDrafts[name] ?? provider.base_url;
      const baseline = baselineBaseUrls[name] ?? provider.base_url;
      const changed = baseDraft.trim() !== baseline.trim();
      const renaming = editingProviderName === name;
      return (
        <div className="aoCard aoProviderConfigCard" key={name}>
          <div className="aoProviderConfigHead">
            {renaming ? (
              <input
                className="aoInput"
                value={providerNameDrafts[name] ?? name}
                onChange={(event) =>
                  setProviderNameDrafts((prev) => ({
                    ...prev,
                    [name]: event.target.value,
                  }))
                }
                onBlur={() => void commitRenameProvider(name)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void commitRenameProvider(name);
                  if (event.key === "Escape") setEditingProviderName(null);
                }}
                autoFocus
              />
            ) : (
              <button
                className="aoIconGhost"
                onClick={() => beginRenameProvider(name)}
              >
                {name}
              </button>
            )}
            <div className="aoRow" style={{ gap: 6 }}>
              <button
                className="aoTinyBtn"
                onClick={() => toggleProviderOpen(name)}
              >
                {isProviderOpen(name) ? "Hide" : "Show"}
              </button>
              <button
                className="aoTinyBtn"
                onClick={() => void deleteProvider(name)}
              >
                Delete
              </button>
            </div>
          </div>
          {isProviderOpen(name) ? (
            <div className="aoProviderConfigBody">
              <div className="aoProviderConfigRow">
                <label className="aoMiniLabel">Base URL</label>
                <input
                  className="aoInput"
                  value={baseDraft}
                  onChange={(event) =>
                    setProviderBaseUrlDrafts((prev) => ({
                      ...prev,
                      [name]: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="aoProviderConfigActions">
                <button
                  className="aoTinyBtn"
                  onClick={() => openKeyModal(name)}
                >
                  Set Key
                </button>
                <button
                  className="aoTinyBtn"
                  onClick={() => void clearKey(name)}
                >
                  Clear Key
                </button>
                <button
                  className="aoTinyBtn"
                  onClick={() => openUsageBaseModal(name)}
                >
                  Usage Base
                </button>
                <button
                  className="aoTinyBtn"
                  disabled={!changed}
                  onClick={() => void saveProvider(name, baseDraft)}
                >
                  Save URL
                </button>
              </div>
            </div>
          ) : null}
        </div>
      );
    },
    [
      baselineBaseUrls,
      beginRenameProvider,
      clearKey,
      commitRenameProvider,
      config,
      deleteProvider,
      editingProviderName,
      isProviderOpen,
      openKeyModal,
      openUsageBaseModal,
      providerBaseUrlDrafts,
      providerNameDrafts,
      saveProvider,
      toggleProviderOpen,
    ],
  );

  return {
    status,
    setStatus,
    config,
    setConfig,
    providers,
    toast,
    flashToast,
    clearErrorsBeforeMs,
    setClearErrorsBeforeMs,
    visibleEvents,
    canClearErrors,
    clearErrors,
    activePage,
    setActivePage,
    switchPage,
    override,
    setOverride,
    overrideDirtyRef,
    keyModal,
    setKeyModal,
    usageBaseModal,
    setUsageBaseModal,
    gatewayTokenPreview,
    setGatewayTokenPreview,
    gatewayTokenReveal,
    setGatewayTokenReveal,
    gatewayModalOpen,
    setGatewayModalOpen,
    configModalOpen,
    setConfigModalOpen,
    instructionModalOpen,
    setInstructionModalOpen,
    codexSwapModalOpen,
    setCodexSwapModalOpen,
    codexSwapDir1,
    setCodexSwapDir1,
    codexSwapDir2,
    setCodexSwapDir2,
    codexSwapApplyBoth,
    setCodexSwapApplyBoth,
    newProviderName,
    setNewProviderName,
    newProviderBaseUrl,
    setNewProviderBaseUrl,
    refreshingProviders,
    setRefreshingProviders,
    updatingSessionPref,
    setUpdatingSessionPref,
    providerListRef,
    containerRef,
    contentRef,
    mainAreaRef,
    sessionOrderRef,
    sessionOrderNextRef,
    clientSessions,
    refreshStatus,
    refreshConfig,
    refreshGatewayTokenPreview,
    setSessionPreferred,
    applyOverride,
    setPreferred,
    saveProvider,
    deleteProvider,
    saveKey,
    clearKey,
    refreshQuota,
    refreshQuotaAll,
    saveUsageBaseUrl,
    clearUsageBaseUrl,
    openKeyModal,
    openUsageBaseModal,
    applyProviderOrder,
    addProvider,
    orderedConfigProviders,
    nextProviderPlaceholder,
    isProviderOpen,
    toggleProviderOpen,
    setAllProviderPanels,
    allProviderPanelsOpen,
    beginRenameProvider,
    commitRenameProvider,
    renderProviderCard,
    draggingProvider,
    dragPreviewOrder,
    dragCardHeight,
  };
}
