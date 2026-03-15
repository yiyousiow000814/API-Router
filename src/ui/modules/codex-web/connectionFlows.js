export function pickPendingDefaults(approvals, userInputs) {
  const approvalId = Array.isArray(approvals) && approvals[0]?.id ? approvals[0].id : "";
  const userInputId = Array.isArray(userInputs) && userInputs[0]?.id ? userInputs[0].id : "";
  return { approvalId, userInputId };
}

export function createConnectionFlowsModule(deps) {
  const {
    state,
    byId,
    api,
    wsSend,
    nextReqId,
    connectWs,
    ensureArrayItems,
    escapeHtml,
    blockInSandbox,
    TOKEN_STORAGE_KEY,
    getEmbeddedToken,
    refreshModels,
    refreshCodexVersions,
    refreshThreads,
    getWorkspaceTarget,
    isWorkspaceAvailable,
    setStatus,
    setMainTab,
    setMobileTab,
    addChat,
  } = deps;

  function setActiveHost(id) {
    state.activeHostId = id || "";
    const activeHostLabel = byId("activeHostId");
    if (activeHostLabel) activeHostLabel.textContent = state.activeHostId || "(none)";
  }

  function renderHosts(items) {
    const list = byId("hostList");
    if (!list) return;
    list.innerHTML = "";
    for (const host of items) {
      const row = document.createElement("div");
      row.className = "row wrap";
      const card = document.createElement("button");
      card.className = "itemCard grow";
      card.innerHTML = `<div class="itemTitle">${escapeHtml(host.name || host.id)}</div><div class="itemSub mono">${escapeHtml(host.base_url || "")}</div>`;
      card.onclick = () => setActiveHost(host.id || "");
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Delete";
      del.onclick = async () => {
        if (blockInSandbox("host deletion")) return;
        await api(`/codex/hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" });
        if (state.activeHostId === host.id) setActiveHost("");
        await refreshHosts();
      };
      row.appendChild(card);
      row.appendChild(del);
      list.appendChild(row);
    }
    if (!items.length) list.innerHTML = `<div class="muted">No hosts configured.</div>`;
  }

  function renderPendingLists() {
    const approvalList = byId("approvalPendingList");
    if (!approvalList) return;
    approvalList.innerHTML = "";
    for (const item of state.pendingApprovals) {
      const id = item?.id || "";
      const card = document.createElement("button");
      card.className = "itemCard";
      card.innerHTML = `<div class="itemTitle">${escapeHtml(
        id || "approval"
      )}</div><div class="itemSub">${escapeHtml(
        item?.prompt || item?.title || item?.message || ""
      )}</div>`;
      card.onclick = () => {
        byId("approvalIdInput").value = id;
        setStatus(`Selected approval ${id}`);
      };
      approvalList.appendChild(card);
    }
    if (!state.pendingApprovals.length) {
      approvalList.innerHTML = `<div class="muted">No pending approvals.</div>`;
    }

    const userInputList = byId("userInputPendingList");
    if (!userInputList) return;
    userInputList.innerHTML = "";
    for (const item of state.pendingUserInputs) {
      const id = item?.id || "";
      const card = document.createElement("button");
      card.className = "itemCard";
      card.innerHTML = `<div class="itemTitle">${escapeHtml(
        id || "request_user_input"
      )}</div><div class="itemSub">${escapeHtml(
        item?.prompt || item?.title || item?.question || ""
      )}</div>`;
      card.onclick = () => {
        byId("userInputIdInput").value = id;
        setStatus(`Selected user_input ${id}`);
      };
      userInputList.appendChild(card);
    }
    if (!state.pendingUserInputs.length) {
      userInputList.innerHTML = `<div class="muted">No pending user inputs.</div>`;
    }
  }

  function applyPendingPayloads(approvals, userInputs) {
    state.pendingApprovals = ensureArrayItems(approvals);
    state.pendingUserInputs = ensureArrayItems(userInputs);
    const approvalIdInput = byId("approvalIdInput");
    const userInputIdInput = byId("userInputIdInput");
    const defaults = pickPendingDefaults(state.pendingApprovals, state.pendingUserInputs);
    if (defaults.approvalId && approvalIdInput) approvalIdInput.value = defaults.approvalId;
    if (defaults.userInputId && userInputIdInput) userInputIdInput.value = defaults.userInputId;
    renderPendingLists();
  }

  async function refreshHosts() {
    const data = await api("/codex/hosts");
    renderHosts(Array.isArray(data.items) ? data.items : []);
  }

  async function refreshPendingFromHttp() {
    const [approvals, userInputs] = await Promise.all([
      api("/codex/approvals/pending"),
      api("/codex/user-input/pending"),
    ]);
    applyPendingPayloads(approvals.items, userInputs.items);
  }

  async function refreshPending() {
    connectWs();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      wsSend({
        type: "events.refresh",
        reqId: nextReqId(),
        payload: {
          workspace:
            state.activeThreadWorkspace === "wsl2" || state.activeThreadWorkspace === "windows"
              ? state.activeThreadWorkspace
              : getWorkspaceTarget(),
        },
      });
      return;
    }
    await refreshPendingFromHttp();
  }

  async function refreshAll() {
    const currentTarget = getWorkspaceTarget();
    const otherTarget = currentTarget === "wsl2" ? "windows" : "wsl2";
    const tasks = [
      refreshThreads(currentTarget, { force: false, silent: false }),
      refreshHosts(),
    ];
    if (isWorkspaceAvailable(otherTarget)) {
      tasks.push(refreshThreads(otherTarget, { force: false, silent: true }).catch(() => null));
    }
    await Promise.all(tasks);
    await refreshPending();
  }

  async function connect(options = {}) {
    const inputToken = byId("tokenInput")?.value?.trim() || "";
    const managedToken = getEmbeddedToken();
    state.token = inputToken || (managedToken ? managedToken : String(state.token || "").trim());
    if (managedToken) localStorage.removeItem(TOKEN_STORAGE_KEY);
    else localStorage.setItem(TOKEN_STORAGE_KEY, state.token);
    await api("/codex/auth/verify", { method: "POST", body: {} });
    connectWs();
    setStatus("Connected.");
    await refreshModels().catch((e) => setStatus(e.message, true));
    await refreshCodexVersions().catch((e) => setStatus(e.message, true));
    await refreshAll();
    if (options.switchToChat !== false) setMainTab("chat");
  }

  return {
    applyPendingPayloads,
    connect,
    refreshAll,
    refreshHosts,
    refreshPending,
    refreshPendingFromHttp,
    renderHosts,
    renderPendingLists,
    setActiveHost,
  };
}
