export function compactModelLabel(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const isGpt = /^gpt-/i.test(text);
  const compact = isGpt ? text.slice(4) : text;
  return isGpt || /^\d+(?:\.\d+)*(?:[\s-]|$)/.test(compact)
    ? compact.toLowerCase()
    : compact;
}

export function parseModelRankParts(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return { major: 0, minor: 0, patch: 0, date: 0, family: 0, isCodex: 0, text: "" };
  const isCodex = /\bcodex\b/i.test(id) ? 1 : 0;
  const ver = /\bgpt-(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(id);
  const major = ver ? Number(ver[1] || 0) : 0;
  const minor = ver ? Number(ver[2] || 0) : 0;
  const patch = ver ? Number(ver[3] || 0) : 0;
  const dm = /-(\d{4})-(\d{2})-(\d{2})(?:\b|_)/.exec(id);
  const date = dm ? Number(`${dm[1]}${dm[2]}${dm[3]}`) : 0;
  const hasCodex = /\bcodex\b/i.test(id);
  const hasMax = /\bmax\b/i.test(id);
  const hasMini = /\bmini\b/i.test(id);
  const family = hasCodex
    ? hasMax
      ? 4
      : hasMini
        ? 2
        : 3
    : 1;
  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
    patch: Number.isFinite(patch) ? patch : 0,
    date,
    family,
    isCodex,
    text: id,
  };
}

export function compareModelRank(a, b) {
  const left = parseModelRankParts(a?.id || a);
  const right = parseModelRankParts(b?.id || b);
  if (left.major !== right.major) return right.major - left.major;
  if (left.minor !== right.minor) return right.minor - left.minor;
  if (left.patch !== right.patch) return right.patch - left.patch;
  if (left.family !== right.family) return right.family - left.family;
  if (left.date !== right.date) return right.date - left.date;
  return String(right.text).localeCompare(String(left.text));
}

export function pickLatestModelId(options) {
  const list = Array.isArray(options) ? options.filter(Boolean) : [];
  if (!list.length) return "";
  const sorted = list.slice().sort(compareModelRank);
  return String(sorted[0]?.id || "").trim();
}

export function classifyStatusBadge(message, isWarn = false) {
  const text = String(message || "").trim().toLowerCase();
  if (
    /connected|ok|sent|selected|resumed|running|receiving|live|sync|approval|input requested|completed|refreshing|loading|opened|ready/.test(
      text
    )
  ) {
    return { label: "Connected", warn: false };
  }
  if (isWarn || /error|failed|timeout|closed|disabled|cancelled|attention/.test(text)) {
    return { label: "Attention", warn: true };
  }
  return { label: "Disconnected", warn: true };
}

export function describeAttachBadge(state) {
  const transport = String(state?.activeThreadAttachTransport || "").trim().toLowerCase();
  if (!transport) return { visible: false, label: "", title: "" };
  if (transport === "terminal-session") {
    return {
      visible: true,
      label: "Terminal linked",
      title: "A live terminal session is also linked to this chat.",
    };
  }
  return {
    visible: true,
    label: "Linked runtime",
    title: `An additional runtime surface is linked via ${transport}.`,
  };
}

export function describeWorkspaceConnection(state, workspace = "windows") {
  const normalizedWorkspace = String(workspace || "").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
  const runtime = state?.workspaceRuntimeByTarget?.[normalizedWorkspace] || null;
  if (runtime?.connected === true) {
    return {
      connected: true,
      title: "Connected",
    };
  }
  if (runtime?.loading === true) {
    return {
      connected: false,
      title: "Checking runtime",
    };
  }
  if (runtime?.loaded === true) {
    return {
      connected: false,
      title: "Waiting for runtime",
    };
  }
  return {
    connected: false,
    title: "Checking runtime",
  };
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
    const next = classifyStatusBadge(message, isWarn);
    badge.textContent = next.label;
    if (next.warn) {
      badge.classList.add("warn");
    } else {
      badge.classList.remove("warn");
    }
  }

  function updateHeaderUi(animateBadge = false) {
    const panelTitle = documentRef.querySelector(".chatPanel .panelHeader .panelTitle");
    const headerSwitch = byId("headerWorkspaceSwitch");
    const headerBadge = byId("headerWorkspaceBadge");
    const modelPicker = byId("headerModelPicker");
    const modelLabel = byId("headerModelLabel");
    const headerEffort = byId("headerReasoningEffort");
    const headerAttachBadge = byId("headerAttachBadge");
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
    const attachBadge = describeAttachBadge(state);
    if (headerAttachBadge) {
      headerAttachBadge.textContent = "";
      headerAttachBadge.title = "";
      headerAttachBadge.classList.remove("show");
    }
    if (!headerBadge) return;
    if (!showBadge) {
      headerBadge.classList.remove(
        "show",
        "enter",
        "is-win",
        "is-wsl2",
        "is-connected",
        "is-runtime-pending",
        "is-attached",
      );
      headerBadge.title = "";
      headerBadge.textContent = "";
      return;
    }

    const badgeLabel = getActiveWorkspaceBadgeLabel();
    const workspaceTarget = badgeLabel === "WSL2" ? "wsl2" : "windows";
    const connection = describeWorkspaceConnection(state, workspaceTarget);
    const attachPending = Number(state.activeThreadAttachPendingUntil || 0) > Date.now();
    const effectiveConnected = connection.connected === true || attachPending;
    headerBadge.textContent = badgeLabel;
    headerBadge.classList.add("show");
    headerBadge.classList.toggle("is-win", badgeLabel === "WIN");
    headerBadge.classList.toggle("is-wsl2", badgeLabel === "WSL2");
    headerBadge.classList.toggle("is-connected", effectiveConnected);
    headerBadge.classList.toggle("is-runtime-pending", !effectiveConnected);
    headerBadge.classList.toggle("is-linking", attachPending);
    const attachLinked = attachBadge.visible && !inSettings;
    headerBadge.classList.toggle("is-attached", attachLinked);
    headerBadge.classList.remove("is-actionable");
    headerBadge.setAttribute("role", "status");
    headerBadge.setAttribute("tabindex", "-1");
    if (typeof headerBadge.removeAttribute === "function") {
      headerBadge.removeAttribute("aria-disabled");
    }
    headerBadge.title = attachPending
      ? `${badgeLabel} - Opening linked terminal`
      : attachBadge.visible
        ? `${badgeLabel} - ${connection.title} - ${attachBadge.label}`
        : `${badgeLabel} - ${connection.title}`;
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
    const button = byId("enableNotifBtn");
    if (!("Notification" in window)) {
      if (node) node.textContent = "Notification: unsupported";
      if (button) {
        button.textContent = "Notifications unavailable";
        button.disabled = true;
      }
      return;
    }
    const permission = NotificationRef?.permission || "default";
    if (node) node.textContent = `Notification: ${permission}`;
    if (!button) return;
    button.disabled = false;
    if (permission === "granted") {
      button.textContent = "Test notification";
    } else if (permission === "denied") {
      button.textContent = "Notifications blocked";
    } else {
      button.textContent = "Enable notifications";
    }
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
