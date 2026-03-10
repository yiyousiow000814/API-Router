export function compactModelLabel(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  return text.startsWith("gpt-") ? text.slice(4) : text;
}

export function parseModelRankParts(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return { major: 0, minor: 0, date: 0, isCodex: 0, text: "" };
  const isCodex = /\bcodex\b/i.test(id) ? 1 : 0;
  const ver = /\bgpt-(\d+)(?:\.(\d+))?/i.exec(id);
  const major = ver ? Number(ver[1] || 0) : 0;
  const minor = ver ? Number(ver[2] || 0) : 0;
  const dm = /-(\d{4})-(\d{2})-(\d{2})(?:\b|_)/.exec(id);
  const date = dm ? Number(`${dm[1]}${dm[2]}${dm[3]}`) : 0;
  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
    date,
    isCodex,
    text: id,
  };
}

export function pickLatestModelId(options) {
  const list = Array.isArray(options) ? options.filter(Boolean) : [];
  if (!list.length) return "";
  const codexOnly = list.filter((item) => /\bcodex\b/i.test(String(item?.id || "")));
  const pool = codexOnly.length ? codexOnly : list;
  let best = pool[0];
  let bestKey = parseModelRankParts(best?.id);
  for (const item of pool) {
    const key = parseModelRankParts(item?.id);
    if (key.major !== bestKey.major) {
      if (key.major > bestKey.major) {
        best = item;
        bestKey = key;
      }
      continue;
    }
    if (key.minor !== bestKey.minor) {
      if (key.minor > bestKey.minor) {
        best = item;
        bestKey = key;
      }
      continue;
    }
    if (key.date !== bestKey.date) {
      if (key.date > bestKey.date) {
        best = item;
        bestKey = key;
      }
      continue;
    }
    if (key.isCodex !== bestKey.isCodex) {
      if (key.isCodex > bestKey.isCodex) {
        best = item;
        bestKey = key;
      }
      continue;
    }
    if (String(key.text) > String(bestKey.text)) {
      best = item;
      bestKey = key;
    }
  }
  return String(best?.id || "").trim();
}

export function createHeaderUiModule(deps) {
  const {
    state,
    byId,
    swapText,
    getActiveWorkspaceBadgeLabel,
    setHeaderModelMenuOpen,
    escapeHtml,
    REASONING_EFFORT_KEY,
    EFFORT_USER_SELECTED_KEY,
    SANDBOX_MODE,
    localStorageRef = localStorage,
    documentRef = document,
    NotificationRef = typeof Notification === "undefined" ? null : Notification,
  } = deps;

  function setStatus(message, isWarn = false) {
    const statusLine = byId("statusLine");
    if (statusLine) statusLine.textContent = message || "";
    const badge = byId("statusBadge");
    if (!badge) return;
    if (/connected|ok|sent|selected|resumed/i.test(message || "")) {
      badge.textContent = "Connected";
      badge.classList.remove("warn");
    } else if (isWarn || /error|failed|timeout|closed|disabled/i.test(message)) {
      badge.textContent = "Attention";
      badge.classList.add("warn");
    } else {
      badge.textContent = "Disconnected";
      badge.classList.add("warn");
    }
  }

  function updateHeaderUi(animateBadge = false) {
    const panelTitle = documentRef.querySelector(".chatPanel .panelHeader .panelTitle");
    const headerSwitch = byId("headerWorkspaceSwitch");
    const headerBadge = byId("headerWorkspaceBadge");
    const modelPicker = byId("headerModelPicker");
    const modelLabel = byId("headerModelLabel");
    const headerEffort = byId("headerReasoningEffort");
    const headerChevron = modelPicker ? modelPicker.querySelector(".headerModelChevron") : null;
    const inSettings = state.activeMainTab === "settings";
    const showBadge = !inSettings && state.activeThreadStarted;
    const displayTitle =
      state.modelOptionsLoading || !String(state.selectedModel || "").trim()
        ? "Loading models..."
        : compactModelLabel(state.selectedModel) || "Loading models...";

    if (panelTitle) {
      if (inSettings) {
        panelTitle.style.display = "";
        panelTitle.textContent = "Settings";
      } else {
        panelTitle.style.display = "none";
        panelTitle.textContent = "";
      }
    }
    if (modelPicker) modelPicker.style.display = inSettings ? "none" : "inline-flex";

    const options = Array.isArray(state.modelOptions) ? state.modelOptions : [];
    const active = options.find((item) => item && item.id === state.selectedModel) || null;
    const supported = Array.isArray(active?.supportedReasoningEfforts)
      ? active.supportedReasoningEfforts
      : [];
    const showEffort = !inSettings && !state.modelOptionsLoading && supported.length > 0;
    const effortText = (() => {
      if (!showEffort) return "";
      const fallback = String(active?.defaultReasoningEffort || supported[0]?.effort || "").trim();
      const allowPersisted =
        String(localStorageRef.getItem(EFFORT_USER_SELECTED_KEY) || "").trim() === "1";
      const persisted = allowPersisted
        ? String(localStorageRef.getItem(REASONING_EFFORT_KEY) || "").trim()
        : "";
      return String(persisted || state.selectedReasoningEffort || fallback || "").trim();
    })();

    if (modelLabel && headerEffort) {
      const isLoading = !!state.modelOptionsLoading || inSettings;
      const wasLoading = !!state.headerModelWasLoading;
      const clearTimers = (el) => {
        try {
          if (el && el.__swapTimer) clearTimeout(el.__swapTimer);
        } catch {}
        if (el) el.__swapTimer = 0;
      };
      const clearHeaderSwapTimer = () => {
        try {
          if (state.headerModelSwapTimer) clearTimeout(state.headerModelSwapTimer);
        } catch {}
        state.headerModelSwapTimer = 0;
      };

      if (isLoading) {
        state.headerModelWasLoading = true;
        state.headerModelSwapInProgress = false;
        clearHeaderSwapTimer();
        if (modelPicker) modelPicker.classList.remove("swapIntro");
        clearTimers(modelLabel);
        modelLabel.classList.remove("isSwapping");
        modelLabel.textContent = "Loading models...";
        clearTimers(headerEffort);
        headerEffort.classList.remove("isSwapping");
        headerEffort.textContent = "";
        headerEffort.style.display = "none";
      } else if (wasLoading) {
        state.headerModelWasLoading = false;
        state.headerModelSwapInProgress = true;
        clearHeaderSwapTimer();
        clearTimers(modelLabel);
        clearTimers(headerEffort);
        modelLabel.classList.add("isSwapping");
        if (headerChevron) headerChevron.classList.add("isSwapping");
        if (showEffort && effortText) {
          headerEffort.style.display = "inline-block";
          headerEffort.textContent = "";
          headerEffort.classList.add("isSwapping");
        } else {
          headerEffort.style.display = "none";
          headerEffort.textContent = "";
          headerEffort.classList.remove("isSwapping");
        }
        state.headerModelSwapTimer = setTimeout(() => {
          try {
            if (modelPicker) modelPicker.classList.remove("loading");
            modelLabel.textContent = displayTitle;
            modelLabel.classList.remove("isSwapping");
            if (showEffort && effortText) {
              headerEffort.style.display = "inline-block";
              headerEffort.textContent = effortText;
              headerEffort.classList.remove("isSwapping");
            } else {
              headerEffort.style.display = "none";
              headerEffort.textContent = "";
              headerEffort.classList.remove("isSwapping");
            }
            if (headerChevron) headerChevron.classList.remove("isSwapping");
            state.headerModelSwapInProgress = false;
            updateHeaderUi(false);
          } catch {}
        }, 120);
      } else if (!state.headerModelSwapInProgress) {
        swapText(modelLabel, displayTitle, { hideWhenEmpty: false });
        swapText(headerEffort, effortText, {
          hideWhenEmpty: true,
          displayWhenVisible: "inline-block",
        });
      }
    } else if (modelLabel) {
      if (displayTitle === "Loading models...") modelLabel.textContent = displayTitle;
      else swapText(modelLabel, displayTitle, { hideWhenEmpty: false });
    }

    if (modelPicker) {
      const loadingUi = !!(!inSettings && (state.modelOptionsLoading || state.headerModelSwapInProgress));
      modelPicker.classList.toggle("loading", loadingUi);
    }
    if (inSettings) setHeaderModelMenuOpen(false);

    const trigger = byId("headerModelTrigger");
    if (trigger) {
      const disabled = !!(!inSettings && state.modelOptionsLoading);
      trigger.setAttribute("aria-disabled", disabled ? "true" : "false");
      trigger.classList.toggle("disabled", disabled);
      trigger.style.pointerEvents = disabled ? "none" : "auto";
    }

    if (headerSwitch) {
      headerSwitch.style.display = !inSettings && !showBadge ? "inline-flex" : "none";
      headerSwitch.style.visibility = "visible";
      headerSwitch.style.pointerEvents = "auto";
    }
    if (!headerBadge) return;
    if (!showBadge) {
      headerBadge.classList.remove("show", "enter", "is-win", "is-wsl2");
      headerBadge.textContent = "";
      return;
    }

    const badgeLabel = getActiveWorkspaceBadgeLabel();
    headerBadge.textContent = badgeLabel;
    headerBadge.classList.add("show");
    headerBadge.classList.toggle("is-win", badgeLabel === "WIN");
    headerBadge.classList.toggle("is-wsl2", badgeLabel === "WSL2");
    if (animateBadge) {
      headerBadge.classList.remove("enter");
      void headerBadge.offsetWidth;
      headerBadge.classList.add("enter");
    } else {
      headerBadge.classList.remove("enter");
    }
  }

  function blockInSandbox(actionLabel) {
    if (!SANDBOX_MODE) return false;
    setStatus(`Sandbox mode: ${actionLabel} is disabled.`, true);
    return true;
  }

  function updateNotificationState() {
    const node = byId("notifState");
    if (!node) return;
    if (!("Notification" in window)) {
      node.textContent = "Notification: unsupported";
      return;
    }
    node.textContent = `Notification: ${NotificationRef?.permission || "default"}`;
  }

  function maybeNotifyTurnDone(text) {
    if (!("Notification" in window) || NotificationRef?.permission !== "granted") return;
    try {
      new NotificationRef("Codex turn completed", { body: (text || "Completed").slice(0, 120) });
    } catch {}
  }

  function escapeAttr(input) {
    return escapeHtml(input);
  }

  function inModelMenu(node) {
    return !!(node && node.closest && node.closest("#headerModelPicker"));
  }

  return {
    blockInSandbox,
    compactModelLabel,
    escapeAttr,
    inModelMenu,
    maybeNotifyTurnDone,
    parseModelRankParts,
    pickLatestModelId,
    setStatus,
    updateHeaderUi,
    updateNotificationState,
  };
}
