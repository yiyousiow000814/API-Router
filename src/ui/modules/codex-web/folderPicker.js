export function folderPickerItemsRenderSig(target, currentPath, parentPath, items, error = "") {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return `${target}|${currentPath}|${parentPath}|empty|${String(error || "").trim()}`;
  const itemsSig = list
    .map((item) => `${String(item?.name || "").trim()}\u0001${String(item?.path || "").trim()}`)
    .join("\u0002");
  return `${target}|${currentPath}|${parentPath}|${itemsSig}`;
}

export function normalizeFolderPickerItems(value, ensureArrayItems) {
  return ensureArrayItems(value)
    .map((item) => ({
      name: String(item?.name || "").trim(),
      path: String(item?.path || "").trim(),
    }))
    .filter((item) => item.name && item.path);
}

export function createFolderPickerModule(deps) {
  const {
    state,
    byId,
    api,
    escapeHtml,
    ensureArrayItems,
    normalizeWorkspaceTarget,
    getWorkspaceTarget,
    isWorkspaceAvailable,
    setWorkspaceTarget,
    getStartCwdForWorkspace,
    setStartCwdForWorkspace,
    setStatus,
  } = deps;

  async function refreshFolderPicker(path = "", options = {}) {
    const target = normalizeWorkspaceTarget(state.folderPickerWorkspace || getWorkspaceTarget());
    const seq = Number(state.folderPickerReqSeq || 0) + 1;
    state.folderPickerReqSeq = seq;
    state.folderPickerKeepContentWhileLoading = options.keepContentWhileLoading !== false;
    state.folderPickerLoading = true;
    state.folderPickerError = "";
    renderFolderPicker();

    const query = new URLSearchParams();
    query.set("workspace", target);
    const pathText = String(path || "").trim();
    if (pathText) query.set("path", pathText);

    try {
      const data = await api(`/codex/folders?${query.toString()}`);
      if (state.folderPickerReqSeq !== seq) return;
      const dataWorkspace = normalizeWorkspaceTarget(String(data?.workspace || target));
      if (dataWorkspace !== target) return;
      state.folderPickerCurrentPath = String(data?.currentPath || "").trim();
      state.folderPickerParentPath = String(data?.parentPath || "").trim();
      state.folderPickerItems = normalizeFolderPickerItems(data?.items, ensureArrayItems);
    } catch (error) {
      if (state.folderPickerReqSeq !== seq) return;
      state.folderPickerError = String(error?.message || "Failed to list folders.");
      state.folderPickerItems = [];
    } finally {
      if (state.folderPickerReqSeq !== seq) return;
      state.folderPickerLoading = false;
      renderFolderPicker();
    }
  }

  function renderFolderPicker() {
    const backdrop = byId("folderPickerBackdrop");
    if (!backdrop) return;
    backdrop.classList.toggle("show", !!state.folderPickerOpen);
    backdrop.setAttribute("aria-hidden", state.folderPickerOpen ? "false" : "true");

    const target = normalizeWorkspaceTarget(state.folderPickerWorkspace || getWorkspaceTarget());
    const currentPath = String(state.folderPickerCurrentPath || "").trim();
    const parentPath = String(state.folderPickerParentPath || "").trim();
    const error = String(state.folderPickerError || "").trim();
    const loading = !!state.folderPickerLoading;

    const winBtn = byId("folderPickerWorkspaceWindowsBtn");
    const wslBtn = byId("folderPickerWorkspaceWslBtn");
    if (winBtn) {
      winBtn.classList.toggle("active", target === "windows");
      winBtn.disabled = !isWorkspaceAvailable("windows");
    }
    if (wslBtn) {
      wslBtn.classList.toggle("active", target === "wsl2");
      wslBtn.disabled = !isWorkspaceAvailable("wsl2");
    }

    const pathEl = byId("folderPickerCurrentPath");
    if (pathEl) {
      pathEl.textContent = currentPath || (target === "windows" ? "Computer" : "WSL2");
      pathEl.title = currentPath || "";
    }
    const errEl = byId("folderPickerError");
    if (errEl) errEl.textContent = error;

    const upBtn = byId("folderPickerUpBtn");
    if (upBtn) upBtn.disabled = loading || !parentPath;
    const useCurrentBtn = byId("folderPickerUseCurrentBtn");
    if (useCurrentBtn) useCurrentBtn.disabled = loading || !currentPath;
    const useDefaultBtn = byId("folderPickerUseDefaultBtn");
    if (useDefaultBtn) useDefaultBtn.disabled = loading;

    const list = byId("folderPickerList");
    if (!list) return;
    if (loading) {
      const hasContent = list.getAttribute("data-has-content") === "1";
      const preserve = !!state.folderPickerKeepContentWhileLoading;
      const dimExistingList = hasContent && preserve;
      list.classList.toggle("is-loading", dimExistingList);
      if (!dimExistingList) {
        list.innerHTML =
          `<div class="folderPickerLoading">` +
          `<span class="folderPickerLoadingSpinner" aria-hidden="true"></span>` +
          `<span>Loading folders...</span>` +
          `</div>`;
        list.setAttribute("data-has-content", "0");
        state.folderPickerListRenderSig = `loading|${target}|${currentPath}|${parentPath}`;
      }
      return;
    }
    list.classList.remove("is-loading");
    const items = ensureArrayItems(state.folderPickerItems);
    const renderSig = folderPickerItemsRenderSig(target, currentPath, parentPath, items, error);
    if (!items.length) {
      if (state.folderPickerListRenderSig !== renderSig) {
        list.innerHTML = `<div class="folderPickerEmpty">No folders found.</div>`;
        list.setAttribute("data-has-content", "0");
        state.folderPickerListRenderSig = renderSig;
      }
      return;
    }
    if (state.folderPickerListRenderSig === renderSig) return;
    list.innerHTML = items
      .map((item) => {
        const name = String(item?.name || "").trim();
        const path = String(item?.path || "").trim();
        if (!name || !path) return "";
        const encodedPath = encodeURIComponent(path);
        return (
          `<button class="folderPickerItem" data-path="${encodedPath}">` +
          `<span class="folderPickerItemName">${escapeHtml(name)}</span>` +
          `<span class="folderPickerItemPath">${escapeHtml(path)}</span>` +
          `</button>`
        );
      })
      .join("");
    list.setAttribute("data-has-content", "1");
    state.folderPickerListRenderSig = renderSig;
    for (const button of Array.from(list.querySelectorAll(".folderPickerItem"))) {
      const idx = Number(button?.parentElement ? Array.from(button.parentElement.children).indexOf(button) : 0);
      button.style.setProperty("--folder-enter-delay", `${Math.min(Math.max(idx, 0), 9) * 18}ms`);
      button.classList.add("is-enter");
      button.onclick = () => {
        const encodedPath = String(button.getAttribute("data-path") || "");
        const nextPath = encodedPath ? decodeURIComponent(encodedPath) : "";
        if (!nextPath || state.folderPickerLoading) return;
        refreshFolderPicker(nextPath).catch((error) => {
          state.folderPickerError = error?.message || "Failed to browse folders.";
          renderFolderPicker();
        });
      };
    }
  }

  function closeFolderPicker() {
    state.folderPickerOpen = false;
    state.folderPickerLoading = false;
    state.folderPickerError = "";
    state.folderPickerReqSeq = Number(state.folderPickerReqSeq || 0) + 1;
    state.folderPickerListRenderSig = "";
    renderFolderPicker();
  }

  async function openFolderPicker() {
    state.folderPickerOpen = true;
    state.folderPickerWorkspace = getWorkspaceTarget();
    state.folderPickerCurrentPath = "";
    state.folderPickerParentPath = "";
    state.folderPickerItems = [];
    state.folderPickerError = "";
    state.folderPickerListRenderSig = "";
    state.folderPickerKeepContentWhileLoading = false;
    renderFolderPicker();
    const selected = getStartCwdForWorkspace(state.folderPickerWorkspace);
    await refreshFolderPicker(selected, { keepContentWhileLoading: false });
  }

  async function switchFolderPickerWorkspace(target) {
    if (state.folderPickerLoading) return;
    const next = normalizeWorkspaceTarget(target);
    if (!isWorkspaceAvailable(next)) return;
    state.folderPickerWorkspace = next;
    renderFolderPicker();
    if (getWorkspaceTarget() !== next) {
      await setWorkspaceTarget(next);
    }
    const selected = getStartCwdForWorkspace(next);
    await refreshFolderPicker(selected, { keepContentWhileLoading: false });
  }

  function confirmFolderPickerCurrentPath() {
    const target = normalizeWorkspaceTarget(state.folderPickerWorkspace || getWorkspaceTarget());
    const currentPath = String(state.folderPickerCurrentPath || "").trim();
    if (!currentPath) return;
    setStartCwdForWorkspace(target, currentPath);
    setStatus(`Start directory: ${currentPath}`);
    closeFolderPicker();
  }

  function resetFolderPickerPath() {
    const target = normalizeWorkspaceTarget(state.folderPickerWorkspace || getWorkspaceTarget());
    setStartCwdForWorkspace(target, "");
    setStatus(`Start directory reset for ${target.toUpperCase()}.`);
    closeFolderPicker();
  }

  return {
    closeFolderPicker,
    confirmFolderPickerCurrentPath,
    openFolderPicker,
    refreshFolderPicker,
    renderFolderPicker,
    resetFolderPickerPath,
    switchFolderPickerWorkspace,
  };
}
