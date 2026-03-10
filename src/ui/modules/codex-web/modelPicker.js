export function normalizeModelOption(item, ensureArrayItems) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || item.model || item.name || "").trim();
  if (!id) return null;
  const label = String(item.displayName || item.title || item.name || id).trim() || id;
  const isDefault = !!(item.isDefault || item.default || item.recommended);
  const supportedReasoningEfforts = ensureArrayItems(item.supportedReasoningEfforts)
    .map((x) => {
      if (!x || typeof x !== "object") return null;
      const effort = String(x.reasoningEffort || x.effort || "").trim();
      if (!effort) return null;
      return {
        effort,
        description: String(x.description || "").trim(),
      };
    })
    .filter(Boolean);
  const defaultReasoningEffort = String(item.defaultReasoningEffort || "").trim();
  return { id, label, isDefault, supportedReasoningEfforts, defaultReasoningEffort };
}

export function resolveSelectedModelId(options, preferred, pickLatestModelId) {
  const items = Array.isArray(options) ? options : [];
  const preferredId = String(preferred || "").trim();
  const latest = typeof pickLatestModelId === "function" ? pickLatestModelId(items) : "";
  if (preferredId && items.some((item) => item?.id === preferredId)) return preferredId;
  return latest || items.find((item) => item?.isDefault)?.id || items[0]?.id || "";
}

export function resolveSelectedReasoningEffort(model, persistedEffort) {
  const supported = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : [];
  const persisted = String(persistedEffort || "").trim();
  if (!supported.length) return persisted;
  if (persisted && supported.some((item) => item?.effort === persisted)) return persisted;
  if (supported.some((item) => String(item?.effort || "").trim() === "medium")) return "medium";
  return String(model?.defaultReasoningEffort || supported[0]?.effort || "").trim();
}

export function createModelPickerModule(deps) {
  const {
    state,
    byId,
    api,
    waitMs,
    ensureArrayItems,
    escapeHtml,
    escapeAttr,
    compactModelLabel,
    updateHeaderUi,
    persistModelsCache,
    pickLatestModelId,
    SELECTED_MODEL_KEY,
    REASONING_EFFORT_KEY,
    MODEL_USER_SELECTED_KEY,
    EFFORT_USER_SELECTED_KEY,
    MODEL_LOADING_MIN_MS,
    documentRef = document,
    windowRef = window,
    requestAnimationFrameRef = requestAnimationFrame,
    performanceRef = performance,
    localStorageRef = localStorage,
  } = deps;

  function setHeaderModelMenuOpen(open) {
    const picker = byId("headerModelPicker");
    const trigger = byId("headerModelTrigger");
    if (!picker || !trigger) return;
    if (open && state.modelOptionsLoading) return;
    picker.classList.toggle("open", !!open);
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) {
      state.inlineEffortMenuOpen = false;
      state.inlineEffortMenuForModel = "";
      closeInlineEffortOverlay();
    }
  }

  function ensureInlineEffortOverlay() {
    let el = documentRef.getElementById("effortInlineOverlay");
    if (el) return el;
    el = documentRef.createElement("div");
    el.id = "effortInlineOverlay";
    el.className = "effortInlineOverlay";
    el.setAttribute("role", "listbox");
    el.setAttribute("aria-label", "Reasoning effort");
    documentRef.body.appendChild(el);
    return el;
  }

  function closeInlineEffortOverlay() {
    const el = documentRef.getElementById("effortInlineOverlay");
    if (!el) return;
    el.classList.remove("show");
    el.innerHTML = "";
    try {
      const menu = byId("headerModelMenu");
      for (const trigger of Array.from(
        menu?.querySelectorAll?.(".effortSubChevron[aria-expanded='true']") || []
      )) {
        trigger.setAttribute("aria-expanded", "false");
      }
    } catch {}
  }

  function openInlineEffortOverlay(anchorEl, model) {
    if (!anchorEl || !model) return;
    const supported = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts
      : [];
    if (!supported.length) return;

    const overlay = ensureInlineEffortOverlay();
    overlay.classList.remove("show");
    void overlay.offsetWidth;
    const fallback = String(model.defaultReasoningEffort || supported[0]?.effort || "").trim();
    const allowPersisted =
      String(localStorageRef.getItem(EFFORT_USER_SELECTED_KEY) || "").trim() === "1";
    const persisted = allowPersisted
      ? String(localStorageRef.getItem(REASONING_EFFORT_KEY) || "").trim()
      : "";
    const cur = String(persisted || state.selectedReasoningEffort || fallback || "").trim();

    overlay.innerHTML = supported
      .map((x) => {
        const effort = String(x?.effort || "").trim();
        if (!effort) return "";
        const title = String(x?.description || "").trim();
        const active = effort === cur ? " active" : "";
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
        return (
          `<div class="effortInlineOption${active}" role="option" aria-selected="${
            effort === cur ? "true" : "false"
          }" data-effort="${escapeAttr(effort)}"${titleAttr}>` +
          `<span class="label">${escapeHtml(effort)}</span>` +
          `<span class="effortCheck" aria-hidden="true">✓</span>` +
          `</div>`
        );
      })
      .filter(Boolean)
      .join("");

    const r = anchorEl.getBoundingClientRect();
    const menuEl = byId("headerModelMenu") || byId("headerModelPicker");
    const menuRect = menuEl ? menuEl.getBoundingClientRect() : null;
    const padding = 6;
    const baseLeft = menuRect ? menuRect.right + 2 : r.right + 2;
    const baseTop = Math.max(padding, Math.min(windowRef.innerHeight - padding, r.top - 6));
    overlay.style.left = `${Math.round(baseLeft)}px`;
    overlay.style.top = `${Math.round(baseTop)}px`;
    overlay.style.transformOrigin = "top left";
    overlay.classList.add("show");

    try {
      anchorEl.setAttribute?.("aria-expanded", "true");
    } catch {}

    requestAnimationFrameRef(() => {
      try {
        const or = overlay.getBoundingClientRect();
        let left = or.left;
        let top = or.top;
        if (or.right > windowRef.innerWidth - padding) {
          left = menuRect
            ? Math.max(padding, menuRect.left - 10 - or.width)
            : Math.max(padding, r.left - 10 - or.width);
          overlay.style.transformOrigin = "top right";
        }
        if (or.left < padding) left = padding;
        if (or.bottom > windowRef.innerHeight - padding) {
          top = Math.max(padding, windowRef.innerHeight - padding - or.height);
        }
        overlay.style.left = `${Math.round(left)}px`;
        overlay.style.top = `${Math.round(top)}px`;
      } catch {}
    });

    for (const opt of Array.from(overlay.querySelectorAll(".effortInlineOption"))) {
      opt.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const effort = String(opt.getAttribute("data-effort") || "").trim();
        if (!effort) return;
        state.selectedReasoningEffort = effort;
        localStorageRef.setItem(REASONING_EFFORT_KEY, effort);
        localStorageRef.setItem(EFFORT_USER_SELECTED_KEY, "1");
        state.inlineEffortMenuOpen = false;
        state.inlineEffortMenuForModel = "";
        closeInlineEffortOverlay();
        updateHeaderUi();
        setHeaderModelMenuOpen(false);
      });
    }
  }

  function renderHeaderModelMenu() {
    const menu = byId("headerModelMenu");
    if (!menu) return;
    const options = Array.isArray(state.modelOptions) ? state.modelOptions : [];
    menu.innerHTML = "";
    if (!options.length) {
      const muted = documentRef.createElement("div");
      muted.className = "muted";
      muted.textContent = "No models available";
      menu.appendChild(muted);
      return;
    }

    const current =
      state.selectedModel || options.find((item) => item.isDefault)?.id || options[0].id;
    if (state.inlineEffortMenuForModel && state.inlineEffortMenuForModel !== current) {
      state.inlineEffortMenuOpen = false;
      state.inlineEffortMenuForModel = "";
      closeInlineEffortOverlay();
    }

    for (const model of options) {
      const optionBtn = documentRef.createElement("button");
      optionBtn.type = "button";
      optionBtn.className = `headerModelOption${model.id === current ? " active" : ""}`;
      optionBtn.setAttribute("role", "option");
      optionBtn.setAttribute("aria-selected", model.id === current ? "true" : "false");

      const supported = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : [];
      const canOpenEffort = supported.length > 0;
      const inlineOpen = !!(
        state.inlineEffortMenuOpen && state.inlineEffortMenuForModel === model.id
      );
      const effortHtml =
        `<span class="effortSubChevron${canOpenEffort ? "" : " disabled"}" role="button" tabindex="${
          canOpenEffort ? "0" : "-1"
        }" aria-haspopup="listbox" aria-expanded="${
          inlineOpen ? "true" : "false"
        }" aria-disabled="${canOpenEffort ? "false" : "true"}" data-model-id="${escapeAttr(
          model.id
        )}">` +
        `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">` +
        `<path d="M4.5 6.2l3.5 3.6 3.5-3.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>` +
        `</svg>` +
        `</span>`;

      optionBtn.innerHTML =
        `<span class="modelLabel">${escapeHtml(
          compactModelLabel(model.label || model.id)
        )}</span>` + `<span class="modelRight">${effortHtml}</span>`;

      const onSelectModel = (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.selectedModel = model.id;
        try {
          localStorageRef.setItem(SELECTED_MODEL_KEY, state.selectedModel);
          localStorageRef.setItem(MODEL_USER_SELECTED_KEY, "1");
        } catch {}

        if (supported.length) {
          const currentEffort = String(
            localStorageRef.getItem(REASONING_EFFORT_KEY) ||
              state.selectedReasoningEffort ||
              ""
          ).trim();
          const ok =
            currentEffort && supported.some((x) => x && x.effort === currentEffort);
          const next = ok
            ? currentEffort
            : String(model.defaultReasoningEffort || supported[0]?.effort || "").trim();
          if (next) {
            state.selectedReasoningEffort = next;
            localStorageRef.setItem(REASONING_EFFORT_KEY, next);
          }
          state.inlineEffortMenuOpen = true;
          state.inlineEffortMenuForModel = model.id;
        } else {
          state.inlineEffortMenuOpen = false;
          state.inlineEffortMenuForModel = "";
        }
        renderHeaderModelMenu();
        updateHeaderUi();

        if (supported.length) {
          requestAnimationFrameRef(() => {
            const activeChevron = menu.querySelector(
              ".headerModelOption.active .effortSubChevron"
            );
            const options2 = Array.isArray(state.modelOptions) ? state.modelOptions : [];
            const activeModel =
              options2.find((x) => x && x.id === state.selectedModel) || null;
            if (activeChevron && activeModel) {
              openInlineEffortOverlay(activeChevron, activeModel);
            }
          });
        } else {
          closeInlineEffortOverlay();
        }
      };

      optionBtn.__skipNextClick = false;
      optionBtn.addEventListener(
        "pointerdown",
        (event) => {
          optionBtn.__skipNextClick = true;
          onSelectModel(event);
        },
        { passive: false }
      );
      optionBtn.addEventListener("click", (event) => {
        if (optionBtn.__skipNextClick) {
          optionBtn.__skipNextClick = false;
          return;
        }
        onSelectModel(event);
      });
      menu.appendChild(optionBtn);
    }
  }

  function syncHeaderModelPicker() {
    const picker = byId("headerModelPicker");
    if (!picker) return;
    const options = Array.isArray(state.modelOptions) ? state.modelOptions : [];
    if (!options.length) {
      state.selectedModel = "";
      state.selectedReasoningEffort = "";
      renderHeaderModelMenu();
      updateHeaderUi();
      return;
    }

    const allowPersistedModel =
      String(localStorageRef.getItem(MODEL_USER_SELECTED_KEY) || "").trim() === "1";
    const persistedModel = allowPersistedModel
      ? String(localStorageRef.getItem(SELECTED_MODEL_KEY) || "").trim()
      : "";
    const selected = resolveSelectedModelId(
      options,
      persistedModel || state.selectedModel,
      pickLatestModelId
    );
    state.selectedModel = selected;
    try {
      localStorageRef.setItem(SELECTED_MODEL_KEY, selected);
    } catch {}

    const active = options.find((x) => x.id === selected) || options[0];
    const allowPersistedEffort =
      String(localStorageRef.getItem(EFFORT_USER_SELECTED_KEY) || "").trim() === "1";
    const persisted = allowPersistedEffort
      ? String(localStorageRef.getItem(REASONING_EFFORT_KEY) || "").trim()
      : "";
    state.selectedReasoningEffort = resolveSelectedReasoningEffort(active, persisted);
    if (state.selectedReasoningEffort) {
      localStorageRef.setItem(REASONING_EFFORT_KEY, state.selectedReasoningEffort);
    }
    renderHeaderModelMenu();
    updateHeaderUi();
  }

  async function refreshModels() {
    state.modelOptionsLoadingSeq = Number(state.modelOptionsLoadingSeq || 0) + 1;
    const seq = state.modelOptionsLoadingSeq;
    state.modelOptionsLoading = true;
    state.modelOptionsLoadingStartedAt = performanceRef.now();
    updateHeaderUi();
    try {
      const data = await api("/codex/models");
      const rawItems = ensureArrayItems(data.items);
      const mapped = [];
      for (const item of rawItems) {
        const normalized = normalizeModelOption(item, ensureArrayItems);
        if (normalized) mapped.push(normalized);
      }
      state.modelOptions = mapped;
      persistModelsCache();
      syncHeaderModelPicker();
    } finally {
      const elapsed = performanceRef.now() - Number(state.modelOptionsLoadingStartedAt || 0);
      const remaining = Math.max(0, MODEL_LOADING_MIN_MS - elapsed);
      if (remaining > 0) await waitMs(remaining);
      if (state.modelOptionsLoadingSeq !== seq) return;
      state.modelOptionsLoading = false;
      updateHeaderUi();
    }
  }

  return {
    closeInlineEffortOverlay,
    ensureInlineEffortOverlay,
    openInlineEffortOverlay,
    refreshModels,
    renderHeaderModelMenu,
    setHeaderModelMenuOpen,
    syncHeaderModelPicker,
  };
}
