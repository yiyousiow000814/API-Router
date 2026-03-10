export function shouldSuppressSyntheticClickEvent(untilTs, now, eventType) {
  return String(eventType || "") === "click" && now <= Number(untilTs || 0);
}

export function createUiHelpersModule(deps) {
  const {
    state,
    threadAnimDebug,
    normalizeWorkspaceTarget,
    setStatus,
    documentRef = document,
    performanceRef = performance,
    windowRef = window,
  } = deps;

  function isThreadAnimDebugEnabled() {
    return !!threadAnimDebug.enabled;
  }

  function pushThreadAnimDebug(type, detail = {}) {
    if (!threadAnimDebug.enabled) return;
    const entry = {
      seq: ++threadAnimDebug.seq,
      ts: Math.round(performanceRef.now()),
      type: String(type || ""),
      workspace: normalizeWorkspaceTarget(state.workspaceTarget || "windows"),
      drawerOpen: documentRef.body.classList.contains("drawer-left-open"),
      drawerOpening: documentRef.body.classList.contains("drawer-left-opening"),
      threadListLoading: !!state.threadListLoading,
      threadItemsCount: Array.isArray(state.threadItems) ? state.threadItems.length : 0,
      ...detail,
    };
    threadAnimDebug.events.push(entry);
    if (threadAnimDebug.events.length > 400) {
      threadAnimDebug.events.splice(0, threadAnimDebug.events.length - 400);
    }
  }

  function armSyntheticClickSuppression(ms = 380) {
    state.suppressSyntheticClickUntil = Date.now() + Math.max(0, Number(ms) || 0);
  }

  function shouldSuppressSyntheticClick(event) {
    if (!shouldSuppressSyntheticClickEvent(state.suppressSyntheticClickUntil, Date.now(), event?.type)) {
      return false;
    }
    state.suppressSyntheticClickUntil = 0;
    try {
      event?.preventDefault?.();
      event?.stopPropagation?.();
    } catch {}
    return true;
  }

  function wireBlurBackdropShield(backdrop, options = {}) {
    if (!backdrop || backdrop.__wiredBlurBackdropShield) return;
    backdrop.__wiredBlurBackdropShield = true;
    const modalSelector = typeof options.modalSelector === "string" ? options.modalSelector : "";
    const suppressMs = Math.max(0, Number(options.suppressMs) || 420);
    const onClose = typeof options.onClose === "function" ? options.onClose : null;

    const closeFromBackdrop = (event) => {
      if (shouldSuppressSyntheticClick(event)) return;
      if (event?.target !== backdrop) return;
      try {
        event?.preventDefault?.();
        event?.stopPropagation?.();
      } catch {}
      if (String(event?.type || "") === "pointerdown") {
        armSyntheticClickSuppression(suppressMs);
      }
      onClose?.();
    };

    backdrop.addEventListener("pointerdown", closeFromBackdrop, { passive: false });
    backdrop.addEventListener("click", closeFromBackdrop);

    if (modalSelector) {
      const modal = backdrop.querySelector(modalSelector);
      if (modal && !modal.__wiredBackdropStopPropagation) {
        modal.__wiredBackdropStopPropagation = true;
        modal.addEventListener("pointerdown", (event) => event.stopPropagation());
        modal.addEventListener("click", (event) => event.stopPropagation());
      }
    }
  }

  function dbgSet(patch) {
    try {
      windowRef.__webCodexDbg = Object.assign(windowRef.__webCodexDbg || {}, patch || {});
    } catch {}
  }

  function getEmbeddedToken() {
    const raw = String(windowRef.__WEB_CODEX_EMBEDDED_TOKEN__ || "").trim();
    return raw && raw !== "__WEB_CODEX_EMBEDDED_TOKEN__" ? raw : "";
  }

  function byId(id) {
    return documentRef.getElementById(id);
  }

  function bindClick(id, handler) {
    const el = byId(id);
    if (!el) return;
    el.onclick = handler;
  }

  function bindResponsiveClick(id, handler, options = {}) {
    const el = byId(id);
    if (!el) return;
    const suppressMs = Math.max(0, Number(options.suppressMs || 320));
    const run = (event) => {
      try {
        handler(event);
      } catch (error) {
        setStatus(error?.message || String(error || "Action failed"), true);
      }
    };
    el.addEventListener(
      "pointerdown",
      (event) => {
        try {
          event?.preventDefault?.();
          event?.stopPropagation?.();
        } catch {}
        el.__responsiveClickSuppressUntil = Date.now() + suppressMs;
        run(event);
      },
      { passive: false }
    );
    el.addEventListener("click", (event) => {
      if (Date.now() <= Number(el.__responsiveClickSuppressUntil || 0)) {
        try {
          event?.preventDefault?.();
          event?.stopPropagation?.();
        } catch {}
        return;
      }
      run(event);
    });
  }

  function bindInput(id, eventName, handler) {
    const el = byId(id);
    if (!el) return;
    el.addEventListener(eventName, handler);
  }

  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function swapText(el, nextText, opts = {}) {
    if (!el) return;
    const want = String(nextText || "");
    const cls = String(opts.swapClass || "isSwapping");
    const hideWhenEmpty = !!opts.hideWhenEmpty;
    const displayWhenVisible = String(opts.displayWhenVisible || "");
    const wantVisible = !(hideWhenEmpty && !want.trim());

    try {
      if (el.__swapTimer) clearTimeout(el.__swapTimer);
    } catch {}
    el.__swapTimer = 0;

    const wasHidden =
      String(el.style.display || "").trim() === "none" ||
      windowRef.getComputedStyle(el).display === "none";
    const prev = String(el.textContent || "");

    if (wasHidden && wantVisible) {
      el.textContent = want;
      el.style.display = displayWhenVisible || "";
      el.classList.add(cls);
      el.__swapTimer = setTimeout(() => {
        el.classList.remove(cls);
        el.__swapTimer = 0;
      }, 120);
      return;
    }

    if (!wantVisible) {
      if (hideWhenEmpty) el.style.display = "none";
      el.textContent = "";
      el.classList.remove(cls);
      return;
    }

    if (prev === want) {
      el.style.display = displayWhenVisible || "";
      el.classList.remove(cls);
      return;
    }

    el.classList.add(cls);
    el.__swapTimer = setTimeout(() => {
      el.textContent = want;
      el.style.display = displayWhenVisible || "";
      el.classList.remove(cls);
      el.__swapTimer = 0;
    }, 120);
  }

  return {
    armSyntheticClickSuppression,
    bindClick,
    bindInput,
    bindResponsiveClick,
    byId,
    dbgSet,
    getEmbeddedToken,
    isThreadAnimDebugEnabled,
    pushThreadAnimDebug,
    shouldSuppressSyntheticClick,
    swapText,
    waitMs,
    wireBlurBackdropShield,
  };
}
