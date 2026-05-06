export function truncateLabel(label, max = 28) {
  const text = String(label || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

export function shouldApplyVersionAvailabilityPayload(data) {
  if (!data || typeof data !== "object") return false;
  const windows = String(data.windows || "").trim().toLowerCase();
  const wsl2 = String(data.wsl2 || "").trim().toLowerCase();
  if (windows === "detecting" || wsl2 === "detecting") return false;
  return typeof data.windowsInstalled === "boolean" || typeof data.wsl2Installed === "boolean";
}

export function relativeTimeLabel(input) {
  if (!input) return "";
  let ts = Number.NaN;
  if (typeof input === "number" && Number.isFinite(input)) {
    ts = input > 1e12 ? input : input * 1000;
  } else if (typeof input === "string") {
    const trimmed = input.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const num = Number.parseFloat(trimmed);
      ts = num > 1e12 ? num : num * 1000;
    } else {
      ts = Date.parse(trimmed);
    }
  } else {
    ts = Date.parse(String(input));
  }
  if (!Number.isFinite(ts)) return "";
  const now = new Date(Date.now());
  const target = new Date(ts);
  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate()
  ).getTime();
  const dayDiff = Math.max(0, Math.floor((startOfNow - startOfTarget) / 86400000));
  if (dayDiff === 0) return "today";
  if (dayDiff < 30) return `${dayDiff}d`;
  if (dayDiff < 365) return `${Math.floor(dayDiff / 30)}m`;
  return `${Math.floor(dayDiff / 365)}y`;
}

const THREADS_CACHE_WRITE_DELAY_MS = 250;

export function createAppPersistenceModule(deps) {
  const {
    state,
    byId,
    api,
    setStatus,
    updateWorkspaceAvailability,
    getEmbeddedToken,
    ensureArrayItems,
    normalizeModelOption,
    pickLatestModelId,
    buildThreadRenderSig,
    sortThreadsByNewest,
    isThreadListActuallyVisible,
    MODELS_CACHE_KEY,
    CODEX_VERSION_CACHE_KEY,
    THREADS_CACHE_KEY,
    REASONING_EFFORT_KEY,
    recordLocalTask = () => {},
    setTimeoutRef = setTimeout,
    clearTimeoutRef = clearTimeout,
    performanceRef = performance,
    localStorageRef = localStorage,
    documentRef = document,
  } = deps;
  let codexVersionInfoRequestInFlight = null;
  let threadsCachePersistTimer = 0;

  function animateVersionNode(node, nextText) {
    if (!node) return;
    const text = String(nextText || "");
    if (String(node.textContent || "") === text) return;
    node.textContent = text;
    node.classList?.remove?.("is-text-swap");
    try {
      void node.offsetWidth;
    } catch {}
    node.classList?.add?.("is-text-swap");
  }

  function applyCodexVersionInfoPayload(data) {
    const winNode = byId("windowsCodexVersion");
    const wslNode = byId("wslCodexVersion");
    animateVersionNode(winNode, String(data?.windows || "Not detected"));
    animateVersionNode(wslNode, String(data?.wsl2 || "Not detected"));
    if (shouldApplyVersionAvailabilityPayload(data)) {
      updateWorkspaceAvailability(data?.windowsInstalled, data?.wsl2Installed);
    }
    const buildStale = !!data?.buildStale;
    if (buildStale && !state.gatewayBuildStaleWarned) {
      const buildShort = String(data?.buildGitShortSha || "").trim() || "unknown";
      const repoShort = String(data?.repoGitShortSha || "").trim() || "latest";
      setStatus(`Gateway EXE outdated (${buildShort} -> ${repoShort}). Please build exe.`, true);
      state.gatewayBuildStaleWarned = true;
    } else if (!buildStale) {
      state.gatewayBuildStaleWarned = false;
    }
  }

  function persistModelsCache() {
    try {
      const items = Array.isArray(state.modelOptions) ? state.modelOptions : [];
      localStorageRef.setItem(MODELS_CACHE_KEY, JSON.stringify({ items, updatedAt: Date.now() }));
    } catch {}
  }

  function restoreModelsCache() {
    try {
      const raw = String(localStorageRef.getItem(MODELS_CACHE_KEY) || "").trim();
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const items = ensureArrayItems(parsed?.items).map(normalizeModelOption).filter(Boolean);
      if (!items.length) return false;
      state.modelOptions = items;
      state.modelOptionsLoading = false;
      state.modelOptionsLoadingStartedAt = 0;
      if (!String(state.selectedModel || "").trim()) {
        state.selectedModel =
          pickLatestModelId(items) || items.find((item) => item?.isDefault)?.id || items[0]?.id || "";
      }
      const active = items.find((item) => item && item.id === state.selectedModel) || items[0] || null;
      const supported = Array.isArray(active?.supportedReasoningEfforts)
        ? active.supportedReasoningEfforts
        : [];
      const persisted = String(localStorageRef.getItem(REASONING_EFFORT_KEY) || "").trim();
      if (supported.length) {
        const ok = persisted && supported.some((item) => item && item.effort === persisted);
        const hasMedium = supported.some((item) => String(item?.effort || "").trim() === "medium");
        state.selectedReasoningEffort = ok
          ? persisted
          : hasMedium
            ? "medium"
            : String(active?.defaultReasoningEffort || supported[0]?.effort || "").trim();
      }
      return true;
    } catch {
      return false;
    }
  }

  function persistCodexVersionCache(data) {
    if (!CODEX_VERSION_CACHE_KEY || !data || typeof data !== "object") return;
    try {
      localStorageRef.setItem(
        CODEX_VERSION_CACHE_KEY,
        JSON.stringify({ value: data, updatedAt: Date.now() })
      );
    } catch {}
  }

  function restoreCodexVersionCache() {
    if (!CODEX_VERSION_CACHE_KEY) return false;
    try {
      const raw = String(localStorageRef.getItem(CODEX_VERSION_CACHE_KEY) || "").trim();
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const data = parsed?.value;
      if (!data || typeof data !== "object") return false;
      const windows = String(data.windows || "").trim();
      const wsl2 = String(data.wsl2 || "").trim();
      if (!windows && !wsl2) return false;
      applyCodexVersionInfoPayload(data);
      state.codexVersionInfoRestoredFromCache = true;
      state.codexVersionInfoUpdatedAt = Number(parsed?.updatedAt || Date.now());
      return true;
    } catch {
      return false;
    }
  }

  function writeThreadsCache() {
    const startedAt = performanceRef.now();
    try {
      localStorageRef.setItem(
        THREADS_CACHE_KEY,
        JSON.stringify({
          windows: ensureArrayItems(state.threadItemsByWorkspace.windows),
          wsl2: ensureArrayItems(state.threadItemsByWorkspace.wsl2),
          updatedAt: Date.now(),
        })
      );
    } catch {
    } finally {
      recordLocalTask({
        command: "thread cache persist write",
        elapsedMs: performanceRef.now() - startedAt,
        fields: {
          windowsCount: ensureArrayItems(state.threadItemsByWorkspace.windows).length,
          wsl2Count: ensureArrayItems(state.threadItemsByWorkspace.wsl2).length,
        },
      });
    }
  }

  function persistThreadsCache(options = {}) {
    if (threadsCachePersistTimer) {
      clearTimeoutRef(threadsCachePersistTimer);
      threadsCachePersistTimer = 0;
    }
    if (options.immediate === true) {
      writeThreadsCache();
      return;
    }
    threadsCachePersistTimer = setTimeoutRef(() => {
      threadsCachePersistTimer = 0;
      writeThreadsCache();
    }, THREADS_CACHE_WRITE_DELAY_MS);
  }

  function restoreThreadsCache(target) {
    try {
      const raw = String(localStorageRef.getItem(THREADS_CACHE_KEY) || "").trim();
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const windows = ensureArrayItems(parsed?.windows);
      const wsl2 = ensureArrayItems(parsed?.wsl2);
      state.threadItemsByWorkspace.windows = windows;
      state.threadItemsByWorkspace.wsl2 = wsl2;
      state.threadListRenderSigByWorkspace.windows = buildThreadRenderSig(windows);
      state.threadListRenderSigByWorkspace.wsl2 = buildThreadRenderSig(wsl2);
      state.threadWorkspaceHydratedByWorkspace.windows = windows.length > 0;
      state.threadWorkspaceHydratedByWorkspace.wsl2 = wsl2.length > 0;
      const next = target === "wsl2" ? wsl2 : windows;
      if (!next.length) return false;
      state.threadItemsAll = next.slice();
      state.threadItems = sortThreadsByNewest(next.slice());
      state.threadListPendingVisibleAnimationByWorkspace[target] = true;
      state.threadListAnimateNextRender = isThreadListActuallyVisible();
      state.threadListAnimateThreadIds = new Set();
      state.threadListExpandAnimateGroupKeys = new Set();
      return true;
    } catch {
      return false;
    }
  }

  async function refreshCodexVersions() {
    const winNode = byId("windowsCodexVersion");
    const wslNode = byId("wslCodexVersion");
    if (!winNode && !wslNode) return;
    animateVersionNode(winNode, "Detecting...");
    animateVersionNode(wslNode, "Detecting...");
    try {
      if (!codexVersionInfoRequestInFlight) {
        codexVersionInfoRequestInFlight = api("/codex/version-info").finally(() => {
          codexVersionInfoRequestInFlight = null;
        });
      }
      const data = await codexVersionInfoRequestInFlight;
      applyCodexVersionInfoPayload(data);
      persistCodexVersionCache(data);
      state.codexVersionInfoRestoredFromCache = true;
      state.codexVersionInfoUpdatedAt = Date.now();
    } catch (error) {
      const msg = String(error?.message || "").toLowerCase();
      const label =
        msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("token")
          ? "Connect first"
          : "Gateway offline";
      animateVersionNode(winNode, label);
      animateVersionNode(wslNode, label);
    }
  }

  function applyManagedTokenUi() {
    const hasManagedToken = !!getEmbeddedToken();
    const tokenInput = byId("tokenInput");
    if (!tokenInput) return;
    tokenInput.readOnly = hasManagedToken;
    if (hasManagedToken) {
      tokenInput.placeholder = "Managed by API Router";
      const connectHint = byId("connectFromToolsBtn");
      if (connectHint) connectHint.textContent = "Reconnect";
    }
  }

  function renderAttachmentPills(files) {
    const box = byId("attachmentPills");
    if (!box) return;
    box.innerHTML = "";
    const items = Array.isArray(files) ? files : [];
    box.toggleAttribute("hidden", items.length === 0);
    box.setAttribute("aria-live", "polite");
    box.setAttribute("aria-label", items.length ? `${items.length} attachment ready` : "No attachments");
    for (const file of items) {
      const node = documentRef.createElement("span");
      const kind = String(file?.kind || file?.type || "").trim().toLowerCase().startsWith("image")
        ? "IMG"
        : "FILE";
      const kindNode = documentRef.createElement("span");
      kindNode.className = "attachmentPillKind";
      kindNode.textContent = kind;
      const nameNode = documentRef.createElement("span");
      nameNode.className = "attachmentPillName";
      nameNode.textContent = truncateLabel(file?.name || file?.fileName || "attachment");
      node.className = "pill attachmentPill mono";
      node.title = `${kind} ${file?.name || file?.fileName || "attachment"}`;
      node.appendChild(kindNode);
      node.appendChild(nameNode);
      box.appendChild(node);
    }
  }

  return {
    applyManagedTokenUi,
    persistModelsCache,
    persistThreadsCache,
    refreshCodexVersions,
    relativeTimeLabel,
    renderAttachmentPills,
    restoreCodexVersionCache,
    restoreModelsCache,
    restoreThreadsCache,
    truncateLabel,
  };
}
