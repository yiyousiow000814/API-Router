export function truncateLabel(label, max = 28) {
  const text = String(label || "");
  return text.length > max ? `${text.slice(0, max - 1)}â€¦` : text;
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
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 86400) return "today";
  if (deltaSec < 2592000) return `${Math.floor(deltaSec / 86400)}d`;
  if (deltaSec < 31536000) return `${Math.floor(deltaSec / 2592000)}m`;
  return `${Math.floor(deltaSec / 31536000)}y`;
}

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
    THREADS_CACHE_KEY,
    REASONING_EFFORT_KEY,
    localStorageRef = localStorage,
    documentRef = document,
  } = deps;

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

  function persistThreadsCache() {
    try {
      localStorageRef.setItem(
        THREADS_CACHE_KEY,
        JSON.stringify({
          windows: ensureArrayItems(state.threadItemsByWorkspace.windows),
          wsl2: ensureArrayItems(state.threadItemsByWorkspace.wsl2),
          updatedAt: Date.now(),
        })
      );
    } catch {}
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
    if (winNode) winNode.textContent = "Detecting...";
    if (wslNode) wslNode.textContent = "Detecting...";
    try {
      const data = await api("/codex/version-info");
      if (winNode) winNode.textContent = String(data?.windows || "Not detected");
      if (wslNode) wslNode.textContent = String(data?.wsl2 || "Not detected");
      updateWorkspaceAvailability(data?.windowsInstalled, data?.wsl2Installed);
      const buildStale = !!data?.buildStale;
      if (buildStale && !state.gatewayBuildStaleWarned) {
        const buildShort = String(data?.buildGitShortSha || "").trim() || "unknown";
        const repoShort = String(data?.repoGitShortSha || "").trim() || "latest";
        setStatus(`Gateway EXE outdated (${buildShort} -> ${repoShort}). Please build exe.`, true);
        state.gatewayBuildStaleWarned = true;
      } else if (!buildStale) {
        state.gatewayBuildStaleWarned = false;
      }
    } catch (error) {
      const msg = String(error?.message || "").toLowerCase();
      const label =
        msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("token")
          ? "Connect first"
          : "Gateway offline";
      if (winNode) winNode.textContent = label;
      if (wslNode) wslNode.textContent = label;
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
    for (const file of files) {
      const node = documentRef.createElement("span");
      node.className = "pill mono";
      node.textContent = truncateLabel(file?.name || "attachment");
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
    restoreModelsCache,
    restoreThreadsCache,
    truncateLabel,
  };
}
