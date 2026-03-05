try {
  window.__webCodexScriptLoaded = true;
} catch {}

const state = {
  token: "",
  activeHostId: "",
  activeThreadId: "",
  activeThreadRolloutPath: "",
  openingThreadAbort: null,
  ws: null,
  wsReqHandlers: new Map(),
  pendingApprovals: [],
  pendingUserInputs: [],
  threadItemsAll: [],
  threadItems: [],
  threadItemsByWorkspace: {
    windows: [],
    wsl2: [],
  },
  threadListRenderSigByWorkspace: {
    windows: "",
    wsl2: "",
  },
  threadListLoading: false,
  threadListLoadingTarget: "",
  threadRefreshAbortByWorkspace: {
    windows: null,
    wsl2: null,
  },
  threadRefreshReqSeqByWorkspace: {
    windows: 0,
    wsl2: 0,
  },
  threadAutoRefreshLastMsByWorkspace: {
    windows: 0,
    wsl2: 0,
  },
  threadAutoRefreshInFlight: false,
  scheduledRefreshTimer: null,
  activeThreadRefreshTimer: null,
  activeThreadLivePolling: false,
  activeThreadLiveLastPollMs: 0,
  activeThreadRenderSig: "",
  activeThreadMessages: [],
  wsLastEventId: 0,
  wsRecentEventIds: new Set(),
  wsRecentEventIdQueue: [],
  wsSubscribedEvents: false,
  collapsedWorkspaceKeys: new Set(),
  sidebarCollapsed: false,
  threadSearchQuery: "",
  activeMainTab: "chat",
  workspaceTarget: "windows",
  workspaceAvailability: {
    windowsInstalled: false,
    wsl2Installed: false,
  },
  favoriteThreadIds: new Set(),
  lastChevronToggleKey: "",
  lastChevronToggleCollapsed: false,
  threadPullRefreshing: false,
  activeThreadStarted: false,
  chatRenderToken: 0,
  chatSmoothScrollUntil: 0,
  chatSmoothScrollToken: 0,
  chatLiveFollowUntil: 0,
  chatLiveFollowToken: 0,
  chatLiveFollowRaf: 0,
  chatLiveFollowLastBtnMs: 0,
  chatLastScrollTop: 0,
  // Updated by pointer/wheel events; used to detect user intent even during programmatic scroll windows.
  chatLastUserGestureAt: 0,
  chatUserScrolledAwayAt: 0,
  // When true, treat the chat as "sticky" to bottom: new content/layout settles should keep following bottom
  // unless the user explicitly scrolls away. (clawdex-style stickiness)
  chatShouldStickToBottom: true,
  // Suppress scroll-intent updates for short windows when we update scrollTop programmatically
  // (live-follow / stick-to-bottom). This prevents the scroll handler from interpreting our
  // own auto-scroll as the user's "scroll away", which would stop following.
  chatProgrammaticScrollUntil: 0,
  activeThreadWorkspace: "windows",
  modelOptions: [],
  modelOptionsLoading: true,
  modelOptionsLoadingSeq: 0,
  modelOptionsLoadingStartedAt: 0,
  headerModelWasLoading: true,
  headerModelSwapInProgress: false,
  headerModelSwapTimer: 0,
  selectedModel: "",
  selectedReasoningEffort: "",
  inlineEffortMenuOpen: false,
  inlineEffortMenuForModel: "",
  openingThreadReqId: 0,
  pendingThreadResumes: new Map(),
  // When we open the mobile drawer on pointerdown, some environments (touch WebViews / remote-control)
  // may synthesize a subsequent click that retargets to the backdrop and immediately closes it.
  // Suppress click-close for a short window after open.
  suppressSyntheticClickUntil: 0,
  // FlatList-like: for very large histories, render only the most recent window and allow loading older
  // messages on-demand. This keeps the UI responsive while opening.
  historyWindowEnabled: false,
  historyWindowThreadId: "",
  historyWindowStart: 0,
  historyWindowSize: 160,
  historyWindowChunk: 120,
  historyWindowLoading: false,
  historyAllMessages: [],
};

function armSyntheticClickSuppression(ms = 380) {
  state.suppressSyntheticClickUntil = Date.now() + Math.max(0, Number(ms) || 0);
}

function shouldSuppressSyntheticClick(event) {
  if (!event || String(event.type || "") !== "click") return false;
  const now = Date.now();
  if (now <= Number(state.suppressSyntheticClickUntil || 0)) {
    state.suppressSyntheticClickUntil = 0;
    try {
      event?.preventDefault?.();
      event?.stopPropagation?.();
    } catch {}
    return true;
  }
  return false;
}

const GUIDE_DISMISSED_KEY = "web_codex_guide_dismissed_v2";
const TOKEN_STORAGE_KEY = "web_codex_token_v1";
const WORKSPACE_TARGET_KEY = "web_codex_workspace_target_v1";
const FAVORITE_THREADS_KEY = "web_codex_favorite_threads_v1";
const SELECTED_MODEL_KEY = "web_codex_selected_model_v1";
const REASONING_EFFORT_KEY = "web_codex_reasoning_effort_v1";
const LAST_EVENT_ID_KEY = "web_codex_last_event_id_v1";
// Marker keys: older builds wrote model/effort into localStorage automatically (not user intent).
// Only honor persisted selections when the user explicitly picked them.
const MODEL_USER_SELECTED_KEY = "web_codex_model_user_selected_v1";
const EFFORT_USER_SELECTED_KEY = "web_codex_effort_user_selected_v1";
const SANDBOX_MODE =
  window.__WEB_CODEX_SANDBOX__ === true ||
  window.location.pathname.startsWith("/sandbox/") ||
  new URLSearchParams(window.location.search).get("sandbox") === "1";
const THREAD_PULL_REFRESH_TRIGGER_PX = 44;
const THREAD_PULL_REFRESH_MAX_PX = 84;
const THREAD_PULL_REFRESH_MIN_MS = 520;
const THREAD_PULL_HINT_CLEAR_DELAY_MS = 160;
const THREAD_REFRESH_DEBOUNCE_MS = 260;
// When WS is connected, prefer event-driven updates. Keep only a low-frequency safety refresh.
const THREAD_AUTO_REFRESH_CONNECTED_MS = 20000;
const THREAD_AUTO_REFRESH_DISCONNECTED_MS = 3500;
const ACTIVE_THREAD_REFRESH_DEBOUNCE_MS = 380;
const ACTIVE_THREAD_LIVE_POLL_MS = 1500;
// Even with WS subscribed, keep a low-frequency HTTP safety poll for the active thread.
// Some thread updates may not emit JSON-RPC notifications (e.g., external/file-based writers),
// and relying on WS alone can leave the UI stale until a manual refresh.
const ACTIVE_THREAD_LIVE_POLL_WS_FALLBACK_MS = 3000;
const MODEL_LOADING_MIN_MS = 1000;
const RECENT_EVENT_ID_CACHE_SIZE = 2048;
const MOBILE_PROMPT_MIN_HEIGHT_PX = 40;
const MOBILE_PROMPT_MAX_HEIGHT_PX = 420;
const CHAT_LIVE_FOLLOW_MAX_STEP_PX = 64;
const CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS = 66;

function dbgSet(patch) {
  try {
    window.__webCodexDbg = Object.assign(window.__webCodexDbg || {}, patch || {});
  } catch {}
}

function getEmbeddedToken() {
  const raw = "";
  return raw;
}

function byId(id) {
  return document.getElementById(id);
}

const HISTORY_WINDOW_THRESHOLD = 420;

function bindClick(id, handler) {
  const el = byId(id);
  if (!el) return;
  el.onclick = handler;
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

  // Cancel any in-flight swap.
  try {
    if (el.__swapTimer) clearTimeout(el.__swapTimer);
  } catch {}
  el.__swapTimer = 0;

  const wasHidden = String(el.style.display || "").trim() === "none" || getComputedStyle(el).display === "none";
  const prev = String(el.textContent || "");

  if (wasHidden && wantVisible) {
    // Fade-in from hidden.
    if (displayWhenVisible) el.style.display = displayWhenVisible;
    else el.style.removeProperty("display");
    el.textContent = want;
    el.classList.add(cls);
    requestAnimationFrame(() => {
      try {
        void el.offsetWidth;
        el.classList.remove(cls);
      } catch {}
    });
    return;
  }

  if (!wantVisible) {
    if (wasHidden) return;
    // Fade-out, then hide.
    el.classList.add(cls);
    el.__swapTimer = setTimeout(() => {
      try {
        el.textContent = "";
        el.style.display = "none";
        el.classList.remove(cls);
      } catch {}
    }, 120);
    return;
  }

  if (prev === want) return;
  // Fade-out, swap text, fade-in.
  el.classList.add(cls);
  el.__swapTimer = setTimeout(() => {
    try {
      el.textContent = want;
      void el.offsetWidth;
      el.classList.remove(cls);
    } catch {}
  }, 120);
}

function mobilePromptMaxHeightPx() {
  if (typeof window === "undefined") return MOBILE_PROMPT_MAX_HEIGHT_PX;
  const fromViewport = Math.floor(window.innerHeight * 0.45);
  return Math.max(132, Math.min(MOBILE_PROMPT_MAX_HEIGHT_PX, fromViewport));
}

function registerPendingThreadResume(threadId, promise) {
  if (!threadId || !promise) return;
  state.pendingThreadResumes.set(threadId, promise);
  promise.finally(() => {
    if (state.pendingThreadResumes.get(threadId) === promise) {
      state.pendingThreadResumes.delete(threadId);
    }
  });
}

async function waitPendingThreadResume(threadId) {
  if (!threadId) return;
  const pending = state.pendingThreadResumes.get(threadId);
  if (!pending) return;
  try {
    await pending;
  } catch (_) {
    // Keep send flow resilient; resume errors are surfaced by status updates.
  }
}

function toRecord(value) {
  return value && typeof value === "object" ? value : null;
}

function readString(value) {
  return typeof value === "string" ? value : null;
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resetEventReplayState() {
  state.wsLastEventId = 0;
  state.wsRecentEventIds = new Set();
  state.wsRecentEventIdQueue = [];
  try {
    localStorage.removeItem(LAST_EVENT_ID_KEY);
  } catch {}
}

function markEventIdSeen(eventId) {
  if (!Number.isInteger(eventId) || eventId < 1) return;
  state.wsRecentEventIds.add(eventId);
  state.wsRecentEventIdQueue.push(eventId);
  while (state.wsRecentEventIdQueue.length > RECENT_EVENT_ID_CACHE_SIZE) {
    const removed = state.wsRecentEventIdQueue.shift();
    if (Number.isInteger(removed)) state.wsRecentEventIds.delete(removed);
  }
}

function extractNotificationEventId(notification) {
  const record = toRecord(notification);
  const id = readNumber(record?.eventId) ?? readNumber(record?.event_id);
  if (id === null) return null;
  const normalized = Math.floor(id);
  return normalized > 0 ? normalized : null;
}

function extractNotificationThreadId(notification) {
  const record = toRecord(notification);
  const params = toRecord(record?.params);
  const msg = toRecord(params?.msg);
  const thread = toRecord(params?.thread) || toRecord(params?.threadState) || toRecord(params?.thread_state);
  const turn = toRecord(params?.turn) || toRecord(params?.turnState) || toRecord(params?.turn_state);
  const item = toRecord(params?.item) || toRecord(params?.itemState) || toRecord(params?.item_state);
  const source = toRecord(params?.source) || toRecord(msg?.source);
  const subagent = toRecord(toRecord(source?.subagent)?.thread_spawn);

  const deepFindThreadId = (root, maxDepth = 6) => {
    const keys = new Set(["thread_id", "threadId", "conversation_id", "conversationId"]);
    const seen = new Set();
    const walk = (value, depth) => {
      if (!value || depth > maxDepth) return null;
      if (typeof value !== "object") return null;
      if (seen.has(value)) return null;
      seen.add(value);
      if (Array.isArray(value)) {
        for (let i = 0; i < Math.min(value.length, 40); i += 1) {
          const found = walk(value[i], depth + 1);
          if (found) return found;
        }
        return null;
      }
      for (const k of Object.keys(value)) {
        if (keys.has(k)) {
          const found = readString(value[k]);
          if (found) return found;
        }
      }
      for (const k of Object.keys(value)) {
        const found = walk(value[k], depth + 1);
        if (found) return found;
      }
      return null;
    };
    return walk(root, 0);
  };

  return (
    readString(msg?.thread_id) ||
    readString(msg?.threadId) ||
    readString(msg?.conversation_id) ||
    readString(msg?.conversationId) ||
    readString(params?.thread_id) ||
    readString(params?.threadId) ||
    readString(thread?.id) ||
    readString(thread?.thread_id) ||
    readString(thread?.threadId) ||
    readString(turn?.thread_id) ||
    readString(turn?.threadId) ||
    readString(item?.thread_id) ||
    readString(item?.threadId) ||
    readString(source?.thread_id) ||
    readString(source?.threadId) ||
    readString(source?.parent_thread_id) ||
    readString(source?.parentThreadId) ||
    readString(subagent?.parent_thread_id) ||
    deepFindThreadId(params) ||
    null
  );
}

function shouldRefreshThreadsFromNotification(method) {
  return (
    method.startsWith("thread/") ||
    method.startsWith("turn/") ||
    method.startsWith("item/") ||
    method.startsWith("codex/event/")
  );
}

function shouldRefreshActiveThreadFromNotification(method) {
  return (
    method.startsWith("thread/") ||
    method.startsWith("turn/") ||
    method.startsWith("item/") ||
    method.startsWith("codex/event/") ||
    method === "thread/name/updated" ||
    method === "thread/status/changed"
  );
}

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

function scheduleThreadRefresh(delayMs = THREAD_REFRESH_DEBOUNCE_MS) {
  if (state.scheduledRefreshTimer) clearTimeout(state.scheduledRefreshTimer);
  state.scheduledRefreshTimer = setTimeout(() => {
    state.scheduledRefreshTimer = null;
    refreshThreads(getWorkspaceTarget(), { force: false, silent: true }).catch(() => {});
  }, delayMs);
}

function scheduleActiveThreadRefresh(threadId, delayMs = ACTIVE_THREAD_REFRESH_DEBOUNCE_MS) {
  if (!threadId || threadId !== state.activeThreadId) return;
  if (state.activeThreadRefreshTimer) clearTimeout(state.activeThreadRefreshTimer);
  state.activeThreadRefreshTimer = setTimeout(async () => {
    state.activeThreadRefreshTimer = null;
    const activeId = state.activeThreadId || "";
    if (!activeId || activeId !== threadId) return;
    if (state.activeThreadId !== threadId) return;
    loadThreadMessages(threadId, { animateBadge: false }).catch(() => {});
  }, delayMs);
}

function normalizeWorkspaceTarget(value) {
  return value === "wsl2" ? "wsl2" : "windows";
}

function getWorkspaceTarget() {
  return normalizeWorkspaceTarget(state.workspaceTarget || "windows");
}

function getWorkspaceLabel() {
  return getWorkspaceTarget() === "wsl2" ? "Bridge WSL2 workspace" : "Bridge Windows workspace";
}

function getActiveWorkspaceBadgeLabel() {
  return state.activeThreadWorkspace === "wsl2" ? "WSL2" : "WIN";
}

function syncActiveThreadMetaFromList(threadId = state.activeThreadId) {
  if (!threadId) return;
  const thread = state.threadItemsAll.find((item) => (item?.id || item?.threadId || "") === threadId);
  if (!thread) return;
  const target = detectThreadWorkspaceTarget(thread);
  if (target !== "unknown") state.activeThreadWorkspace = target;
  const rolloutPath = String(thread?.path || "").trim();
  if (rolloutPath) state.activeThreadRolloutPath = rolloutPath;
}

function updateHeaderUi(animateBadge = false) {
  const panelTitle = document.querySelector(".chatPanel .panelHeader .panelTitle");
  const headerSwitch = byId("headerWorkspaceSwitch");
  const headerBadge = byId("headerWorkspaceBadge");
  const modelPicker = byId("headerModelPicker");
  const modelLabel = byId("headerModelLabel");
  const headerEffort = byId("headerReasoningEffort");
  const headerChevron = modelPicker ? modelPicker.querySelector(".headerModelChevron") : null;
  const inSettings = state.activeMainTab === "settings";
  const showBadge = !inSettings && state.activeThreadStarted;
  // Always prefer the currently selected model (the one we'll use for new turns).
  const displayModel = state.modelOptionsLoading || !String(state.selectedModel || "").trim()
    ? "Loading models..."
    : (compactModelLabel(state.selectedModel) || "Codex");
  const displayTitle = displayModel;

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
  const active = options.find((x) => x && x.id === state.selectedModel) || null;
  const supported = Array.isArray(active?.supportedReasoningEfforts) ? active.supportedReasoningEfforts : [];
  const showEffort = !inSettings && !state.modelOptionsLoading && supported.length > 0;
  const effortText = (() => {
    if (!showEffort) return "";
    const fallback = String(active.defaultReasoningEffort || supported[0]?.effort || "").trim();
    const allowPersisted = String(localStorage.getItem(EFFORT_USER_SELECTED_KEY) || "").trim() === "1";
    const persisted = allowPersisted ? String(localStorage.getItem(REASONING_EFFORT_KEY) || "").trim() : "";
    return String(persisted || state.selectedReasoningEffort || fallback || "").trim();
  })();

  // Keep model + effort + chevron swaps in sync: no intermediate "Loading models...  medium",
  // and no chevron popping in early/late relative to the text.
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
      // First paint after loading ends: reveal model + effort + chevron together.
      state.headerModelWasLoading = false;
      state.headerModelSwapInProgress = true;
      clearHeaderSwapTimer();

      clearTimers(modelLabel);
      clearTimers(headerEffort);

      // Fade out "Loading models..." then fade in model + effort + chevron in sync.
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
          // Ensure chevron isn't still under "loading" (loading disables transitions on the chevron).
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
    } else {
      // If an intro swap is in progress, don't interfere (don't cancel timers / don't desync).
      if (!state.headerModelSwapInProgress) {
        swapText(modelLabel, displayTitle, { hideWhenEmpty: false });
        swapText(headerEffort, effortText, { hideWhenEmpty: true, displayWhenVisible: "inline-block" });
      }
    }
  } else if (modelLabel) {
    // Fallback: label only.
    if (displayTitle === "Loading models...") modelLabel.textContent = displayTitle;
    else swapText(modelLabel, displayTitle, { hideWhenEmpty: false });
  }

  // Chevron visibility:
  // - Hide while models are loading
  // - Also hide during the first "loading -> model" intro swap, so chevron appears in sync
  //   with model + effort.
  if (modelPicker) {
    const loadingUi = !!(!inSettings && (state.modelOptionsLoading || state.headerModelSwapInProgress));
    modelPicker.classList.toggle("loading", loadingUi);
  }
  if (inSettings) setHeaderModelMenuOpen(false);

  // Disable model picker interaction until models are loaded.
  {
    const trigger = byId("headerModelTrigger");
    if (trigger) {
      const disabled = !!(!inSettings && state.modelOptionsLoading);
      trigger.setAttribute("aria-disabled", disabled ? "true" : "false");
      trigger.classList.toggle("disabled", disabled);
      trigger.style.pointerEvents = disabled ? "none" : "auto";
    }
  }

  // Note: headerEffort is handled together with modelLabel above to keep swaps in sync.

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
    // Force reflow so repeated toggles replay the transition.
    void headerBadge.offsetWidth;
    headerBadge.classList.add("enter");
  } else {
    headerBadge.classList.remove("enter");
  }
}

function normalizeModelOption(item) {
  if (!item || typeof item !== "object") return null;
  const id =
    String(item.id || item.model || item.name || "").trim();
  if (!id) return null;
  const label = String(item.displayName || item.title || item.name || id).trim() || id;
  const isDefault = !!(item.isDefault || item.default || item.recommended);
  const supportedReasoningEfforts = ensureArrayItems(item.supportedReasoningEfforts).map((x) => {
    if (!x || typeof x !== "object") return null;
    const effort = String(x.reasoningEffort || x.effort || "").trim();
    if (!effort) return null;
    return {
      effort,
      description: String(x.description || "").trim(),
    };
  }).filter(Boolean);
  const defaultReasoningEffort = String(item.defaultReasoningEffort || "").trim();
  return { id, label, isDefault, supportedReasoningEfforts, defaultReasoningEffort };
}

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
  let el = document.getElementById("effortInlineOverlay");
  if (el) return el;
  el = document.createElement("div");
  el.id = "effortInlineOverlay";
  el.className = "effortInlineOverlay";
  el.setAttribute("role", "listbox");
  el.setAttribute("aria-label", "Reasoning effort");
  document.body.appendChild(el);
  return el;
}

function closeInlineEffortOverlay() {
  const el = document.getElementById("effortInlineOverlay");
  if (!el) return;
  el.classList.remove("show");
  el.innerHTML = "";
  // Keep the trigger state consistent (aria-expanded).
  try {
    const menu = byId("headerModelMenu");
    for (const trigger of Array.from(menu?.querySelectorAll?.(".effortSubChevron[aria-expanded='true']") || [])) {
      trigger.setAttribute("aria-expanded", "false");
    }
  } catch {}
}

function openInlineEffortOverlay(anchorEl, model) {
  if (!anchorEl || !model) return;
  const supported = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
  if (!supported.length) return;

  const overlay = ensureInlineEffortOverlay();
  // Ensure the browser has a non-`display:none` baseline style so the fade/slide transition can run.
  overlay.classList.remove("show");
  // Force style flush (especially important on first mount / some mobile webviews).
  void overlay.offsetWidth;
  const fallback = String(model.defaultReasoningEffort || supported[0]?.effort || "").trim();
  const allowPersisted = String(localStorage.getItem(EFFORT_USER_SELECTED_KEY) || "").trim() === "1";
  const persisted = allowPersisted ? String(localStorage.getItem(REASONING_EFFORT_KEY) || "").trim() : "";
  const cur = String(persisted || state.selectedReasoningEffort || fallback || "").trim();

  overlay.innerHTML = supported
    .map((x) => {
      const effort = String(x?.effort || "").trim();
      if (!effort) return "";
      const title = String(x?.description || "").trim();
      const active = effort === cur ? " active" : "";
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return (
        `<div class="effortInlineOption${active}" role="option" aria-selected="${effort === cur ? "true" : "false"}" data-effort="${escapeAttr(effort)}"${titleAttr}>` +
        `<span class="label">${escapeHtml(effort)}</span>` +
        `<span class="effortCheck" aria-hidden="true">✓</span>` +
        `</div>`
      );
    })
    .filter(Boolean)
    .join("");

  // Position: place the effort submenu to the RIGHT of the model menu (ChatGPT-style),
  // vertically aligned near the clicked chevron.
  const r = anchorEl.getBoundingClientRect();
  const menuEl = byId("headerModelMenu") || byId("headerModelPicker");
  const menuRect = menuEl ? menuEl.getBoundingClientRect() : null;
  const padding = 6;
  const baseLeft = menuRect ? menuRect.right + 2 : r.right + 2;
  const baseTop = Math.max(padding, Math.min(window.innerHeight - padding, r.top - 6));
  overlay.style.left = `${Math.round(baseLeft)}px`;
  overlay.style.top = `${Math.round(baseTop)}px`;
  overlay.style.transformOrigin = "top left";
  overlay.classList.add("show");

  // Sync trigger state to "open".
  try {
    anchorEl.setAttribute?.("aria-expanded", "true");
  } catch {}

  // After visible, adjust to keep within viewport.
  requestAnimationFrame(() => {
    try {
      const or = overlay.getBoundingClientRect();
      let left = or.left;
      let top = or.top;
      if (or.right > window.innerWidth - padding) {
        // Flip to the left side of the model menu if needed.
        left = menuRect ? Math.max(padding, menuRect.left - 10 - or.width) : Math.max(padding, r.left - 10 - or.width);
        overlay.style.transformOrigin = "top right";
      }
      if (or.left < padding) left = padding;
      if (or.bottom > window.innerHeight - padding) top = Math.max(padding, window.innerHeight - padding - or.height);
      overlay.style.left = `${Math.round(left)}px`;
      overlay.style.top = `${Math.round(top)}px`;
    } catch {}
  });

  // Wire clicks.
  for (const opt of Array.from(overlay.querySelectorAll(".effortInlineOption"))) {
    opt.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const effort = String(opt.getAttribute("data-effort") || "").trim();
      if (!effort) return;
      state.selectedReasoningEffort = effort;
      localStorage.setItem(REASONING_EFFORT_KEY, effort);
      localStorage.setItem(EFFORT_USER_SELECTED_KEY, "1");
      state.inlineEffortMenuOpen = false;
      state.inlineEffortMenuForModel = "";
      closeInlineEffortOverlay();
      updateHeaderUi();
      // After selecting an effort, close both menus (matches expected UX).
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
    const muted = document.createElement("div");
    muted.className = "muted";
    muted.textContent = "No models available";
    menu.appendChild(muted);
    return;
  }

  const current = state.selectedModel || options.find((item) => item.isDefault)?.id || options[0].id;
  if (state.inlineEffortMenuForModel && state.inlineEffortMenuForModel !== current) {
    state.inlineEffortMenuOpen = false;
    state.inlineEffortMenuForModel = "";
    closeInlineEffortOverlay();
  }
  for (const model of options) {
    const optionBtn = document.createElement("button");
    optionBtn.type = "button";
    optionBtn.className = `headerModelOption${model.id === current ? " active" : ""}`;
    optionBtn.setAttribute("role", "option");
    optionBtn.setAttribute("aria-selected", model.id === current ? "true" : "false");

    // Inline effort selector lives to the RIGHT of the ACTIVE model option only.
    // UX: always show a right chevron on each model row. Clicking it opens the effort submenu to the right.
    // If the model doesn't support efforts, chevron is disabled but still reserves space so menu width is stable.
    const supported = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
    const canOpenEffort = supported.length > 0;
    const inlineOpen = !!(state.inlineEffortMenuOpen && state.inlineEffortMenuForModel === model.id);
    const effortHtml =
      `<span class="effortSubChevron${canOpenEffort ? "" : " disabled"}" role="button" tabindex="${canOpenEffort ? "0" : "-1"}" aria-haspopup="listbox" aria-expanded="${inlineOpen ? "true" : "false"}" aria-disabled="${canOpenEffort ? "false" : "true"}" data-model-id="${escapeAttr(model.id)}">` +
      `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">` +
      `<path d="M4.5 6.2l3.5 3.6 3.5-3.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>` +
      `</svg>` +
      `</span>`;

    optionBtn.innerHTML =
      `<span class="modelLabel">${escapeHtml(compactModelLabel(model.label || model.id))}</span>` +
      `<span class="modelRight">${effortHtml}</span>`;
    const onSelectModel = (event) => {
      event.preventDefault();
      // Prevent the document-level click handler from closing the menu after we re-render the list.
      // Without this, re-rendering detaches `event.target` from the picker, and `contains()` becomes false.
      event.stopPropagation();
      // If the user clicked the inline reasoning-effort control, do NOT select/close the model menu.
      // Some webviews still dispatch a click on the parent <button> even if the child stops propagation,
      // so we double-guard here.
      const target = event?.target;
      // Chevron is indicator-only; no special-case needed.
 
      state.selectedModel = model.id;
      try {
        localStorage.setItem(SELECTED_MODEL_KEY, state.selectedModel);
        localStorage.setItem(MODEL_USER_SELECTED_KEY, "1");
      } catch {}

      // Keep the model menu open so the user can immediately pick reasoning effort without re-opening.
      // If the current effort isn't supported by the new model, fall back to the model default.
      if (supported.length) {
        const currentEffort = String(localStorage.getItem(REASONING_EFFORT_KEY) || state.selectedReasoningEffort || "").trim();
        const ok = currentEffort && supported.some((x) => x && x.effort === currentEffort);
        const next = ok ? currentEffort : String(model.defaultReasoningEffort || supported[0]?.effort || "").trim();
        if (next) {
          state.selectedReasoningEffort = next;
          localStorage.setItem(REASONING_EFFORT_KEY, next);
        }
        // Auto-open effort submenu on model selection.
        state.inlineEffortMenuOpen = true;
        state.inlineEffortMenuForModel = model.id;
      } else {
        state.inlineEffortMenuOpen = false;
        state.inlineEffortMenuForModel = "";
      }
      renderHeaderModelMenu();
      updateHeaderUi();

      if (supported.length) {
        requestAnimationFrame(() => {
          const activeChevron = menu.querySelector(".headerModelOption.active .effortSubChevron");
          const options2 = Array.isArray(state.modelOptions) ? state.modelOptions : [];
          const activeModel = options2.find((x) => x && x.id === state.selectedModel) || null;
          if (activeChevron && activeModel) openInlineEffortOverlay(activeChevron, activeModel);
        });
      } else {
        closeInlineEffortOverlay();
      }
    };
    // Prefer pointerdown for responsiveness on mobile WebViews (click can be delayed/dropped under load).
    // Keep click for keyboard activation + legacy fallback.
    optionBtn.__skipNextClick = false;
    optionBtn.addEventListener("pointerdown", (event) => {
      optionBtn.__skipNextClick = true;
      onSelectModel(event);
    }, { passive: false });
    optionBtn.addEventListener("click", (event) => {
      if (optionBtn.__skipNextClick) {
        optionBtn.__skipNextClick = false;
        return;
      }
      onSelectModel(event);
    });
    menu.appendChild(optionBtn);
  }

  // Effort chevron is an indicator only; selecting a model row opens the submenu automatically.
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
  const allowPersistedModel = String(localStorage.getItem(MODEL_USER_SELECTED_KEY) || "").trim() === "1";
  const persistedModel = allowPersistedModel ? String(localStorage.getItem(SELECTED_MODEL_KEY) || "").trim() : "";
  const preferred = persistedModel || state.selectedModel;
  const latest = pickLatestModelId(options);
  const selected = preferred && options.some((item) => item.id === preferred)
    ? preferred
    : latest || options.find((item) => item.isDefault)?.id || options[0].id;
  state.selectedModel = selected;
  try {
    localStorage.setItem(SELECTED_MODEL_KEY, selected);
  } catch {}

  // Pick reasoning effort: prefer persisted value if supported by the selected model, otherwise use model default.
  const active = options.find((x) => x.id === selected) || options[0];
  const supported = Array.isArray(active?.supportedReasoningEfforts) ? active.supportedReasoningEfforts : [];
  const allowPersistedEffort = String(localStorage.getItem(EFFORT_USER_SELECTED_KEY) || "").trim() === "1";
  const persisted = allowPersistedEffort ? String(localStorage.getItem(REASONING_EFFORT_KEY) || "").trim() : "";
  if (supported.length) {
    const ok = persisted && supported.some((x) => x && x.effort === persisted);
    const hasMedium = supported.some((x) => String(x?.effort || "").trim() === "medium");
    const next = ok
      ? persisted
      : (hasMedium ? "medium" : String(active.defaultReasoningEffort || supported[0]?.effort || "").trim());
    state.selectedReasoningEffort = next;
    if (next) localStorage.setItem(REASONING_EFFORT_KEY, next);
  } else {
    state.selectedReasoningEffort = persisted;
  }
  renderHeaderModelMenu();
  updateHeaderUi();
}

async function refreshModels() {
  state.modelOptionsLoadingSeq = Number(state.modelOptionsLoadingSeq || 0) + 1;
  const seq = state.modelOptionsLoadingSeq;
  state.modelOptionsLoading = true;
  state.modelOptionsLoadingStartedAt = performance.now();
  updateHeaderUi();
  try {
    const data = await api("/codex/models");
    const rawItems = ensureArrayItems(data.items);
    const mapped = [];
    for (const item of rawItems) {
      const normalized = normalizeModelOption(item);
      if (normalized) mapped.push(normalized);
    }
    state.modelOptions = mapped;
    syncHeaderModelPicker();
  } finally {
    const elapsed = performance.now() - Number(state.modelOptionsLoadingStartedAt || 0);
    const remaining = Math.max(0, MODEL_LOADING_MIN_MS - elapsed);
    if (remaining > 0) await waitMs(remaining);

    // If a newer refresh started, don't clear its loading flag.
    if (state.modelOptionsLoadingSeq !== seq) return;

    state.modelOptionsLoading = false;
    updateHeaderUi();
  }
}

function hasDualWorkspaceTargets() {
  return !!(state.workspaceAvailability.windowsInstalled && state.workspaceAvailability.wsl2Installed);
}

function isWorkspaceAvailable(target) {
  return target === "wsl2"
    ? !!state.workspaceAvailability.wsl2Installed
    : !!state.workspaceAvailability.windowsInstalled;
}

function applyWorkspaceUi() {
  const target = getWorkspaceTarget();
  const winBtn = byId("workspaceWindowsBtn");
  const wslBtn = byId("workspaceWslBtn");
  const drawerWinBtn = byId("drawerWorkspaceWindowsBtn");
  const drawerWslBtn = byId("drawerWorkspaceWslBtn");
  const drawerSwitch = byId("drawerWorkspaceSwitch");
  const canUseWindows = isWorkspaceAvailable("windows");
  const canUseWsl2 = isWorkspaceAvailable("wsl2");
  if (drawerSwitch) drawerSwitch.style.display = "";

  if (winBtn) winBtn.disabled = !canUseWindows;
  if (wslBtn) wslBtn.disabled = !canUseWsl2;
  if (drawerWinBtn) drawerWinBtn.disabled = !canUseWindows;
  if (drawerWslBtn) drawerWslBtn.disabled = !canUseWsl2;

  if (winBtn) winBtn.classList.toggle("active", target === "windows");
  if (wslBtn) wslBtn.classList.toggle("active", target === "wsl2");
  if (drawerWinBtn) drawerWinBtn.classList.toggle("active", target === "windows");
  if (drawerWslBtn) drawerWslBtn.classList.toggle("active", target === "wsl2");
  const label = getWorkspaceLabel();
  const drawer = byId("drawerWorkspaceText");
  const welcome = byId("welcomeWorkspaceText");
  if (drawer) drawer.textContent = label;
  if (welcome) welcome.textContent = label;
  updateHeaderUi();
}

function detectThreadWorkspaceTarget(thread) {
  const raw = String(
    thread?.workspace || thread?.cwd || thread?.project || thread?.directory || thread?.path || ""
  ).trim();
  if (!raw) return "unknown";
  const text = raw.toLowerCase();
  if (text === "wsl2" || text === "wsl") return "wsl2";
  if (text === "windows" || text === "win") return "windows";
  if (
    text.startsWith("/") ||
    text.startsWith("\\\\wsl$\\") ||
    text.startsWith("\\\\wsl.localhost\\") ||
    text.includes("\\\\wsl$\\") ||
    text.includes("\\\\wsl.localhost\\") ||
    text.includes("/mnt/") ||
    text.includes(" wsl") ||
    text.includes("\\wsl$")
  ) {
    return "wsl2";
  }
  if (/^[a-z]:[\\/]/i.test(raw) || raw.includes(":\\") || raw.includes("\\\\")) {
    return "windows";
  }
  return "unknown";
}

function shouldRenderThreadForCurrentTarget(thread) {
  if (!hasDualWorkspaceTargets()) return true;
  const target = detectThreadWorkspaceTarget(thread);
  if (target === "unknown") return true;
  return target === getWorkspaceTarget();
}

function applyThreadFilter() {
  state.threadItems = sortThreadsByNewest(state.threadItemsAll.filter(shouldRenderThreadForCurrentTarget));
  renderThreads(state.threadItems);
}

function updateWorkspaceAvailabilityFromThreads(items) {
  if (!Array.isArray(items) || !items.length) return;
  let hasWindows = !!state.workspaceAvailability.windowsInstalled;
  let hasWsl2 = !!state.workspaceAvailability.wsl2Installed;
  for (const thread of items) {
    const target = detectThreadWorkspaceTarget(thread);
    if (target === "windows") hasWindows = true;
    if (target === "wsl2") hasWsl2 = true;
    if (hasWindows && hasWsl2) break;
  }
  updateWorkspaceAvailability(hasWindows, hasWsl2);
}

function updateWorkspaceAvailability(windowsInstalled, wsl2Installed) {
  state.workspaceAvailability = {
    windowsInstalled: !!windowsInstalled,
    wsl2Installed: !!wsl2Installed,
  };
  // Never auto-switch workspace target here.
  // Policy: default is windows; after user selection, keep that choice until user changes it.
  applyWorkspaceUi();
  if (state.threadItemsAll.length) applyThreadFilter();
}

async function setWorkspaceTarget(nextTarget) {
  const target = normalizeWorkspaceTarget(nextTarget);
  if (!isWorkspaceAvailable(target)) return;
  if (state.workspaceTarget === target) return;
  state.workspaceTarget = target;
  state.collapsedWorkspaceKeys.clear();
  localStorage.setItem(WORKSPACE_TARGET_KEY, target);
  applyWorkspaceUi();
  setStatus(`Workspace target: ${target.toUpperCase()}`);
  const cached = Array.isArray(state.threadItemsByWorkspace[target])
    ? state.threadItemsByWorkspace[target]
    : [];
  if (cached.length) {
    state.threadItemsAll = cached;
    syncActiveThreadMetaFromList();
    applyThreadFilter();
    updateHeaderUi();
  } else {
    // Avoid showing stale chats from the previous workspace while the new list is loading.
    state.threadItemsAll = [];
    syncActiveThreadMetaFromList();
    state.threadListLoading = true;
    state.threadListLoadingTarget = target;
    applyThreadFilter();
    updateHeaderUi();
    setStatus(`Loading ${target.toUpperCase()} chats...`);
  }
  refreshThreads(target, { force: true }).catch((e) => setStatus(e.message, true));
}

function blockInSandbox(actionLabel) {
  if (!SANDBOX_MODE) return false;
  setStatus(`Sandbox mode: ${actionLabel} is disabled.`, true);
  return true;
}

function updateNotificationState() {
  if (!("Notification" in window)) {
    byId("notifState").textContent = "Notification: unsupported";
    return;
  }
  byId("notifState").textContent = `Notification: ${Notification.permission}`;
}

function maybeNotifyTurnDone(text) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification("Codex turn completed", { body: (text || "Completed").slice(0, 120) });
  } catch {
    // ignore notification errors
  }
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(input) {
  // We only interpolate simple string attributes (e.g. title, data-*); use the same escaping as HTML.
  return escapeHtml(input);
}

function compactModelLabel(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  return text.startsWith("gpt-") ? text.slice(4) : text;
}

function parseModelRankParts(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return { major: 0, minor: 0, date: 0, isCodex: 0, text: "" };
  const isCodex = /\bcodex\b/i.test(id) ? 1 : 0;
  // Common shapes:
  // - gpt-5.3-codex
  // - gpt-5.2-2025-12-11
  // - gpt-5.2
  const ver = /\bgpt-(\d+)(?:\.(\d+))?/i.exec(id);
  const major = ver ? Number(ver[1] || 0) : 0;
  const minor = ver ? Number(ver[2] || 0) : 0;
  const dm = /-(\d{4})-(\d{2})-(\d{2})(?:\b|_)/.exec(id);
  const date = dm ? Number(`${dm[1]}${dm[2]}${dm[3]}`) : 0;
  return { major: Number.isFinite(major) ? major : 0, minor: Number.isFinite(minor) ? minor : 0, date, isCodex, text: id };
}

function pickLatestModelId(options) {
  const list = Array.isArray(options) ? options.filter(Boolean) : [];
  if (!list.length) return "";
  const codexOnly = list.filter((x) => /\bcodex\b/i.test(String(x?.id || "")));
  const pool = codexOnly.length ? codexOnly : list;
  let best = pool[0];
  let bestKey = parseModelRankParts(best?.id);
  for (const item of pool) {
    const key = parseModelRankParts(item?.id);
    // Prefer higher major/minor, then newer date stamp, then codex (within mixed pools), then stable text compare.
    if (key.major !== bestKey.major) {
      if (key.major > bestKey.major) { best = item; bestKey = key; }
      continue;
    }
    if (key.minor !== bestKey.minor) {
      if (key.minor > bestKey.minor) { best = item; bestKey = key; }
      continue;
    }
    if (key.date !== bestKey.date) {
      if (key.date > bestKey.date) { best = item; bestKey = key; }
      continue;
    }
    if (key.isCodex !== bestKey.isCodex) {
      if (key.isCodex > bestKey.isCodex) { best = item; bestKey = key; }
      continue;
    }
    if (String(key.text) > String(bestKey.text)) { best = item; bestKey = key; }
  }
  return String(best?.id || "").trim();
}

function inModelMenu(node) {
  return !!(node && node.closest && node.closest("#headerModelPicker"));
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isDottedIdentifierPath(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("/") || text.includes("\\") || text.includes(":")) return false;
  return /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(text);
}

function looksLikeFileRef(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
  const text = quoted ? String(quoted[2] || "").trim() : raw;
  if (!text) return false;
  if (isDottedIdentifierPath(text)) return false;
  if (/^[\\/]+$/.test(text)) return false;
  if (/^%[A-Za-z0-9_]+%(?:[\\/]+)?$/.test(text)) return false;
  if (/^[a-z]:(?:[\\/]+)?$/i.test(text)) return false;
  const hasPathSeparator = text.includes("/") || text.includes("\\");
  const hasAbsolutePrefix =
    /^%[A-Za-z0-9_]+%[\\/]/.test(text) ||
    /^[a-z]:[\\/]/i.test(text) ||
    text.startsWith("/") ||
    text.startsWith("\\\\");
  if (!hasPathSeparator && !hasAbsolutePrefix) return false;
  return (
    /^%[A-Za-z0-9_]+%[\\/]/.test(text) ||
    /^[a-z]:[\\/]/i.test(text) ||
    text.startsWith("/") ||
    text.startsWith("\\\\") ||
    /[^\\/\s][\\/][^\\/\s]/.test(text) ||
    /(?:^|[\\/])[^\\/\s]+\.[a-z0-9]{1,8}(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?$/i.test(text)
  );
}

function fileRefDisplayLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let suffix = "";
  let base = text;
  const hashMatch = base.match(/(#L\d+(?:C\d+)?)$/i);
  if (hashMatch) {
    suffix = hashMatch[1];
    base = base.slice(0, -suffix.length);
  } else {
    const colonMatch = base.match(/(:\d+(?::\d+)?)$/);
    if (colonMatch) {
      suffix = colonMatch[1];
      base = base.slice(0, -suffix.length);
    }
  }
  const normalized = base.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const fileName = parts[parts.length - 1] || normalized || text;
  return `${fileName}${suffix}`;
}

function buildMessageLink(label, href, preferFileLabel = false) {
  const rawHref = String(href || "").trim();
  const rawLabel = String(label || rawHref).trim();
  const shouldUseFileLabel =
    !!preferFileLabel || looksLikeFileRef(rawLabel) || looksLikeFileRef(rawHref);
  const fileLabelSource = looksLikeFileRef(rawLabel) ? rawLabel : rawHref;
  const resolvedLabel = shouldUseFileLabel
    ? fileRefDisplayLabel(fileLabelSource || rawLabel || rawHref)
    : rawLabel;
  const safeLabel = escapeHtml(resolvedLabel || rawHref || "link");
  const openExternal = isHttpUrl(rawHref);
  if (!openExternal) return `<span class="msgPseudoLink">${safeLabel}</span>`;
  const safeHref = escapeHtml(rawHref);
  return `<a class="msgLink" href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
}

function renderInlineMessageText(text) {
  const source = String(text || "");
  const tokenPattern = /\[([^\]\n]+)\]\(([^)\n]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>()]+)|((?:(?:%[A-Za-z0-9_]+%[\\/]|[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\/]|(?:[A-Za-z0-9_.-]+[\\/]))?[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?)/g;
  let cursor = 0;
  let html = "";
  for (const match of source.matchAll(tokenPattern)) {
    const full = match[0];
    const index = match.index || 0;
    if (index > cursor) html += escapeHtml(source.slice(cursor, index));
    if (match[1] && match[2]) {
      const href = match[2].trim();
      html += buildMessageLink(match[1], href, looksLikeFileRef(href) || looksLikeFileRef(match[1]));
    } else if (match[3]) {
      const inlineCode = String(match[3] || "").trim();
      if (looksLikeFileRef(inlineCode)) {
        html += `<span class="msgPseudoLink">${escapeHtml(fileRefDisplayLabel(inlineCode))}</span>`;
      } else {
        html += `<code class="msgInlineCode">${escapeHtml(match[3])}</code>`;
      }
    } else if (match[4]) {
      html += `<strong>${escapeHtml(match[4])}</strong>`;
    } else if (match[5]) {
      html += buildMessageLink(match[5], match[5], false);
    } else if (match[6]) {
      const candidate = String(match[6] || "").trim();
      if (looksLikeFileRef(candidate)) html += buildMessageLink(candidate, candidate, true);
      else html += escapeHtml(candidate);
    } else {
      html += escapeHtml(full);
    }
    cursor = index + full.length;
  }
  if (cursor < source.length) html += escapeHtml(source.slice(cursor));
  return html;
}

function renderMessageRichHtml(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  if (!source.trim()) return "";
  const segments = source.split("```");
  let html = "";
  const parseListLine = (line) => {
    const match = String(line || "").match(/^(\s*)([-*•]|\d+\.)\s+(.+)$/);
    if (!match) return null;
    const indent = String(match[1] || "").replace(/\t/g, "  ").length;
    const marker = String(match[2] || "").trim();
    const type = /^\d+\.$/.test(marker) ? "ol" : "ul";
    return { indent, marker, type, text: match[3] };
  };
  const isListLine = (line) => !!parseListLine(line);
  const renderListBlock = (listLines) => {
    const items = [];
    for (const itemLine of listLines) {
      const parsed = parseListLine(itemLine);
      if (!parsed) continue;
      const depth = Math.min(6, Math.floor(Number(parsed.indent || 0) / 2));
      items.push({ depth, type: parsed.type, text: parsed.text });
    }
    if (!items.length) return "";

    // Stream a properly nested list structure (ul/ol inside li), instead of a flattened list
    // with fake indentation. Flattening causes "bullet + numbering pinned together" artifacts.
    let out = "";
    const openLists = []; // index == depth, value == 'ul'|'ol'
    const openLi = []; // index == depth, boolean

    const closeDepth = (targetDepthInclusive) => {
      while (openLists.length - 1 > targetDepthInclusive) {
        const d = openLists.length - 1;
        if (openLi[d]) {
          out += "</li>";
          openLi[d] = false;
        }
        out += `</${openLists[d]}>`;
        openLists.pop();
        openLi.pop();
      }
    };

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      const next = items[idx + 1] || null;

      closeDepth(item.depth);

      // Ensure we have lists open down to item.depth.
      while (openLists.length - 1 < item.depth) {
        const parentDepth = openLists.length - 1;
        if (parentDepth >= 0 && !openLi[parentDepth]) {
          // Robustness: if markdown indentation is weird, still create a parent li to hold the nested list.
          out += `<li class="msgListItem depth-${Math.min(6, parentDepth)}">`;
          openLi[parentDepth] = true;
        }
        out += `<${item.type}>`;
        openLists.push(item.type);
        openLi.push(false);
      }

      // If list type changes at this depth, start a new list.
      if (openLists[item.depth] !== item.type) {
        if (openLi[item.depth]) {
          out += "</li>";
          openLi[item.depth] = false;
        }
        out += `</${openLists[item.depth]}>`;
        openLists[item.depth] = item.type;
        out += `<${item.type}>`;
      }

      if (openLi[item.depth]) {
        out += "</li>";
        openLi[item.depth] = false;
      }

      out += `<li class="msgListItem depth-${Math.min(6, item.depth)}">${renderInlineMessageText(item.text)}`;
      openLi[item.depth] = true;

      // Keep the li open if the next item is deeper (nested list follows).
      if (!next || next.depth <= item.depth) {
        out += "</li>";
        openLi[item.depth] = false;
      }
    }

    closeDepth(-1);
    // closeDepth(-1) closed all but depth -1, but we still may have the root list open.
    while (openLists.length) {
      const d = openLists.length - 1;
      if (openLi[d]) {
        out += "</li>";
        openLi[d] = false;
      }
      out += `</${openLists[d]}>`;
      openLists.pop();
      openLi.pop();
    }
    return out;
  };
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (i % 2 === 1) {
      const code = segment.replace(/^\w+\n/, "").replace(/\n$/, "");
      html += `<pre class="msgCodeBlock"><code>${escapeHtml(code)}</code></pre>`;
      continue;
    }
    const lines = segment.split("\n");
    let paragraphLines = [];
    const flushParagraph = () => {
      if (!paragraphLines.length) return;
      html += `<p>${paragraphLines.map((line) => renderInlineMessageText(line)).join("<br>")}</p>`;
      paragraphLines = [];
    };
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
      const line = lines[lineIdx];
      if (!line.trim()) {
        flushParagraph();
        continue;
      }
      if (isListLine(line)) {
        flushParagraph();
        const listLines = [line];
        for (let nextIdx = lineIdx + 1; nextIdx < lines.length; nextIdx += 1) {
          const nextLine = lines[nextIdx];
          if (!nextLine.trim()) break;
          if (!isListLine(nextLine)) break;
          listLines.push(nextLine);
          lineIdx = nextIdx;
        }
        html += renderListBlock(listLines);
        continue;
      }
      paragraphLines.push(line);
    }
    flushParagraph();
  }
  return html || `<p>${escapeHtml(source)}</p>`;
}

function renderMessageBody(role, text) {
  if (role === "assistant" || role === "system" || role === "user") return renderMessageRichHtml(text);
  return `<p>${escapeHtml(text || "").replace(/\n/g, "<br>")}</p>`;
}

function renderMessageAttachments(attachments) {
  const items = Array.isArray(attachments) ? attachments : [];
  const imgs = items.filter((it) => it && typeof it === "object" && typeof it.src === "string" && it.src.trim());
  if (!imgs.length) return "";
  const nodes = [];

  const canShowPreview = (src) =>
    /^data:image\//i.test(src) ||
    /^https?:\/\//i.test(src) ||
    /^\/codex\/file\b/i.test(src) ||
    /^blob:/i.test(src);
  const displayAttachmentLabel = (label) => {
    const s = String(label || "").trim();
    const m = /^Image\s*#(\d+)\s*$/i.exec(s);
    if (m) return `#${m[1]}`;
    return s;
  };
  const renderMissingTile = (label, extraHtml = "") =>
    `<button class="msgAttachmentCard msgAttachmentCard-missing tile" type="button" data-image-src="" data-image-label="${escapeHtml(label)}">` +
      `<div class="msgAttachmentChip mono">[image]</div>` +
      `<div class="msgAttachmentLabelBadge mono">${escapeHtml(displayAttachmentLabel(label) || "image")}</div>` +
      `${extraHtml}` +
    `</button>`;

  const renderTile = (src, label, overlay = "") => {
    if (canShowPreview(src)) {
      return (
        `<button class="msgAttachmentCard tile" type="button" data-image-src="${escapeHtml(src)}" data-image-label="${escapeHtml(label)}">` +
          `<img class="msgAttachmentImage" alt="${escapeHtml(label || "image")}" src="${escapeHtml(src)}" />` +
          `<div class="msgAttachmentLabelBadge mono">${escapeHtml(displayAttachmentLabel(label) || "image")}</div>` +
          `${overlay}` +
        `</button>`
      );
    }
    return renderMissingTile(label, overlay);
  };

  // WhatsApp-like: always render images as a compact, uniform tile grid.
  // - 1 image: 1 column
  // - 3 images: 3 columns (avoid awkward "gap" layout)
  // - 4+ images: 2x2 with "+N" overlay
  const shown = imgs.length > 4 ? imgs.slice(0, 4) : imgs;
  const remaining = Math.max(0, imgs.length - shown.length);
  for (let idx = 0; idx < shown.length; idx += 1) {
    const img = shown[idx];
    const src = img.src.trim();
    const label = String(img.label || "").trim() || `Image #${idx + 1}`;
    const overlay = idx === 3 && remaining > 0 ? `<div class="msgAttachmentMoreOverlay">+${remaining}</div>` : "";
    nodes.push(renderTile(src, label, overlay));
  }
  const mosaicClass =
    shown.length === 1 ? "mosaic single" :
    shown.length === 3 ? "mosaic cols-3" :
    "mosaic";
  return `<div class="msgAttachments ${mosaicClass}">${nodes.join("")}</div>`;
}

function wireMessageLinks(container) {
  if (!container) return;
}

function ensureImageViewer() {
  if (byId("imageViewerBackdrop")) return;
  const backdrop = document.createElement("div");
  backdrop.id = "imageViewerBackdrop";
  backdrop.className = "imageViewerBackdrop";
  backdrop.innerHTML =
    `<div class="imageViewer" role="dialog" aria-modal="true" aria-label="Image viewer">` +
      `<div class="imageViewerTop">` +
        `<button id="imageViewerBackBtn" class="imageViewerIconBtn" type="button" aria-label="Back">` +
          `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>` +
        `</button>` +
        `<div id="imageViewerTitle" class="imageViewerTitle mono"></div>` +
        `<div class="grow"></div>` +
        `<button id="imageViewerShareBtn" class="imageViewerIconBtn" type="button" aria-label="Share">` +
          `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16v-9"></path><path d="M8.5 10.5L12 7l3.5 3.5"></path><path d="M5 17.5v1a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18.5v-1"></path></svg>` +
        `</button>` +
        `<button id="imageViewerDownloadBtn" class="imageViewerIconBtn" type="button" aria-label="Download">` +
          `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10"></path><path d="M8.5 10.5L12 14l3.5-3.5"></path><path d="M5 20h14"></path></svg>` +
        `</button>` +
      `</div>` +
      `<div id="imageViewerBody" class="imageViewerBody">` +
        `<img id="imageViewerImg" class="imageViewerImg" alt="" />` +
      `</div>` +
      `<button id="imageViewerPrevBtn" class="imageViewerIconBtn imageViewerNav prev" type="button" aria-label="Previous" data-qa="image-viewer-prev">` +
        `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>` +
      `</button>` +
      `<button id="imageViewerNextBtn" class="imageViewerIconBtn imageViewerNav next" type="button" aria-label="Next" data-qa="image-viewer-next">` +
        `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>` +
      `</button>` +
      `<div id="imageViewerFilmstrip" class="imageViewerFilmstrip" aria-label="Image list"></div>` +
    `</div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.classList.remove("show");
  backdrop.addEventListener("click", (event) => {
    if (shouldSuppressSyntheticClick(event)) return;
    if (event.target === backdrop) close();
  });
  const backBtn = byId("imageViewerBackBtn");
  if (backBtn) backBtn.onclick = close;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && backdrop.classList.contains("show")) close();
  });
}

let imageViewerState = null;

function isChatNearBottom() {
  const box = byId("chatBox");
  if (!box) return true;
  return box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
}

function chatDistanceFromBottom(box) {
  if (!box) return 0;
  return Math.max(0, box.scrollHeight - (box.scrollTop + box.clientHeight));
}

// Small threshold: if the user scrolls even slightly up to read history, stop sticking.
const CHAT_STICKY_BOTTOM_PX = 12;

function isChatNearBottomForJumpBtn() {
  // Show when the user scrolls up a meaningful amount (ChatGPT-like),
  // not just by a couple of pixels.
  const box = byId("chatBox");
  if (!box) return true;
  const dist = box.scrollHeight - (box.scrollTop + box.clientHeight);
  return dist <= 180;
}

function scrollChatToBottom({ force = false } = {}) {
  const box = byId("chatBox");
  if (!box) return;
  if (!force && !state.chatShouldStickToBottom) return;
  const wasSticky = !!state.chatShouldStickToBottom;
  // Mark as sticky so future messages/layout settles keep following bottom.
  state.chatShouldStickToBottom = true;
  if (force) state.chatUserScrolledAwayAt = 0;
  state.chatProgrammaticScrollUntil = Date.now() + 260;
  if (force && !wasSticky) {
    dbgSet({
      lastForceScrollWhileNotStickyAt: Date.now(),
      lastForceScrollWhileNotStickyGestureAgoMs: Date.now() - Number(state.chatLastUserGestureAt || 0),
    });
  }
  dbgSet({ lastScrollChatToBottomAt: Date.now(), lastScrollChatToBottomForce: !!force });
  // Use the actual max scrollTop to avoid a clamp-induced "micro jump" at the end.
  box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
  updateScrollToBottomBtn();
}

function scrollToBottomReliable() {
  // Robust pin-to-bottom while layout is still settling (images/fonts) without fighting user intent.
  // MutationObserver does not fire for pure layout changes; this loop keeps us pinned until
  // scrollHeight/clientHeight stabilizes for several frames or a hard time budget is reached.
  const token = (Number(state.chatReconcileToken || 0) + 1) | 0;
  state.chatReconcileToken = token;
  const startedAt = Date.now();
  let lastKey = "";
  let stableFrames = 0;

  // Initial snap to bottom for the current layout.
  scrollChatToBottom({ force: true });

  const tick = () => {
    if (token !== state.chatReconcileToken) return;
    if (!state.chatShouldStickToBottom) return;
    const box = byId("chatBox");
    if (!box) return;
    const now = Date.now();
    if (now - startedAt > 2200) return;
    // If the user is actively interacting, stop immediately; don't fight them.
    if (now - Number(state.chatLastUserGestureAt || 0) <= 120) return;

    const targetTop = Math.max(0, box.scrollHeight - box.clientHeight);
    const dist = targetTop - box.scrollTop;
    if (dist > 0.5) scrollChatToBottom({ force: true });

    const key = `${Math.round(box.scrollHeight)}:${Math.round(box.clientHeight)}:${Math.round(box.scrollTop)}`;
    if (key === lastKey && dist <= 0.5) stableFrames += 1;
    else stableFrames = 0;
    lastKey = key;
    if (stableFrames >= 8) return;

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function canStartChatLiveFollow() {
  const now = Date.now();
  if (now <= Number(state.chatSmoothScrollUntil || 0)) return false;
  if (state.chatShouldStickToBottom) return true;
  // If the user hasn't intentionally scrolled away, allow live-follow to recover from small drift
  // (fonts/images) only when we're still close to bottom.
  if (!Number(state.chatUserScrolledAwayAt || 0)) return isChatNearBottom();
  // Recovery: if the user scrolled up only slightly (still near bottom) and enough time has passed
  // since that gesture, re-enable live-follow. This matches clawdex/ChatGPT feel: tiny scrolls
  // don't permanently disable follow.
  if (isChatNearBottom() && now - Number(state.chatUserScrolledAwayAt || 0) >= 900) return true;
  return false;
}

function stopChatLiveFollow() {
  state.chatLiveFollowUntil = 0;
  state.chatLiveFollowToken = (Number(state.chatLiveFollowToken || 0) + 1) | 0;
  if (state.chatLiveFollowRaf) {
    try {
      cancelAnimationFrame(state.chatLiveFollowRaf);
    } catch {}
    state.chatLiveFollowRaf = 0;
  }
}

function scheduleChatLiveFollow(extraMs = 520) {
  const box = byId("chatBox");
  if (!box) return;
  const now = Date.now();
  const alreadyFollowing = now <= Number(state.chatLiveFollowUntil || 0);
  if (!alreadyFollowing) {
    // Recovery: if we are still near bottom long after the last "scroll away" intent,
    // allow follow again and clear the "away" marker.
    if (!state.chatShouldStickToBottom && Number(state.chatUserScrolledAwayAt || 0) && isChatNearBottom() && now - Number(state.chatUserScrolledAwayAt || 0) >= 900) {
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
    }
    if (!canStartChatLiveFollow()) return;
  }
  state.chatLiveFollowUntil = Math.max(Number(state.chatLiveFollowUntil || 0), now + Math.max(0, Number(extraMs || 0)));
  if (state.chatLiveFollowRaf) return;

  state.chatLiveFollowToken = (Number(state.chatLiveFollowToken || 0) + 1) | 0;
  const token = state.chatLiveFollowToken;
  const step = () => {
    state.chatLiveFollowRaf = 0;
    if (token !== state.chatLiveFollowToken) return;
    const now2 = Date.now();
    if (now2 > Number(state.chatLiveFollowUntil || 0)) return;
    if (now2 <= Number(state.chatSmoothScrollUntil || 0)) return;

    const targetTop = Math.max(0, box.scrollHeight - box.clientHeight);
    const dist = targetTop - box.scrollTop;
    if (dist <= 0.5) {
      if (now2 - Number(state.chatLiveFollowLastBtnMs || 0) >= CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS) {
        state.chatLiveFollowLastBtnMs = now2;
        updateScrollToBottomBtn();
      }
      // Keep the follow loop alive a little while; more deltas may arrive.
      state.chatLiveFollowRaf = requestAnimationFrame(step);
      return;
    }

    // "Inertial" approach: small smooth increments, capped to avoid big single-frame jumps.
    const rawStep = Math.max(1, dist * 0.22);
    const maxStep = Math.min(CHAT_LIVE_FOLLOW_MAX_STEP_PX, Math.max(10, dist * 0.35));
    const delta = Math.min(rawStep, maxStep);
    // Prevent our own auto-scroll from being interpreted as "user scrolled away" by the scroll handler.
    state.chatProgrammaticScrollUntil = now2 + 160;
    box.scrollTop += delta;

    if (now2 - Number(state.chatLiveFollowLastBtnMs || 0) >= CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS) {
      state.chatLiveFollowLastBtnMs = now2;
      updateScrollToBottomBtn();
    }
    state.chatLiveFollowRaf = requestAnimationFrame(step);
  };
  state.chatLiveFollowRaf = requestAnimationFrame(step);
}

function smoothScrollChatToBottom(durationMs = undefined) {
  const box = byId("chatBox");
  if (!box) return;
  const prefersReduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const startTop = box.scrollTop;
  const initialTargetTop = Math.max(0, box.scrollHeight - box.clientHeight);
  if (initialTargetTop <= startTop + 1) return;
  const distancePx = Math.max(0, initialTargetTop - startTop);

  // Natural / inertial feel: use sqrt(distance) so small jumps aren't "flashy",
  // and large jumps don't take forever. Keep a slightly shorter profile for
  // reduced-motion setups, but still animated (user feedback prefers some motion).
  const computedDuration = prefersReduced
    ? Math.round(Math.max(400, Math.min(520, 80 + Math.sqrt(distancePx) * 18)))
    : Math.round(Math.max(420, Math.min(1400, 100 + Math.sqrt(distancePx) * 24)));
  const dur =
    durationMs == null || !Number.isFinite(Number(durationMs))
      ? computedDuration
      : Math.max(1, Math.round(Number(durationMs)));

  let startedAt = null;
  state.chatSmoothScrollToken = (Number(state.chatSmoothScrollToken || 0) + 1) | 0;
  const token = state.chatSmoothScrollToken;
  state.chatSmoothScrollUntil = Date.now() + Math.max(0, dur + 250);
  stopChatLiveFollow();
  dbgSet({
    lastSmoothScrollStartAt: Date.now(),
    lastSmoothScrollDurMs: dur,
    lastSmoothScrollStartTop: startTop,
    lastSmoothScrollInitialTargetTop: initialTargetTop,
  });

  // Reduce layout thrash on huge chats: don't read scrollHeight/clientHeight every frame.
  let sampledTargetTop = initialTargetTop;
  let lastSampleMs = 0;
  let lastBtnUpdateMs = 0;
  const tail = [];

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    if (token !== state.chatSmoothScrollToken) return; // superseded by a newer smooth scroll
    if (startedAt == null) startedAt = now;
    const t = Math.min(1, (now - startedAt) / Math.max(1, dur));
    const eased = easeOutCubic(t);
    // Re-sample max scrollTop occasionally to account for late layout (images, font load),
    // but avoid doing it every frame.
    if (now - lastSampleMs >= 90) {
      lastSampleMs = now;
      sampledTargetTop = Math.max(0, box.scrollHeight - box.clientHeight);
    }
    box.scrollTop = startTop + (sampledTargetTop - startTop) * eased;
    // Keep just the tail of scroll positions so tests can assert "no big snap at the end".
    tail.push(box.scrollTop);
    while (tail.length > 10) tail.shift();
    if (t === 0) dbgSet({ lastSmoothScrollFirstFrameAt: Date.now(), lastSmoothScrollFirstFrameTop: box.scrollTop });
    if (now - lastBtnUpdateMs >= 66) {
      lastBtnUpdateMs = now;
      updateScrollToBottomBtn();
    }
    if (t < 1) requestAnimationFrame(step);
    else {
      // Ensure we're truly at bottom at the end (handles fractional pixels / late layout).
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
      state.chatProgrammaticScrollUntil = Date.now() + 260;
      box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
      updateScrollToBottomBtn();
      dbgSet({ lastSmoothScrollEndedAt: Date.now(), lastSmoothScrollEndedTop: box.scrollTop, lastSmoothScrollTail: tail.slice() });
      if (token === state.chatSmoothScrollToken) state.chatSmoothScrollUntil = 0;
    }
  };
  requestAnimationFrame(step);
}

function ensureScrollToBottomBtn() {
  const chatPanel = document.querySelector("section.panel.chatPanel");
  if (!chatPanel) return null;
  const box = byId("chatBox");
  if (!box) return null;
  const btn = byId("scrollToBottomBtn");
  if (!btn) return null;
  if (!btn.__wired) {
    btn.__wired = true;
    btn.onclick = () => {
      smoothScrollChatToBottom();
      updateScrollToBottomBtn();
    };
  }
  // Ensure the button is positioned relative to the chat panel, not inside the scrolled content.
  if (btn.parentElement !== chatPanel) chatPanel.appendChild(btn);
  return btn;
}

function updateScrollToBottomBtn() {
  const box = byId("chatBox");
  if (!box) return;
  const btn = ensureScrollToBottomBtn();
  if (!btn) return;
  const show = !isChatNearBottomForJumpBtn() && box.scrollHeight > box.clientHeight + 40;
  btn.classList.toggle("show", !!show);
  btn.setAttribute("aria-hidden", show ? "false" : "true");
  // When hidden, make it non-focusable to avoid "aria-hidden on focused element" warnings.
  // (Some browsers keep focus on the previously clicked button even after hiding it.)
  if (!show) {
    btn.disabled = true;
    btn.tabIndex = -1;
    try {
      if (document.activeElement === btn) btn.blur();
    } catch {}
  } else {
    btn.disabled = false;
    btn.tabIndex = 0;
  }
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(String(dataUrl || ""));
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const isBase64 = !!match[2];
  const data = match[3] || "";
  try {
    const bytes = isBase64 ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(data));
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function setViewerTransform({ scale, tx, ty }) {
  const img = byId("imageViewerImg");
  if (!img) return;
  const s = clamp(Number(scale || 1), 1, 5);
  const x = Number.isFinite(Number(tx)) ? Number(tx) : 0;
  const y = Number.isFinite(Number(ty)) ? Number(ty) : 0;
  img.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${s})`;
  if (imageViewerState) {
    imageViewerState.scale = s;
    imageViewerState.tx = x;
    imageViewerState.ty = y;
  }
}

function setViewerIndex(nextIndex) {
  const backdrop = byId("imageViewerBackdrop");
  const img = byId("imageViewerImg");
  const title = byId("imageViewerTitle");
  const prev = byId("imageViewerPrevBtn");
  const next = byId("imageViewerNextBtn");
  const film = byId("imageViewerFilmstrip");
  if (!backdrop || !img || !imageViewerState) return;

  const images = Array.isArray(imageViewerState.images) ? imageViewerState.images : [];
  const idx = clamp(Number(nextIndex || 0), 0, Math.max(0, images.length - 1));
  const item = images[idx] || {};
  imageViewerState.index = idx;

  const safeLabel = String(item.label || "").trim() || "image";
  const safeSrc = String(item.src || "").trim();
  if (title) title.textContent = safeLabel;
  img.src = safeSrc;
  img.alt = safeLabel;
  setViewerTransform({ scale: 1, tx: 0, ty: 0 });

  if (prev) prev.toggleAttribute("disabled", idx <= 0);
  if (next) next.toggleAttribute("disabled", idx >= images.length - 1);

  if (film) {
    const nodes = Array.from(film.querySelectorAll("[data-qa='image-viewer-thumb']"));
    for (const n of nodes) {
      const i = Number(n.getAttribute("data-index") || "0");
      n.classList.toggle("active", i === idx);
    }
    const active = film.querySelector(`[data-qa='image-viewer-thumb'][data-index='${idx}']`);
    if (active && typeof active.scrollIntoView === "function") {
      // Keep the selected thumb in view (important on mobile).
      active.scrollIntoView({ block: "nearest", inline: "center" });
    }
    // Some mobile browsers ignore inline:"center"; manually nudge scroll so the active thumb is centered.
    try {
      const fr = film.getBoundingClientRect();
      const ar = active?.getBoundingClientRect?.();
      if (fr && ar && Number.isFinite(ar.left) && Number.isFinite(fr.left)) {
        const filmCenter = fr.left + fr.width / 2;
        const activeCenter = ar.left + ar.width / 2;
        film.scrollLeft += activeCenter - filmCenter;
      }
    } catch {}
  }
}

function renderViewerFilmstrip() {
  const film = byId("imageViewerFilmstrip");
  if (!film || !imageViewerState) return;
  const images = Array.isArray(imageViewerState.images) ? imageViewerState.images : [];
  film.innerHTML = images
    .map((it, idx) => {
      const src = escapeHtml(String(it?.src || "").trim());
      const label = escapeHtml(String(it?.label || "image").trim());
      return (
        `<button class="imageViewerThumb" type="button" data-qa="image-viewer-thumb" data-index="${idx}" aria-label="${label}">` +
          `<img alt="${label}" src="${src}" />` +
        `</button>`
      );
    })
    .join("");

  for (const btn of Array.from(film.querySelectorAll("[data-qa='image-viewer-thumb']"))) {
    btn.onclick = () => setViewerIndex(Number(btn.getAttribute("data-index") || "0"));
  }
}

function wireViewerGestures() {
  const body = byId("imageViewerBody");
  if (!body || body.__wired) return;
  body.__wired = true;

  const active = new Map();
  let startDist = 0;
  let startScale = 1;
  let startTx = 0;
  let startTy = 0;
  let lastTapMs = 0;
  let swipeStart = null;

  const getDist = () => {
    const pts = Array.from(active.values());
    if (pts.length < 2) return 0;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  };

  body.addEventListener("pointerdown", (event) => {
    if (!imageViewerState) return;
    body.setPointerCapture?.(event.pointerId);
    active.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (active.size === 1) {
      swipeStart = { x: event.clientX, y: event.clientY, t: Date.now() };
      startTx = imageViewerState.tx || 0;
      startTy = imageViewerState.ty || 0;
    }
    if (active.size === 2) {
      startDist = getDist();
      startScale = imageViewerState.scale || 1;
      startTx = imageViewerState.tx || 0;
      startTy = imageViewerState.ty || 0;
      swipeStart = null;
    }
  }, { passive: false });

  body.addEventListener("pointermove", (event) => {
    if (!imageViewerState) return;
    if (!active.has(event.pointerId)) return;
    active.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (active.size === 2) {
      const d = getDist();
      if (startDist > 0) {
        const nextScale = clamp(startScale * (d / startDist), 1, 5);
        setViewerTransform({ scale: nextScale, tx: startTx, ty: startTy });
      }
      event.preventDefault();
      return;
    }

    if (active.size === 1 && (imageViewerState.scale || 1) > 1) {
      const p = active.get(event.pointerId);
      if (!p || !swipeStart) return;
      const dx = p.x - swipeStart.x;
      const dy = p.y - swipeStart.y;
      setViewerTransform({ scale: imageViewerState.scale, tx: startTx + dx, ty: startTy + dy });
      event.preventDefault();
    }
  }, { passive: false });

  body.addEventListener("pointerup", (event) => {
    if (!imageViewerState) return;
    active.delete(event.pointerId);
    if (active.size === 0) {
      const scale = imageViewerState.scale || 1;
      const now = Date.now();
      // Swipe left/right to navigate (when not zoomed).
      if (swipeStart && scale <= 1.02) {
        const dx = event.clientX - swipeStart.x;
        const dy = event.clientY - swipeStart.y;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          if (dx < 0) setViewerIndex((imageViewerState.index || 0) + 1);
          else setViewerIndex((imageViewerState.index || 0) - 1);
        }
      }
      // Double tap / click toggles zoom.
      if (now - lastTapMs < 320) {
        const next = scale > 1.2 ? 1 : 2;
        setViewerTransform({ scale: next, tx: 0, ty: 0 });
        lastTapMs = 0;
      } else {
        lastTapMs = now;
      }
      swipeStart = null;
    }
  }, { passive: true });

  body.addEventListener("wheel", (event) => {
    if (!imageViewerState) return;
    const isZoomGesture = event.ctrlKey || event.metaKey || (imageViewerState.scale || 1) > 1.01;
    if (!isZoomGesture) return;
    const delta = -Math.sign(event.deltaY || 0) * 0.15;
    const nextScale = clamp((imageViewerState.scale || 1) + delta, 1, 5);
    setViewerTransform({ scale: nextScale, tx: imageViewerState.tx || 0, ty: imageViewerState.ty || 0 });
    if (event.cancelable) event.preventDefault();
  }, { passive: false });
}

function openImageViewer(src, label, options = {}) {
  ensureImageViewer();
  const backdrop = byId("imageViewerBackdrop");
  const img = byId("imageViewerImg");
  const title = byId("imageViewerTitle");
  const prev = byId("imageViewerPrevBtn");
  const next = byId("imageViewerNextBtn");
  const download = byId("imageViewerDownloadBtn");
  const share = byId("imageViewerShareBtn");
  if (!backdrop || !img) return;

  const safeSrc = String(src || "").trim();
  const safeLabel = String(label || "").trim() || "image";
  const images = Array.isArray(options.images) && options.images.length
    ? options.images.map((it) => ({ src: String(it?.src || "").trim(), label: String(it?.label || "").trim() })).filter((it) => it.src)
    : [{ src: safeSrc, label: safeLabel }];
  const startIndex = clamp(Number(options.index || 0), 0, Math.max(0, images.length - 1));

  imageViewerState = { images, index: startIndex, scale: 1, tx: 0, ty: 0 };
  renderViewerFilmstrip();
  setViewerIndex(startIndex);
  wireViewerGestures();

  if (prev) prev.onclick = () => setViewerIndex((imageViewerState?.index || 0) - 1);
  if (next) next.onclick = () => setViewerIndex((imageViewerState?.index || 0) + 1);
  document.addEventListener("keydown", (event) => {
    if (!byId("imageViewerBackdrop")?.classList.contains("show")) return;
    if (!imageViewerState) return;
    if (event.key === "ArrowLeft") setViewerIndex((imageViewerState.index || 0) - 1);
    if (event.key === "ArrowRight") setViewerIndex((imageViewerState.index || 0) + 1);
  }, { passive: true });

  if (download) {
    download.onclick = () => {
      const current = imageViewerState?.images?.[imageViewerState?.index || 0];
      const curSrc = String(current?.src || safeSrc || "").trim();
      const curLabel = String(current?.label || safeLabel || "image").trim();
      if (!curSrc) return;
      const a = document.createElement("a");
      a.href = curSrc;
      a.download = curLabel.replace(/[^\w.-]+/g, "_") || "image";
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
  }

  if (share) {
    share.onclick = async () => {
      const current = imageViewerState?.images?.[imageViewerState?.index || 0];
      const curSrc = String(current?.src || safeSrc || "").trim();
      const curLabel = String(current?.label || safeLabel || "image").trim();
      if (!curSrc) return;
      try {
        if (navigator.share) {
          // Best-effort: share as a File for data URLs; otherwise share the URL.
          if (/^data:/i.test(curSrc)) {
            const blob = dataUrlToBlob(curSrc);
            if (blob) {
              const file = new File([blob], `${curLabel.replace(/[^\w.-]+/g, "_") || "image"}.png`, { type: blob.type || "image/png" });
              const payload = { files: [file], title: curLabel };
              if (!navigator.canShare || navigator.canShare(payload)) {
                await navigator.share(payload);
                return;
              }
            }
          }
          await navigator.share({ title: curLabel, url: curSrc });
          return;
        }
      } catch {}
      // Fallback: download.
      download?.click?.();
    };
  }

  backdrop.classList.add("show");
}

function wireMessageAttachments(container) {
  const cards = container.querySelectorAll(".msgAttachmentCard");
  for (const card of cards) {
    if (card.__wired) continue;
    card.__wired = true;
    const src = card.getAttribute("data-image-src") || "";
    const label = card.getAttribute("data-image-label") || "";
    const open = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!src) return;
      // WhatsApp-style: open as a gallery for the whole chat, so users can swipe across images.
      const gallery = Array.from(document.querySelectorAll("#chatBox .msgAttachmentCard"))
        .map((n) => ({
          src: String(n.getAttribute("data-image-src") || "").trim(),
          label: String(n.getAttribute("data-image-label") || "").trim(),
        }))
        .filter((it) => it.src);
      const idx = Math.max(0, gallery.findIndex((it) => it.src === src && (!label || it.label === label)));
      openImageViewer(src, label, { images: gallery, index: idx });
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    });
  }

  // If images load after we already scrolled, keep the chat pinned to bottom while opening (or if user is near bottom).
  const imgs = container.querySelectorAll("img.msgAttachmentImage");
  for (const img of imgs) {
    if (img.__wiredLoad) continue;
    img.__wiredLoad = true;
    const onSettled = () => {
      const now = Date.now();
      // While the user is explicitly smooth-scrolling to bottom, avoid snapping the scrollTop
      // due to late image loads; the animation already tracks scrollHeight changes.
      if (now <= Number(state.chatSmoothScrollUntil || 0)) {
        updateScrollToBottomBtn();
        return;
      }
      // Only follow bottom if the user is still "sticky" to bottom (clawdex-style).
      if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
      else updateScrollToBottomBtn();
    };
    img.addEventListener("load", onSettled, { once: true });
    img.addEventListener("error", onSettled, { once: true });
  }
  updateScrollToBottomBtn();
}

function animateMessageNode(node, delayMs = 0) {
  if (delayMs > 0) node.style.setProperty("--msg-enter-delay", `${Math.floor(delayMs)}ms`);
  else node.style.removeProperty("--msg-enter-delay");
  node.classList.add("msg-enter");
  node.addEventListener("animationend", () => {
    node.classList.remove("msg-enter");
    node.style.removeProperty("--msg-enter-delay");
  }, { once: true });
}

function setChatOpening(isOpening) {
  const overlay = byId("chatOpeningOverlay");
  const box = byId("chatBox");
  if (!overlay) return;
  if (isOpening) {
    clearChatMessages();
    hideWelcomeCard();
    // Opening a thread should start in "sticky to bottom" mode regardless of the prior thread's scroll state.
    // This ensures late layout settles (images/fonts) keep the freshly opened thread pinned.
    state.chatShouldStickToBottom = true;
    state.chatUserScrolledAwayAt = 0;
    state.chatProgrammaticScrollUntil = Date.now() + 260;
    if (box) box.scrollTop = 0;
  }
  overlay.classList.toggle("show", !!isOpening);
}

function addChat(role, text, options = {}) {
  const box = byId("chatBox");
  const welcome = byId("welcomeCard");
  if (!box) return;
  if (welcome) welcome.style.display = "none";
  const node = document.createElement("div");
  const kind = typeof options.kind === "string" && options.kind.trim() ? options.kind.trim() : "";
  const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
  const hasText = !!String(text || "").trim();
  const attachmentClass = role === "user" && hasAttachments && hasText ? " withAttachments" : "";
  node.className = `msg ${role}${kind ? ` kind-${kind}` : ""}${attachmentClass}`.trim();
  const headLabel = kind && role === "system" ? kind : role;
  const attachmentsHtml = renderMessageAttachments(options.attachments);
  const bodyHtml = renderMessageBody(role, text);
  node.innerHTML = `<div class="msgHead">${escapeHtml(headLabel)}</div><div class="msgBody">${attachmentsHtml}${bodyHtml}</div>`;
  wireMessageLinks(node);
  wireMessageAttachments(node);
  if (options.animate !== false) {
    const defaultDelay = role === "assistant" || role === "system" ? 50 : 0;
    const delayMs = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : defaultDelay;
    animateMessageNode(node, delayMs);
  }
  box.appendChild(node);
  if (options.scroll !== false) {
    state.chatShouldStickToBottom = true;
    state.chatUserScrolledAwayAt = 0;
    state.chatProgrammaticScrollUntil = Date.now() + 260;
    box.scrollTop = box.scrollHeight;
    // Images can settle after append; keep following briefly.
    scheduleChatLiveFollow(800);
  }
  updateScrollToBottomBtn();
}

function createAssistantStreamingMessage() {
  const msg = document.createElement("div");
  msg.className = "msg assistant";
  msg.innerHTML = `<div class="msgHead">assistant</div><div class="msgBody"></div>`;
  animateMessageNode(msg, 50);
  const body = msg.querySelector(".msgBody");
  return { msg, body };
}

function ensureStreamingBody(body) {
  if (!body) return null;
  try {
    body.setAttribute("data-streaming", "1");
  } catch {}
  let box = body.querySelector(".streamChunks");
  if (!box) {
    box = document.createElement("div");
    box.className = "streamChunks";
    body.textContent = "";
    body.appendChild(box);
  }
  if (!body.__streaming) {
    body.__streaming = { pending: "", scheduled: false };
  }
  return { box, st: body.__streaming };
}

function flushStreamingBody(body) {
  const prepared = ensureStreamingBody(body);
  if (!prepared) return;
  const { box, st } = prepared;
  const pending = String(st.pending || "");
  st.pending = "";
  st.scheduled = false;
  if (!pending) return;

  const parts = pending.split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part) {
      const span = document.createElement("span");
      span.className = "streamChunk";
      span.textContent = part;
      box.appendChild(span);
    }
    if (i !== parts.length - 1) box.appendChild(document.createElement("br"));
  }
}

function appendStreamingDelta(body, text) {
  const prepared = ensureStreamingBody(body);
  if (!prepared) return;
  const { st } = prepared;
  st.pending += String(text || "");
  if (st.scheduled) return;
  st.scheduled = true;
  requestAnimationFrame(() => flushStreamingBody(body));
}

function finalizeAssistantMessage(msgNode, bodyNode, text) {
  if (!msgNode || !bodyNode) return;
  // Clear any transient "thinking" indicator once we have final assistant output.
  try {
    const box = byId("chatBox");
    const node = box?.querySelector?.('.msg.system.kind-thinking[data-thinking="1"]') || null;
    if (node) node.remove();
  } catch {}
  const finalText = String(text || "").trim();
  try {
    bodyNode.removeAttribute("data-streaming");
    bodyNode.__streaming = null;
  } catch {}
  bodyNode.innerHTML = renderMessageBody("assistant", finalText);
  wireMessageLinks(msgNode);
}

function getPromptValue() {
  return byId("mobilePromptInput")?.value?.trim() || "";
}

function clearPromptValue() {
  const mobile = byId("mobilePromptInput");
  if (mobile) mobile.value = "";
  updateMobileComposerState();
}

function hideWelcomeCard() {
  const welcome = byId("welcomeCard");
  if (welcome) welcome.style.display = "none";
}

function showWelcomeCard() {
  const welcome = byId("welcomeCard");
  if (welcome) welcome.style.display = "";
}

function clearChatMessages(options = {}) {
  const box = byId("chatBox");
  if (!box) return;
  const preserveScroll = options && options.preserveScroll === true;
  // Remove a large prior chat in one operation to avoid blocking the main thread.
  // Keep the persistent nodes (welcome + opening overlay) mounted.
  const welcome = byId("welcomeCard");
  const overlay = byId("chatOpeningOverlay");
  const keep = [];
  if (welcome && welcome.parentElement === box) keep.push(welcome);
  if (overlay && overlay.parentElement === box) keep.push(overlay);
  box.replaceChildren(...keep);
  // Default behavior: reset scrollTop so we don't hold a huge scroll offset on large clears.
  // For live refresh while sticky-to-bottom, preserve the scroll to avoid a visible jump.
  if (!preserveScroll) box.scrollTop = 0;
  state.activeThreadRenderSig = "";
  state.activeThreadMessages = [];
  state.historyWindowEnabled = false;
  state.historyWindowThreadId = "";
  state.historyWindowStart = 0;
  state.historyWindowLoading = false;
  state.historyAllMessages = [];
}

function updateMobileComposerState() {
  const wrap = byId("mobilePromptWrap");
  const input = byId("mobilePromptInput");
  if (!wrap || !input) return;
  input.style.height = "auto";
  const maxHeight = mobilePromptMaxHeightPx();
  const nextHeight = Math.min(Math.max(input.scrollHeight, MOBILE_PROMPT_MIN_HEIGHT_PX), maxHeight);
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > nextHeight ? "auto" : "hidden";
  wrap.classList.toggle("has-text", !!String(input.value || "").trim());
}

function setMainTab(tab) {
  state.activeMainTab = tab === "settings" ? "settings" : "chat";
  const settingsTab = byId("settingsTab");
  const settingsInfoSection = byId("settingsInfoSection");
  const chatBox = byId("chatBox");
  const composer = document.querySelector(".composer");
  const isSideTab = state.activeMainTab === "settings";
  if (settingsTab) settingsTab.classList.toggle("show", isSideTab);
  if (settingsInfoSection) settingsInfoSection.style.display = "";
  if (chatBox) chatBox.style.display = isSideTab ? "none" : "";
  if (composer) composer.style.display = isSideTab ? "none" : "";
  updateHeaderUi();
}

function syncSettingsControlsFromMain() {
  // No-op: mode/model settings were intentionally removed from Web Codex UI.
}

function updateWelcomeSelections() {
  // No-op: welcome settings chips were intentionally reduced.
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

function truncateLabel(label, max = 28) {
  const text = String(label || "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function relativeTimeLabel(input) {
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

function pickThreadTimestamp(thread) {
  return thread?.updatedAt ?? thread?.createdAt ?? thread?.statusUpdatedAt ?? "";
}

function threadSortTimestampMs(thread) {
  const raw = pickThreadTimestamp(thread);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return 0;
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const num = Number.parseFloat(text);
      if (!Number.isFinite(num)) return 0;
      return num > 1e12 ? num : num * 1000;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortThreadsByNewest(items) {
  return [...items].sort((a, b) => {
    const diff = threadSortTimestampMs(b) - threadSortTimestampMs(a);
    if (diff !== 0) return diff;
    const aId = String(a?.id || a?.threadId || "");
    const bId = String(b?.id || b?.threadId || "");
    return bId.localeCompare(aId);
  });
}

function renderAttachmentPills(files) {
  const box = byId("attachmentPills");
  if (!box) return;
  box.innerHTML = "";
  for (const file of files) {
    const node = document.createElement("span");
    node.className = "pill mono";
    node.textContent = truncateLabel(file?.name || "attachment");
    box.appendChild(node);
  }
}

function normalizeTextPayload(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result.output_text === "string") return result.output_text;
  if (Array.isArray(result.output_text)) return result.output_text.join("\n");
  if (typeof result.text === "string") return result.text;
  return JSON.stringify(result, null, 2);
}

function compactAttachmentLabel(value, maxLen = 38) {
  const text = String(value || "").trim();
  if (!text) return "";
  // Data URLs are common for inline images; don't surface "inline-image" as a user-visible label.
  // Let callers fall back to the canonical "Image #N" numbering instead.
  if (/^data:/i.test(text)) return "";
  let candidate = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      const pathname = parsed.pathname || "";
      const segments = pathname.split("/").filter(Boolean);
      candidate = segments[segments.length - 1] || parsed.hostname || text;
    } catch {
      candidate = text;
    }
  } else {
    const normalized = text.replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    candidate = segments[segments.length - 1] || normalized || text;
  }
  if (candidate.length <= maxLen) return candidate;
  return `${candidate.slice(0, maxLen - 1)}…`;
}

function stripCodexImageBlocks(text) {
  const source = stripCodexHarnessWrappers(text);
  if (!source) return "";
  // Codex / this chat environment may serialize images as XML-ish blocks:
  // <image name=[Image #1]> ... </image>. We render them as a simple placeholder.
  let replaced = source.replace(
    /<image\s+name=(?:\[[^\]]+\]|"[^"]+"|'[^']+')\s*>[\s\S]*?<\/image>/gi,
    (match) => {
      const name = /name=(?:\[([^\]]+)\]|"([^"]+)"|'([^']+)')/i.exec(match);
      const label = (name?.[1] || name?.[2] || name?.[3] || "").trim();
      return label ? `[${label}]` : "[image]";
    },
  );
  // Some environments emit only the opening tag (no closing </image>).
  replaced = replaced.replace(
    /<image\s+name=(?:\[([^\]]+)\]|"([^"]+)"|'([^']+)')\s*\/?>/gi,
    (_m, a, b, c) => {
      const label = String(a || b || c || "").trim();
      return label ? `[${label}]` : "[image]";
    },
  );
  replaced = replaced.replace(/<\/image>/gi, "");
  return replaced;
}

function stripCodexHarnessWrappers(text) {
  const source = String(text || "");
  if (!source) return "";
  // Codex can persist certain harness-only "envelope" blocks into history, especially after compaction.
  // Align with clawdex-mobile: these should never render as normal chat messages.
  const trimmed = source.trim();
  const wholeEnvelope = /^<\s*(turn_aborted|subagent_notification)\s*>[\s\S]*?<\s*\/\s*\1\s*>\s*$/i.test(trimmed);
  if (wholeEnvelope) return "";

  if (!/[<](?:\s*turn_aborted|\s*subagent_notification)\b/i.test(source)) return source;

  // Remove full blocks when embedded inside other text (rare, but keep the rest).
  let replaced = source.replace(
    /<\s*(turn_aborted|subagent_notification)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    "",
  );
  // Clean up stray tags (defensive; avoids leaking raw harness tags).
  replaced = replaced
    .replace(/<\s*\/\s*(turn_aborted|subagent_notification)\s*>/gi, "")
    .replace(/<\s*(turn_aborted|subagent_notification)\s*>/gi, "")
    .replace(/<\s*(turn_aborted|subagent_notification)\s*\/\s*>/gi, "");
  return replaced;
}

function isBootstrapAgentsPrompt(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  const head = s.slice(0, 320);
  // Hide the repository bootstrap prompt that Codex injects (matches what users report in the UI).
  if (/^#\s*AGENTS\.md instructions\b/i.test(head)) return true;
  if (/<INSTRUCTIONS>/i.test(head) && /Agents Documentation|Agent Defaults|PR-first/i.test(head)) return true;
  return false;
}

function stripStandaloneImageRefs(text) {
  // Remove lines that are just image placeholders (typically injected by the environment),
  // but only when we are already rendering image attachments separately.
  return String(text || "")
    .replace(/^\s*\[(?:Image\s*#\d+|image:[^\]]+)\]\s*$/gmi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseUserMessageParts(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  const lines = [];
  const images = [];
  const mentions = [];
  const pendingImageLabels = [];
  const norm = (value) => String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const partType = norm(part.type);
    if (partType === "text" || partType === "inputtext") {
      const raw = stripCodexImageBlocks(String(part.text || "")).trim();
      if (raw) {
        const kept = [];
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const m = /^\[(Image\s*#\d+)\]$/i.exec(trimmed);
          if (m) {
            pendingImageLabels.push(m[1].replace(/\s+/g, " ").trim());
            continue;
          }
          // Drop "[image: ...]" placeholders; we render thumbnails instead.
          if (/^\[(image:[^\]]+)\]$/i.test(trimmed)) continue;
          kept.push(line);
        }
        const text = kept.join("\n").trim();
        if (text) lines.push(text);
      }
      continue;
    }
    if (partType === "mention") {
      const fileName = compactAttachmentLabel(part.path);
      if (fileName) mentions.push({ kind: "file", label: fileName, path: String(part.path || "") });
      continue;
    }
    if (partType === "localimage") {
      const fileName = compactAttachmentLabel(part.path);
      const path = String(part.path || "").trim();
      if (path) {
        const label = pendingImageLabels.shift() || `Image #${images.length + 1}`;
        // Local file paths are not directly previewable in WebView; serve via gateway.
        const src = `/codex/file?path=${encodeURIComponent(path)}`;
        images.push({ src, label, kind: "path", rawPath: path, fileName });
      }
      continue;
    }
    if (partType === "image") {
      const url = String(part.url || "").trim();
      if (url) {
        const label = pendingImageLabels.shift() || compactAttachmentLabel(url) || `Image #${images.length + 1}`;
        images.push({ src: url, label, kind: "url" });
      }
      continue;
    }
    if (partType === "inputimage") {
      const url = String(part.image_url || "").trim();
      if (url) {
        const label = pendingImageLabels.shift() || `Image #${images.length + 1}`;
        images.push({ src: url, label, kind: "url" });
      }
      continue;
    }
  }
  let text = lines.join("\n").trim();
  if (images.length) text = stripStandaloneImageRefs(text);
  return { text, images, mentions };
}

function normalizeThreadItemText(item) {
  if (!item || typeof item !== "object") return "";
  const type = String(item.type || "").trim();
  if (!type) return "";
  if (type === "agentMessage" || type === "assistantMessage") {
    return stripCodexImageBlocks(String(item.text || "")).trim();
  }
  if (type !== "userMessage") return "";
  return parseUserMessageParts(item).text;
}

function normalizeType(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function normalizeInline(value, maxChars) {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

function normalizeMultiline(value, maxChars) {
  const text = typeof value === "string" ? value : "";
  const cleaned = text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

function toStructuredPreview(value, maxChars) {
  if (value == null) return null;
  if (typeof value === "string") return normalizeMultiline(value, maxChars);
  try {
    return normalizeMultiline(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return null;
  }
}

function toToolLikeMessage(item) {
  const itemType = normalizeType(item?.type);
  if (!itemType) return null;

  if (itemType === "plan") {
    return normalizeMultiline(item?.text, 1800) || null;
  }

  if (itemType === "commandexecution") {
    const command = normalizeInline(item?.command, 240) ?? "command";
    const status = normalizeType(item?.status);
    const output =
      normalizeMultiline(item?.aggregatedOutput, 2400) ??
      normalizeMultiline(item?.aggregated_output, 2400) ??
      normalizeMultiline(item?.output, 2400);
    const exitCode = readNumber(item?.exitCode) ?? readNumber(item?.exit_code);
    const title =
      status === "failed" || status === "error"
        ? `- Command failed \`${command}\``
        : `- Ran \`${command}\``;
    const lines = [title];
    if (exitCode !== null) lines.push(`  - exit code ${String(exitCode)}`);
    if (output) lines.push(`  - ${output.replace(/\n/g, "\n    ")}`);
    return lines.join("\n");
  }

  if (itemType === "mcptoolcall") {
    const server = normalizeInline(item?.server, 120);
    const tool = normalizeInline(item?.tool, 120);
    const label = [server, tool].filter(Boolean).join(" / ") || "MCP tool call";
    const status = normalizeType(item?.status);
    const err = toRecord(item?.error);
    const errMsg = normalizeInline(err?.message, 240) ?? normalizeInline(item?.error, 240);
    const result = toStructuredPreview(item?.result, 240);
    const detail =
      status === "failed" || status === "error"
        ? (errMsg ?? result)
        : (result ?? errMsg);
    const title =
      status === "failed" || status === "error"
        ? `- Tool failed \`${label}\``
        : `- Called tool \`${label}\``;
    return detail ? `${title}\n  - ${detail.replace(/\n/g, "\n    ")}` : title;
  }

  if (itemType === "websearch") {
    const query = normalizeInline(item?.query, 180);
    const action = toRecord(item?.action);
    const actionType = normalizeType(action?.type);
    let detail = query;
    if (actionType === "openpage") {
      detail = normalizeInline(action?.url, 240) ?? detail;
    } else if (actionType === "findinpage") {
      const url = normalizeInline(action?.url, 180);
      const pattern = normalizeInline(action?.pattern, 120);
      detail = [url, pattern ? `pattern: ${pattern}` : null].filter(Boolean).join(" | ") || detail;
    }
    const title = query ? `- Searched web for "${query}"` : "- Searched web";
    return detail && detail !== query ? `${title}\n  - ${detail}` : title;
  }

  if (itemType === "filechange") {
    const status = normalizeType(item?.status);
    const changeCount = Array.isArray(item?.changes) ? item.changes.length : 0;
    const title =
      status === "failed" || status === "error"
        ? "- File changes failed"
        : "- Applied file changes";
    return changeCount > 0 ? `${title}\n  - ${String(changeCount)} file(s) changed` : title;
  }

  if (itemType === "enteredreviewmode") return "- Entered review mode";
  if (itemType === "exitedreviewmode") return "- Exited review mode";
  if (itemType === "contextcompaction") return "- Compacted conversation context";

  return null;
}

function notificationToToolItem(notification) {
  const record = toRecord(notification);
  const params = toRecord(record?.params) || toRecord(record?.payload) || null;
  if (!params) return null;
  const msg =
    toRecord(params?.msg) ||
    toRecord(params?.item) ||
    toRecord(params?.delta) ||
    toRecord(params?.event) ||
    null;
  return msg;
}

function renderLiveNotification(notification) {
  const record = toRecord(notification);
  const method = readString(record?.method) || "";
  if (!method) return;
  const threadId = extractNotificationThreadId(record);
  if (!threadId || threadId !== state.activeThreadId) return;

  // Render "tool-like" items immediately (command/tool/edit/search/etc).
  const toolItem = notificationToToolItem(record);
  if (toolItem) {
    const toolLike = toToolLikeMessage(toolItem);
    if (toolLike) {
      addChat("system", toolLike, { kind: "tool", scroll: false });
      scheduleChatLiveFollow(900);
      return;
    }
  }

  // Fallback: show a lightweight "thinking" indicator for running turns.
  const params = toRecord(record?.params) || null;
  const status = normalizeType(params?.status) || normalizeType(params?.turn?.status) || normalizeType(params?.thread?.status);
  const isRunning = /running|inprogress|working|queued/.test(status || "") || method.includes("turn/started") || method.includes("turn/started");
  if (isRunning) {
    const box = byId("chatBox");
    if (!box) return;
    const existing = box.querySelector('.msg.system.kind-thinking[data-thinking="1"]');
    if (!existing) {
      addChat("system", "- Thinking…", { kind: "thinking", scroll: false });
      try {
        const last = box.lastElementChild;
        if (last && last.classList && last.classList.contains("kind-thinking")) last.setAttribute("data-thinking", "1");
      } catch {}
      scheduleChatLiveFollow(800);
    }
    return;
  }
  if (method.includes("turn/completed") || method.includes("turn/finished") || method.includes("turn/failed") || method.includes("turn/cancelled")) {
    try {
      const box = byId("chatBox");
      const node = box?.querySelector?.('.msg.system.kind-thinking[data-thinking="1"]') || null;
      if (node) node.remove();
    } catch {}
  }
}

async function mapThreadReadMessages(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages = [];
  let seenAssistant = false;
  let seenNonBootstrapUser = false;

  // Time-slice parsing so header (hamburger/model) remains clickable while opening very large threads.
  // This targets the real root cause: long synchronous work blocking the event loop.
  let lastYieldMs = performance.now();
  const yieldBudgetMs = 7.5;
  if (turns.length >= 40) await nextFrame();

  for (let ti = 0; ti < turns.length; ti += 1) {
    if (turns.length >= 40 && performance.now() - lastYieldMs >= yieldBudgetMs) {
      lastYieldMs = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await nextFrame();
    }
    const turn = turns[ti];
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      const type = String(item?.type || "").trim();
      if (type === "userMessage") {
        const parsed = parseUserMessageParts(item);
        const text = parsed.text;
        // Hide Codex harness bootstrap prompt. This should never be rendered as a user message
        // (align with clawdex-mobile behavior and avoid "evil prompt" showing up after compaction).
        if (text && isBootstrapAgentsPrompt(text)) {
          continue;
        }
        if (text || parsed.images.length) {
          messages.push({ role: "user", text, kind: "", images: parsed.images });
          if (text) seenNonBootstrapUser = true;
        }
        continue;
      }
      const text = normalizeThreadItemText(item);
      if (text) {
        if (type === "agentMessage" || type === "assistantMessage") {
          messages.push({ role: "assistant", text, kind: "" });
          seenAssistant = true;
        }
        continue;
      }
      const toolLike = toToolLikeMessage(item);
      if (toolLike) messages.push({ role: "system", text: toolLike, kind: "tool" });
    }
  }
  return messages;
}

async function applyThreadToChat(thread, options = {}) {
  // If the caller wants to land at bottom (thread open), reset stickiness *before* rendering so any
  // image-load/layout-settle hooks observe a consistent "sticky" state.
  if (options.stickToBottom) {
    state.chatShouldStickToBottom = true;
    state.chatUserScrolledAwayAt = 0;
    state.chatProgrammaticScrollUntil = Date.now() + 260;
  }
  const messages = await mapThreadReadMessages(thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const renderSig = [
    String(thread?.id || state.activeThreadId || ""),
    String(turns.length),
    String(messages.length),
    String(lastMsg?.role || ""),
    String(lastMsg?.text || ""),
  ].join("::");
  const threadId = String(thread?.id || state.activeThreadId || "");
  state.activeThreadStarted = messages.length > 0 || turns.length > 0;
  // Model selection is global (header picker), not per-thread.
  const target = detectThreadWorkspaceTarget(thread);
  if (target !== "unknown") state.activeThreadWorkspace = target;
  if (!options.forceRender && state.activeThreadRenderSig === renderSig) {
    if (state.activeThreadStarted) hideWelcomeCard();
    else showWelcomeCard();
    updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
    if (state.historyWindowEnabled && state.historyWindowThreadId === threadId) updateLoadOlderControl();
    return;
  }

  const box = byId("chatBox");

  const prevMessages = Array.isArray(state.activeThreadMessages) ? state.activeThreadMessages : [];

  // FlatList-like behavior for huge histories: render only the most recent window and allow loading older.
  if (shouldUseHistoryWindow(messages, options)) {
    const prevAll = Array.isArray(state.historyAllMessages) ? state.historyAllMessages : [];
    const alreadyWindowed = state.historyWindowEnabled && state.historyWindowThreadId === threadId;

    // Initial windowed render (or reset after a non-append mutation).
    const doWindowedRender = () => {
      const size = Math.max(40, Number(state.historyWindowSize || 160) | 0);
      const start = Math.max(0, messages.length - size);
      clearChatMessages();
      state.historyWindowEnabled = true;
      state.historyWindowThreadId = threadId;
      state.historyWindowStart = start;
      state.historyAllMessages = messages;
      const slice = messages.slice(start);
      const frag = document.createDocumentFragment();
      for (const msg of slice) frag.appendChild(buildMsgNode(msg));
      const box2 = byId("chatBox");
      if (box2) {
        if (start > 0) ensureLoadOlderControl(box2);
        // Insert messages after any existing persistent nodes (welcome/overlay) and after the load-older control.
        box2.appendChild(frag);
      }
      state.activeThreadMessages = slice;
      state.activeThreadRenderSig = renderSig;
      updateLoadOlderControl();

      if (options.stickToBottom) {
        scrollToBottomReliable();
        scheduleChatLiveFollow(1400);
      } else if (state.chatShouldStickToBottom) {
        scrollChatToBottom({ force: true });
      }

      if (state.activeThreadStarted) hideWelcomeCard();
      else showWelcomeCard();
      updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
      updateScrollToBottomBtn();
    };

    // If we aren't windowed yet, or the history shrank/changed shape, re-render the window.
    if (!alreadyWindowed || messages.length < prevAll.length) {
      doWindowedRender();
      return;
    }

    // Windowed incremental update: only handle last-message growth and append-only additions.
    state.historyAllMessages = messages;
    if (messages.length === prevAll.length) {
      // Last message may grow (streaming).
      const a = prevAll[prevAll.length - 1];
      const b = messages[messages.length - 1];
      if (a && b && a.role === b.role && a.kind === b.kind && a.text !== b.text) {
        // Update the DOM last node directly.
        const updated = (() => {
          if (!box) return false;
          const nodes = box.querySelectorAll(".msg");
          const last = nodes.length ? nodes[nodes.length - 1] : null;
          if (!last) return false;
          if (!last.classList.contains(b.role)) return false;
          const body = last.querySelector(".msgBody");
          if (!body) return false;
          body.innerHTML = renderMessageBody(b.role, b.text);
          return true;
        })();
        if (updated) {
          state.activeThreadMessages = messages.slice(Number(state.historyWindowStart || 0));
          state.activeThreadRenderSig = renderSig;
          updateLoadOlderControl();
          if (canStartChatLiveFollow()) scheduleChatLiveFollow(900);
          if (state.activeThreadStarted) hideWelcomeCard();
          else showWelcomeCard();
          updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
          return;
        }
      }
      // No visible changes.
      state.activeThreadRenderSig = renderSig;
      updateLoadOlderControl();
      return;
    }

    if (messages.length > prevAll.length) {
      // Append new messages to DOM; keep window start as-is.
      for (let i = prevAll.length; i < messages.length; i += 1) {
        const msg = messages[i];
        addChat(msg.role, msg.text, { scroll: false, kind: msg.kind || "", attachments: msg.images || [] });
      }
      state.activeThreadMessages = messages.slice(Number(state.historyWindowStart || 0));
      state.activeThreadRenderSig = renderSig;
      updateLoadOlderControl();
      if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
      if (canStartChatLiveFollow()) scheduleChatLiveFollow(1100);
      if (state.activeThreadStarted) hideWelcomeCard();
      else showWelcomeCard();
      updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
      updateScrollToBottomBtn();
      return;
    }

    // Fallback: unexpected mutation; re-render window.
    doWindowedRender();
    return;
  }

  // If we were windowed but the history is now small, tear down the window controls.
  if (state.historyWindowEnabled && state.historyWindowThreadId === threadId && messages.length < HISTORY_WINDOW_THRESHOLD) {
    state.historyWindowEnabled = false;
    state.historyWindowThreadId = "";
    state.historyWindowStart = 0;
    state.historyAllMessages = [];
    const wrap = byId("loadOlderWrap");
    if (wrap) wrap.remove();
  }
  const isSamePrefix = (a, b) => {
    if (a.length > b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i].role !== b[i].role) return false;
      if (a[i].kind !== b[i].kind) return false;
      if (a[i].text !== b[i].text) return false;
    }
    return true;
  };

  const updateLastNode = (role, text) => {
    if (!box) return false;
    const nodes = box.querySelectorAll(".msg");
    const last = nodes.length ? nodes[nodes.length - 1] : null;
    if (!last) return false;
    if (!last.classList.contains(role)) return false;
    const body = last.querySelector(".msgBody");
    if (!body) return false;
    body.innerHTML = renderMessageBody(role, text);
    return true;
  };

  if (prevMessages.length && messages.length === prevMessages.length) {
    // Common "live" case: the last assistant message grows while streaming.
    let allButLastSame = true;
    for (let i = 0; i < prevMessages.length - 1; i += 1) {
      const a = prevMessages[i];
      const b = messages[i];
      if (a.role !== b.role || a.kind !== b.kind || a.text !== b.text) {
        allButLastSame = false;
        break;
      }
    }
    if (allButLastSame && prevMessages.length) {
      const a = prevMessages[prevMessages.length - 1];
      const b = messages[messages.length - 1];
      if (a.role === b.role && a.kind === b.kind && a.text !== b.text) { 
        updateLastNode(b.role, b.text); 
        state.activeThreadMessages = messages; 
        state.activeThreadRenderSig = renderSig; 
        if (canStartChatLiveFollow()) scheduleChatLiveFollow(900); 
        if (state.activeThreadStarted) hideWelcomeCard(); 
        else showWelcomeCard(); 
        updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted)); 
        return; 
      } 
    }
  }

  if (isSamePrefix(prevMessages, messages)) {
    // Append-only update: avoid full re-render to keep scroll position stable.
    for (let i = prevMessages.length; i < messages.length; i += 1) {
      const msg = messages[i];
      addChat(msg.role, msg.text, { scroll: false, kind: msg.kind || "", attachments: msg.images || [] });
    }
    state.activeThreadMessages = messages; 
    state.activeThreadRenderSig = renderSig; 
    // If the user is sticky to bottom, jump to the new max scrollTop immediately (avoid "stuck above bottom"
    // when the incoming message is tall), then keep following briefly as images settle.
    if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
    if (canStartChatLiveFollow()) scheduleChatLiveFollow(1100); 
  } else {
    // For large histories, render in batches so the UI remains interactive while opening.
    // This prevents the header (hamburger / model picker / workspace toggle) from feeling "locked".
    const shouldAsyncRender = messages.length >= 80 || !!options.slowRender;
    if (shouldAsyncRender) {
      await renderChatFull(messages, { slowRender: !!options.slowRender, preserveScroll: !!state.chatShouldStickToBottom });
    } else {
      clearChatMessages({ preserveScroll: !!state.chatShouldStickToBottom });
      for (const msg of messages) addChat(msg.role, msg.text, { scroll: false, kind: msg.kind || "", attachments: msg.images || [] });
    }
    state.activeThreadMessages = messages;
    state.activeThreadRenderSig = renderSig;
    if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
    if (canStartChatLiveFollow()) scheduleChatLiveFollow(1100); 
    else if (box) box.scrollTop = box.scrollHeight; 
  } 

  if (options.stickToBottom) {
    scrollToBottomReliable();
    // Even if the previous chat left us "non-sticky", opening a new chat should follow late layout
    // settles (images/font load) briefly so we actually land at the bottom.
    scheduleChatLiveFollow(1400);
  }

  if (state.activeThreadStarted) hideWelcomeCard();
  else showWelcomeCard();
  updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
  updateScrollToBottomBtn();
}

async function loadThreadMessages(threadId, options = {}) {
  if (!threadId) return;
  // Any explicit history fetch should satisfy the live-poll interval so the timer loop doesn't
  // immediately re-fetch right after open/refresh actions.
  state.activeThreadLiveLastPollMs = Date.now();
  try {
    const e2e = window.__webCodexE2E;
    if (e2e && typeof e2e.getThreadHistory === "function") {
      const seeded = e2e.getThreadHistory(threadId);
      if (seeded) {
        try { window.__webCodexE2E_lastHistorySource = "seed"; } catch {}
        await applyThreadToChat(seeded, options);
        return;
      }
    }
  } catch (e) {
    // In e2e mode, capture seeding errors for debugging; then continue with normal fetch paths.
    try {
      if (window.__webCodexE2E) {
        window.__webCodexE2E_seedHistoryError = String(e && e.message ? e.message : e);
      }
    } catch {}
  }
  try {
    const query = [];
    const workspace = options.workspace || state.activeThreadWorkspace || "";
    if (workspace === "windows" || workspace === "wsl2") {
      query.push(`workspace=${encodeURIComponent(workspace)}`);
    }
    const path = query.length
      ? `/codex/threads/${encodeURIComponent(threadId)}/history?${query.join("&")}`
      : `/codex/threads/${encodeURIComponent(threadId)}/history`;
    const history = await api(path, { method: "GET", signal: options.signal });
    if (state.activeThreadId && state.activeThreadId !== threadId) return;
    const thread = history?.thread || history?.result?.thread || null;
    if (thread) {
      try { window.__webCodexE2E_lastHistorySource = "http"; } catch {}
      await applyThreadToChat(thread, options);
      return;
    }
  } catch (_) {
    // Fall back to codex RPC for cases where history is unavailable (best-effort).
  }
  const rpc = await api("/codex/rpc", {
    method: "POST",
    body: {
      method: "thread/read",
      params: {
        threadId,
        includeTurns: true,
      },
    },
    signal: options.signal,
  });
  if (state.activeThreadId && state.activeThreadId !== threadId) return;
  const thread = rpc?.result?.thread || null;
  await applyThreadToChat(thread, options);
}

function ensureArrayItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return value ? [value] : [];
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function buildMsgNode(msg) {
  const node = document.createElement("div");
  const kind = typeof msg.kind === "string" && msg.kind.trim() ? msg.kind.trim() : "";
  const hasAttachments = Array.isArray(msg.images) && msg.images.length > 0;
  const hasText = !!String(msg.text || "").trim();
  const attachmentClass = msg.role === "user" && hasAttachments && hasText ? " withAttachments" : "";
  node.className = `msg ${msg.role}${kind ? ` kind-${kind}` : ""}${attachmentClass}`.trim();
  const headLabel = kind && msg.role === "system" ? kind : msg.role;
  const attachmentsHtml = renderMessageAttachments(msg.images || []);
  const bodyHtml = renderMessageBody(msg.role, msg.text);
  node.innerHTML = `<div class="msgHead">${escapeHtml(headLabel)}</div><div class="msgBody">${attachmentsHtml}${bodyHtml}</div>`;
  wireMessageLinks(node);
  wireMessageAttachments(node);
  return node;
}

function ensureLoadOlderControl(box) {
  if (!box) return null;
  let wrap = byId("loadOlderWrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "loadOlderWrap";
    wrap.className = "loadOlderWrap";
    wrap.innerHTML = `<button id="loadOlderBtn" class="loadOlderBtn" type="button">Load older</button>`;
    // Insert before the first message so it stays at the very top of the rendered window.
    const firstMsg = box.querySelector(".msg");
    if (firstMsg) box.insertBefore(wrap, firstMsg);
    else box.appendChild(wrap);
  }
  const btn = wrap.querySelector("#loadOlderBtn");
  if (btn && !btn.__wiredLoadOlder) {
    btn.__wiredLoadOlder = true;
    btn.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        loadOlderHistoryChunk();
      },
      { passive: false }
    );
  }
  return wrap;
}

function updateLoadOlderControl() {
  const box = byId("chatBox");
  if (!box) return;
  const wrap = byId("loadOlderWrap");
  if (!state.historyWindowEnabled || !state.historyWindowThreadId) {
    if (wrap) wrap.remove();
    return;
  }
  const remaining = Math.max(0, Number(state.historyWindowStart || 0));
  if (!remaining) {
    if (wrap) wrap.remove();
    return;
  }
  ensureLoadOlderControl(box);
  const btn = byId("loadOlderBtn");
  if (btn) {
    btn.disabled = !!state.historyWindowLoading;
    btn.textContent = state.historyWindowLoading ? "Loading..." : `Load older (${remaining})`;
  }
}

function shouldUseHistoryWindow(messages, options = {}) {
  if (!Array.isArray(messages)) return false;
  if (messages.length < HISTORY_WINDOW_THRESHOLD) return false;
  // For huge threads, keep windowing enabled across refreshes; otherwise a single new message can
  // accidentally trigger a full-history render (loading everything) and "lose" the Load older affordance.
  return true;
}

function loadOlderHistoryChunk() {
  if (!state.historyWindowEnabled) return;
  if (state.historyWindowLoading) return;
  const box = byId("chatBox");
  if (!box) return;
  const all = Array.isArray(state.historyAllMessages) ? state.historyAllMessages : [];
  const start = Math.max(0, Number(state.historyWindowStart || 0));
  if (!start) return;
  state.historyWindowLoading = true;
  updateLoadOlderControl();
  const nextStart = Math.max(0, start - Math.max(1, Number(state.historyWindowChunk || 0)));
  const slice = all.slice(nextStart, start);
  if (!slice.length) {
    state.historyWindowStart = nextStart;
    state.historyWindowLoading = false;
    updateLoadOlderControl();
    return;
  }

  const prevScrollHeight = box.scrollHeight;
  const frag = document.createDocumentFragment();
  for (const msg of slice) frag.appendChild(buildMsgNode(msg));
  const wrap = ensureLoadOlderControl(box);
  // Insert right after the control, so it stays pinned at the top of the window.
  const anchor = wrap ? wrap.nextSibling : box.firstChild;
  box.insertBefore(frag, anchor || null);
  // Preserve the user's viewport position while we prepend.
  const deltaH = box.scrollHeight - prevScrollHeight;
  box.scrollTop += deltaH;

  state.historyWindowStart = nextStart;
  state.historyWindowLoading = false;
  state.activeThreadMessages = all.slice(nextStart);
  updateLoadOlderControl();
}

async function renderChatFull(messages, options = {}) {
  const box = byId("chatBox");
  if (!box) return;

  // Cancel any previous in-flight async render.
  state.chatRenderToken = (Number(state.chatRenderToken || 0) + 1) | 0;
  const token = state.chatRenderToken;

  clearChatMessages({ preserveScroll: options && options.preserveScroll === true });
  // Keep render state in sync even if we yield.
  state.activeThreadMessages = [];

  const slowYield = !!options.slowRender;
  const batchSize = Math.max(6, Math.min(28, Number(options.batchSize || 14)));
  for (let i = 0; i < messages.length; i += batchSize) {
    if (token !== state.chatRenderToken) return; // superseded
      const frag = document.createDocumentFragment();
      const end = Math.min(messages.length, i + batchSize);
      for (let j = i; j < end; j += 1) {
        const msg = messages[j];
        // Render without auto-scrolling per message; we'll handle stick-to-bottom after.
        frag.appendChild(buildMsgNode(msg));
      }
      box.appendChild(frag);
    // While opening large chats, keep the view pinned to bottom if the user hasn't scrolled away.
    // This avoids ending up "far above bottom" while the remaining batches are still rendering.
    const now = Date.now();
    const recentGesture = now - Number(state.chatLastUserGestureAt || 0) <= 250;
    if (state.chatShouldStickToBottom && !recentGesture) {
      scrollChatToBottom({ force: true });
    }
    // Yield so the UI remains responsive while opening large chats.
    // (This is the root cause of "can't click header while opening".)
    // eslint-disable-next-line no-await-in-loop
    await nextFrame();
    if (slowYield) {
      // eslint-disable-next-line no-await-in-loop
      await waitMs(12);
    }
  }
}

function nextReqId() {
  return `req_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function wsSend(value) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(value));
  return true;
}

function wsCall(type, payload, expectedType) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      reject(new Error("WS is not connected"));
      return;
    }
    const reqId = nextReqId();
    const timeout = setTimeout(() => {
      state.wsReqHandlers.delete(reqId);
      reject(new Error("WS request timeout"));
    }, 15000);
    state.wsReqHandlers.set(reqId, (evt) => {
      if (evt.type === "error") {
        clearTimeout(timeout);
        state.wsReqHandlers.delete(reqId);
        reject(new Error(evt.message || "WS error"));
        return;
      }
      if (evt.type === expectedType) {
        clearTimeout(timeout);
        state.wsReqHandlers.delete(reqId);
        resolve(evt.payload || {});
      }
    });
    wsSend({ type, reqId, payload });
  });
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (state.token.trim()) headers.Authorization = `Bearer ${state.token.trim()}`;
  const res = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error?.detail || payload?.error?.message || `HTTP ${res.status}`);
  }
  return payload;
}

function setActiveHost(id) {
  state.activeHostId = id || "";
  const activeHostLabel = byId("activeHostId");
  if (activeHostLabel) activeHostLabel.textContent = state.activeHostId || "(none)";
}

function setActiveThread(id) {
  const prev = state.activeThreadId || "";
  state.activeThreadId = id || "";
  if (prev !== state.activeThreadId) state.activeThreadRenderSig = "";
  if (!state.activeThreadId) {
    state.activeThreadStarted = false;
    state.activeThreadWorkspace = getWorkspaceTarget();
  } else {
    syncActiveThreadMetaFromList(state.activeThreadId);
  }
  const activeThreadLabel = byId("activeThreadId");
  if (activeThreadLabel) activeThreadLabel.textContent = state.activeThreadId || "(none)";
  updateHeaderUi();
}

function workspaceKeyOfThread(thread) {
  const raw =
    thread.cwd ||
    thread.workspace ||
    thread.project ||
    thread.directory ||
    thread.path ||
    "";
  const text = String(raw || "").trim();
  if (!text) return "Bridge default workspace";
  const normalized = text
    .replace(/^\\\\\?\\/, "")
    .replace(/^\\\\\?\\UNC\\/, "\\\\")
    .replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last || "Bridge default workspace";
}

function connectWs() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${proto}://${window.location.host}/codex/ws?token=${encodeURIComponent(state.token || "")}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;
  state.wsSubscribedEvents = false;
  ws.onopen = () => {
    setStatus("Connected (HTTP + WS).");
    let lastEventId = 0;
    try {
      lastEventId = Number(localStorage.getItem(LAST_EVENT_ID_KEY) || 0) || 0;
    } catch {}
    wsSend({ type: "subscribe.events", reqId: nextReqId(), payload: { events: true, lastEventId } });
  };
  ws.onerror = () => {
    state.wsSubscribedEvents = false;
    setStatus("WS error; fallback to HTTP.", true);
  };
  ws.onclose = () => {
    state.wsSubscribedEvents = false;
    setStatus("WS closed; fallback to HTTP.", true);
  };
  ws.onmessage = (event) => {
    let payload = {};
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleWsPayload(payload);
  };
}

function handleWsPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.reqId && state.wsReqHandlers.has(payload.reqId)) {
    state.wsReqHandlers.get(payload.reqId)(payload);
    return;
  }
  if (payload.type === "approval.requested") {
    applyPendingPayloads(payload.payload, state.pendingUserInputs);
    addChat("system", "approval requested");
    return;
  }
  if (payload.type === "user_input.requested") {
    applyPendingPayloads(state.pendingApprovals, payload.payload);
    addChat("system", "request_user_input requested");
    return;
  }
  if (payload.type === "events.snapshot") {
    applyPendingPayloads(payload?.payload?.approvals || [], payload?.payload?.userInputs || []);
    return;
  }
  if (payload.type === "ui.event") {
    const record = toRecord(payload.payload) || {};
    const eventId = readNumber(record?.eventId);
    if (eventId !== null) {
      if (eventId === 1 && state.wsLastEventId > 1) resetEventReplayState();
      if (eventId <= state.wsLastEventId) return;
      if (state.wsRecentEventIds.has(eventId)) return;
      markEventIdSeen(eventId);
      state.wsLastEventId = Math.max(state.wsLastEventId, eventId);
      try {
        localStorage.setItem(LAST_EVENT_ID_KEY, String(state.wsLastEventId));
      } catch {}
    }
    const conversationId = readString(record?.conversationId) || readString(record?.threadId) || "";
    if (conversationId) {
      scheduleThreadRefresh(120);
      scheduleActiveThreadRefresh(conversationId, 90);
    }
    const kind = readString(record?.kind) || "";
    if (kind === "activity") {
      renderLiveNotification({
        method: "thread/status",
        params: {
          status: readString(record?.status) || "",
          message: readString(record?.message) || "",
          code: readString(record?.code) || "",
          thread: {
            status: readString(record?.status) || "",
            message: readString(record?.message) || "",
          },
        },
      });
      return;
    }
    if (kind === "assistant_delta") {
      renderLiveNotification({
        method: "turn/assistant/delta",
        params: { delta: readString(record?.delta) || "" },
      });
      return;
    }
    if (kind === "tool") {
      renderLiveNotification({
        method: "item/updated",
        params: {
          itemId: readString(record?.itemId) || "",
          item: toRecord(record?.item) || {},
        },
      });
      return;
    }
    return;
  }
  if (payload.type === "rpc.notification") {
    const notification = payload.payload || {};
    const record = toRecord(notification);
    const method = readString(record?.method) || "";
    if (!method) return;
    const eventId = extractNotificationEventId(record);
    if (eventId !== null) {
      if (eventId === 1 && state.wsLastEventId > 1) resetEventReplayState();
      if (eventId <= state.wsLastEventId) return;
      if (state.wsRecentEventIds.has(eventId)) return;
      markEventIdSeen(eventId);
      state.wsLastEventId = Math.max(state.wsLastEventId, eventId);
      try {
        localStorage.setItem(LAST_EVENT_ID_KEY, String(state.wsLastEventId));
      } catch {}
    }
    const threadId = extractNotificationThreadId(record);
    if (shouldRefreshThreadsFromNotification(method)) scheduleThreadRefresh();
    if (threadId && shouldRefreshActiveThreadFromNotification(method)) scheduleActiveThreadRefresh(threadId);
    renderLiveNotification(notification);
    return;
  }
  if (payload.type === "events.reset") {
    resetEventReplayState();
    return;
  }
  if (payload.type === "subscribed") {
    state.wsSubscribedEvents = true;
    setStatus("WS subscribed.");
  }
}

function renderThreads(items) {
  const list = byId("threadList");
  const prevListScrollTop = list?.scrollTop ?? 0;
  const shouldRestoreListScroll = prevListScrollTop > 0;
  const prevGroupScroll = new Map();
  const pendingScrollRestores = [];
  try {
    const groups = Array.from(list?.querySelectorAll?.(".groupCard[data-group-key]") || []);
    for (const group of groups) {
      const key = String(group.getAttribute("data-group-key") || "").trim();
      if (!key) continue;
      const body = group.querySelector(".groupBody");
      if (!body) continue;
      if (body.scrollTop > 0) prevGroupScroll.set(key, body.scrollTop);
    }
  } catch {}
  list.innerHTML = "";
  const query = state.threadSearchQuery.trim().toLowerCase();
  const groups = new Map();
  const groupLabels = new Map();
  for (const thread of items) {
    const keyLabel = workspaceKeyOfThread(thread);
    const key = keyLabel.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    if (!groupLabels.has(key)) groupLabels.set(key, keyLabel);
    groups.get(key).push(thread);
  }
  const entries = Array.from(groups.entries()).map(([k, v]) => [groupLabels.get(k) || k, v, k]);
  if (!entries.length) {
    if (state.threadListLoading && state.threadListLoadingTarget === getWorkspaceTarget()) {
      list.innerHTML = `<div class="muted">Loading chats...</div>`;
      return;
    }
    if (state.threadItemsAll.length && hasDualWorkspaceTargets()) {
      list.innerHTML = `<div class="muted">No ${escapeHtml(getWorkspaceTarget().toUpperCase())} chats yet.</div>`;
    } else {
      list.innerHTML = `<div class="muted">No threads yet.</div>`;
    }
    return;
  }
  const validKeys = new Set(entries.map(([, ,k]) => k));
  if (state.collapsedWorkspaceKeys.size) {
    state.collapsedWorkspaceKeys = new Set(
      Array.from(state.collapsedWorkspaceKeys).filter((k) => validKeys.has(k) || String(k).startsWith("__section_"))
    );
  }
  const hasKnownCollapseState = entries.some(([, , k]) => state.collapsedWorkspaceKeys.has(k));
  if (!hasKnownCollapseState) {
    for (let i = 0; i < entries.length; i += 1) state.collapsedWorkspaceKeys.add(entries[i][2]);
  }

  let renderedThreads = 0;
  const favoriteSet = state.favoriteThreadIds;
  const favoriteItems = items.filter((thread) => {
    const id = thread.id || thread.threadId || "";
    return id && favoriteSet.has(id);
  });

  const renderThreadCard = (thread) => {
      const id = thread.id || thread.threadId || "";
      const preview = String(thread.preview || "").replace(/\s+/g, " ").trim();
      const title =
        thread.title ||
        thread.name ||
        (preview ? truncateLabel(preview, 40) : "") ||
        id ||
        "(unnamed)";
      const age = relativeTimeLabel(pickThreadTimestamp(thread)) || "";
      const isFavorite = !!(id && favoriteSet.has(id));
      const card = document.createElement("div");
      card.className = `itemCard${id && id === state.activeThreadId ? " active" : ""}`;
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.innerHTML =
        `<div class="row"><button class="threadFavBtn${isFavorite ? " active" : ""}" data-thread-fav="${escapeHtml(id)}" aria-label="${isFavorite ? "Unfavorite" : "Favorite"}"><span class="starGlyph" aria-hidden="true">${isFavorite ? "★" : "☆"}</span></button>` +
        `<div class="itemTitle">${escapeHtml(title)}</div>` +
        `<div class="itemSub mono">${escapeHtml(age)}</div></div>`;
      const favBtn = card.querySelector(".threadFavBtn");
      if (favBtn) {
        favBtn.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!id) return;
          if (favoriteSet.has(id)) favoriteSet.delete(id);
          else favoriteSet.add(id);
          localStorage.setItem(FAVORITE_THREADS_KEY, JSON.stringify(Array.from(favoriteSet)));
          renderThreads(state.threadItems);
        };
      }
      const openThread = async () => { 
        if (!id) return;
        if (id === state.activeThreadId && state.activeMainTab === "chat" && state.activeThreadStarted) {
          return;
        }
        const reqId = state.openingThreadReqId + 1;
        state.openingThreadReqId = reqId;
        if (state.openingThreadAbort) {
          try {
            state.openingThreadAbort.abort();
          } catch {}
        }
        const controller = new AbortController();
        state.openingThreadAbort = controller;
        setMainTab("chat");
        setMobileTab("chat");
        // Set active thread immediately so background refresh doesn't keep re-rendering the previous chat.
        setActiveThread(id);
        const rolloutPath = String(thread?.path || "").trim();
        state.activeThreadRolloutPath = rolloutPath;
        setChatOpening(true);
        try { 
          const workspaceHint = detectThreadWorkspaceTarget(thread);
          const label = workspaceHint === "wsl2" ? "WSL2" : workspaceHint === "windows" ? "WIN" : "AUTO";

          // clawdex-mobile behavior: resume first, then read thread history via structured API.
          const resumeQuery = [];
          if (workspaceHint === "windows" || workspaceHint === "wsl2") {
            resumeQuery.push(`workspace=${encodeURIComponent(workspaceHint)}`);
          }
          if (rolloutPath) resumeQuery.push(`rolloutPath=${encodeURIComponent(rolloutPath)}`);
          const resumePath = resumeQuery.length
            ? `/codex/threads/${encodeURIComponent(id)}/resume?${resumeQuery.join("&")}`
            : `/codex/threads/${encodeURIComponent(id)}/resume`;
          const resumeStartMs = performance.now();
          const resumeTask = api(resumePath, { method: "POST", body: {}, signal: controller.signal })
            .finally(() => {
              if (state.openingThreadReqId === reqId) scheduleThreadRefresh();
            });
          registerPendingThreadResume(id, resumeTask);
          await resumeTask;
          const resumeLatencyMs = Math.round(performance.now() - resumeStartMs);

          const historyStartMs = performance.now();
          await loadThreadMessages(id, { 
            animateBadge: true,
            signal: controller.signal,
            workspace: workspaceHint === "unknown" ? "" : workspaceHint,
            rolloutPath,
            stickToBottom: true, 
          }); 
          const historyLatencyMs = Math.round(performance.now() - historyStartMs);
          if (state.openingThreadReqId === reqId) { 
            setStatus(`Opened ${label} ${truncateLabel(id, 12)} resume ${resumeLatencyMs}ms history ${historyLatencyMs}ms`); 
          } 

          if (state.openingThreadReqId === reqId) {
            setChatOpening(false);
            // After opening, land at bottom reliably, but do not fight user scrolling.
            state.chatShouldStickToBottom = true;
            scrollToBottomReliable();
          }
        } catch (error) { 
          if (error && (error.name === "AbortError" || String(error.message || "").includes("aborted"))) {
            return;
          }
          if (state.openingThreadReqId === reqId) setChatOpening(false);
          throw error;
        } finally {
          if (state.openingThreadAbort === controller) state.openingThreadAbort = null;
        }
      };
      card.onclick = () => {
        openThread().catch((e) => setStatus(e.message, true));
      };
      card.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openThread().catch((e) => setStatus(e.message, true));
        }
      };
      return card;
  };

  const renderSection = (sectionTitle, sectionItems, sectionKey) => {
    if (!sectionItems.length) return;
    const group = document.createElement("section");
    group.className = "groupCard";
    group.setAttribute("data-group-key", String(sectionKey));
    const header = document.createElement("button");
    const collapsed = state.collapsedWorkspaceKeys.has(sectionKey);
    header.className = `groupHeader${collapsed ? " is-collapsed" : ""}`;
    const animClass =
      state.lastChevronToggleKey === sectionKey
        ? (state.lastChevronToggleCollapsed ? " anim-close" : " anim-open")
        : "";
    header.innerHTML =
      `<span class="itemTitle">${escapeHtml(sectionTitle)}</span>` +
      `<span class="groupChevron${collapsed ? " is-collapsed" : ""}${animClass}" aria-hidden="true">` +
      `<svg class="groupChevronIcon" viewBox="0 0 16 16" focusable="false"><path d="M6 4l4 4-4 4"></path></svg>` +
      `</span>`;
    header.onclick = () => {
      if (state.collapsedWorkspaceKeys.has(sectionKey)) state.collapsedWorkspaceKeys.delete(sectionKey);
      else state.collapsedWorkspaceKeys.add(sectionKey);
      state.lastChevronToggleKey = sectionKey;
      state.lastChevronToggleCollapsed = state.collapsedWorkspaceKeys.has(sectionKey);
      renderThreads(state.threadItems);
    };
    group.appendChild(header);
    if (!collapsed) {
      const body = document.createElement("div");
      body.className = "groupBody";
      for (const thread of sectionItems) body.appendChild(renderThreadCard(thread));
      group.appendChild(body);
      const prevTop = prevGroupScroll.get(String(sectionKey));
      if (typeof prevTop === "number" && Number.isFinite(prevTop) && prevTop > 0) {
        pendingScrollRestores.push({ node: body, top: prevTop });
      }
    }
    list.appendChild(group);
    renderedThreads += sectionItems.length;
  };

  renderSection("Favorites", favoriteItems, "__section_favorites__");

  for (const [workspace, threads, workspaceKey] of entries) {
    const normalizedWorkspace = workspace.toLowerCase();
    const filtered = threads.filter((thread) => {
      const id = thread.id || thread.threadId || "";
      if (id && favoriteSet.has(id)) return false;
      if (!query) return true;
      const lookupId = String(id || "").toLowerCase();
      const title = String(thread.title || thread.name || "").toLowerCase();
      return (
        normalizedWorkspace.includes(query) ||
        lookupId.includes(query) ||
        title.includes(query)
      );
    });
    if (!filtered.length) continue;
    renderedThreads += filtered.length;
    const group = document.createElement("section");
    group.className = "groupCard";
    group.setAttribute("data-group-key", String(workspaceKey));
    const header = document.createElement("button");
    const collapsed = state.collapsedWorkspaceKeys.has(workspaceKey);
    header.className = `groupHeader${collapsed ? " is-collapsed" : ""}`;
    const animClass =
      state.lastChevronToggleKey === workspaceKey
        ? (state.lastChevronToggleCollapsed ? " anim-close" : " anim-open")
        : "";
    header.innerHTML =
      `<span class="itemTitle">${escapeHtml(workspace)}</span>` +
      `<span class="groupChevron${collapsed ? " is-collapsed" : ""}${animClass}" aria-hidden="true">` +
      `<svg class="groupChevronIcon" viewBox="0 0 16 16" focusable="false"><path d="M6 4l4 4-4 4"></path></svg>` +
      `</span>`;
    header.onclick = () => {
      if (state.collapsedWorkspaceKeys.has(workspaceKey)) {
        // Open this group and keep others collapsed (single-expanded behavior).
        for (const [, , key] of entries) state.collapsedWorkspaceKeys.add(key);
        state.collapsedWorkspaceKeys.delete(workspaceKey);
      } else {
        // Collapse this group when tapping it again.
        state.collapsedWorkspaceKeys.add(workspaceKey);
      }
      state.lastChevronToggleKey = workspaceKey;
      state.lastChevronToggleCollapsed = state.collapsedWorkspaceKeys.has(workspaceKey);
      renderThreads(state.threadItems);
    };
    group.appendChild(header);
    if (!collapsed) {
      const body = document.createElement("div");
      body.className = "groupBody";
      for (const thread of filtered) body.appendChild(renderThreadCard(thread));
      group.appendChild(body);
      const prevTop = prevGroupScroll.get(String(workspaceKey));
      if (typeof prevTop === "number" && Number.isFinite(prevTop) && prevTop > 0) {
        pendingScrollRestores.push({ node: body, top: prevTop });
      }
    }
    list.appendChild(group);
  }
  if (!renderedThreads) list.innerHTML = `<div class="muted">No threads match search.</div>`;
  state.lastChevronToggleKey = "";
  state.lastChevronToggleCollapsed = false;
  if (shouldRestoreListScroll || pendingScrollRestores.length) {
    requestAnimationFrame(() => {
      for (const item of pendingScrollRestores) {
        const node = item?.node;
        const prevTop = Number(item?.top || 0);
        if (!node || !Number.isFinite(prevTop) || prevTop <= 0) continue;
        const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
        node.scrollTop = Math.min(prevTop, maxTop);
      }
      if (shouldRestoreListScroll) {
        const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
        list.scrollTop = Math.min(prevListScrollTop, maxTop);
      }
    });
  }
}

async function refreshThreadsFromPullGesture() {
  if (state.threadPullRefreshing) return;
  const list = byId("threadList");
  const hint = byId("threadPullHint");
  const hintText = byId("threadPullHintText");
  if (!list || !hint || !hintText) return;
  const startedAt = Date.now();
  state.threadPullRefreshing = true;
  list.style.transition = "transform 140ms ease";
  list.style.transform = `translateY(${Math.round(THREAD_PULL_REFRESH_TRIGGER_PX * 0.45)}px)`;
  hint.classList.add("show");
  hint.classList.add("refreshing");
  hintText.textContent = "Refreshing chats...";
  try {
    await refreshThreads(getWorkspaceTarget(), { force: true });
    setStatus(`Refreshed ${getWorkspaceTarget().toUpperCase()} chats.`);
  } catch (error) {
    setStatus(error?.message || "Refresh failed.", true);
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed < THREAD_PULL_REFRESH_MIN_MS) await waitMs(THREAD_PULL_REFRESH_MIN_MS - elapsed);
    state.threadPullRefreshing = false;
    setTimeout(() => {
      list.style.transform = "";
      hint.classList.remove("show");
      hint.classList.remove("refreshing");
      setTimeout(() => {
        if (!state.threadPullRefreshing) hintText.textContent = "";
      }, THREAD_PULL_HINT_CLEAR_DELAY_MS);
    }, 120);
  }
}

function wireThreadPullToRefresh() {
  const list = byId("threadList");
  const hint = byId("threadPullHint");
  const hintText = byId("threadPullHintText");
  if (!list || !hint || !hintText) return;
  let startY = 0;
  let pullPx = 0;
  let tracking = false;

  const resetPull = () => {
    pullPx = 0;
    list.style.transition = "transform 140ms ease";
    list.style.transform = "";
    if (!state.threadPullRefreshing) {
      hint.classList.remove("show");
      hint.classList.remove("refreshing");
      hintText.textContent = "";
    }
  };

  list.addEventListener("touchstart", (event) => {
    if (state.threadPullRefreshing) return;
    if (event.touches.length !== 1) return;
    if (list.scrollTop > 0) return;
    startY = event.touches[0].clientY;
    pullPx = 0;
    tracking = true;
  }, { passive: true });

  list.addEventListener("touchmove", (event) => {
    if (!tracking || state.threadPullRefreshing) return;
    const y = event.touches[0]?.clientY ?? startY;
    const raw = y - startY;
    if (raw <= 0) {
      resetPull();
      return;
    }
    if (list.scrollTop > 0) {
      tracking = false;
      resetPull();
      return;
    }
    event.preventDefault();
    pullPx = Math.min(THREAD_PULL_REFRESH_MAX_PX, raw * 0.55);
    list.style.transition = "none";
    list.style.transform = `translateY(${Math.round(pullPx)}px)`;
    hint.classList.add("show");
    hint.classList.remove("refreshing");
    hintText.textContent =
      pullPx >= THREAD_PULL_REFRESH_TRIGGER_PX ? "Release to refresh" : "Pull to refresh";
  }, { passive: false });

  const endPull = () => {
    if (!tracking) return;
    tracking = false;
    if (pullPx >= THREAD_PULL_REFRESH_TRIGGER_PX && !state.threadPullRefreshing) {
      refreshThreadsFromPullGesture().catch(() => {});
      return;
    }
    resetPull();
  };

  list.addEventListener("touchend", endPull, { passive: true });
  list.addEventListener("touchcancel", endPull, { passive: true });
}

function startThreadAutoRefreshLoop() {
  setInterval(() => {
    if (state.threadAutoRefreshInFlight) return;
    const target = getWorkspaceTarget();
    const wsOpen = !!(state.ws && state.ws.readyState === WebSocket.OPEN);
    const wsSubscribed = !!(wsOpen && state.wsSubscribedEvents);
    const minInterval = wsSubscribed ? THREAD_AUTO_REFRESH_CONNECTED_MS : THREAD_AUTO_REFRESH_DISCONNECTED_MS;
    const now = Date.now();
    const lastMs = state.threadAutoRefreshLastMsByWorkspace?.[target] || 0;
    if (now - lastMs < minInterval) return;
    state.threadAutoRefreshLastMsByWorkspace[target] = now;
    const force = now - lastMs > 10000;
    state.threadAutoRefreshInFlight = true;
    refreshThreads(target, { force, silent: true })
      .catch(() => null)
      .finally(() => {
        state.threadAutoRefreshInFlight = false;
      });
  }, 1000);
}

function startActiveThreadLivePollLoop() {
  setInterval(async () => {
    const threadId = state.activeThreadId || "";
    if (!threadId) return;
    if (state.activeMainTab !== "chat") return;
    const wsOpen = !!(state.ws && state.ws.readyState === WebSocket.OPEN);
    const wsSubscribed = !!(wsOpen && state.wsSubscribedEvents);
    // When WS is subscribed, we *mostly* rely on notifications, but keep a low-frequency HTTP poll as
    // a safety net (see constant doc above).
    if (wsSubscribed) {
      const now = Date.now();
      const last = Number(state.activeThreadLiveLastPollMs || 0);
      if (now - last < ACTIVE_THREAD_LIVE_POLL_WS_FALLBACK_MS) return;
      state.activeThreadLiveLastPollMs = now;
    }
    if (state.activeThreadLivePolling) return;
    state.activeThreadLivePolling = true;
    try {
      await loadThreadMessages(threadId, { animateBadge: false });
    } catch {
      // Best-effort polling for external updates.
    } finally {
      state.activeThreadLivePolling = false;
    }
  }, ACTIVE_THREAD_LIVE_POLL_MS);
}

function renderHosts(items) {
  const list = byId("hostList");
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
    card.innerHTML = `<div class="itemTitle">${escapeHtml(id || "approval")}</div><div class="itemSub">${escapeHtml(item?.prompt || item?.title || item?.message || "")}</div>`;
    card.onclick = () => {
      byId("approvalIdInput").value = id;
      setStatus(`Selected approval ${id}`);
    };
    approvalList.appendChild(card);
  }
  if (!state.pendingApprovals.length) approvalList.innerHTML = `<div class="muted">No pending approvals.</div>`;

  const userInputList = byId("userInputPendingList");
  if (!userInputList) return;
  userInputList.innerHTML = "";
  for (const item of state.pendingUserInputs) {
    const id = item?.id || "";
    const card = document.createElement("button");
    card.className = "itemCard";
    card.innerHTML = `<div class="itemTitle">${escapeHtml(id || "request_user_input")}</div><div class="itemSub">${escapeHtml(item?.prompt || item?.title || item?.question || "")}</div>`;
    card.onclick = () => {
      byId("userInputIdInput").value = id;
      setStatus(`Selected user_input ${id}`);
    };
    userInputList.appendChild(card);
  }
  if (!state.pendingUserInputs.length) userInputList.innerHTML = `<div class="muted">No pending user inputs.</div>`;
}

function applyPendingPayloads(approvals, userInputs) {
  state.pendingApprovals = ensureArrayItems(approvals);
  state.pendingUserInputs = ensureArrayItems(userInputs);
  const approvalIdInput = byId("approvalIdInput");
  const userInputIdInput = byId("userInputIdInput");
  if (state.pendingApprovals[0]?.id && approvalIdInput) approvalIdInput.value = state.pendingApprovals[0].id;
  if (state.pendingUserInputs[0]?.id && userInputIdInput) userInputIdInput.value = state.pendingUserInputs[0].id;
  renderPendingLists();
}

async function refreshThreads(workspaceTarget = getWorkspaceTarget(), options = {}) {
  const target = normalizeWorkspaceTarget(workspaceTarget);
  const reqSeq = (state.threadRefreshReqSeqByWorkspace[target] || 0) + 1;
  state.threadRefreshReqSeqByWorkspace[target] = reqSeq;

  if (state.threadRefreshAbortByWorkspace[target]) {
    try {
      state.threadRefreshAbortByWorkspace[target].abort();
    } catch {}
  }
  const controller = new AbortController();
  state.threadRefreshAbortByWorkspace[target] = controller;

  const force = options.force === true;
  const silent = options.silent === true;
  const workspace = encodeURIComponent(target);
  const query = force ? `workspace=${workspace}&force=true` : `workspace=${workspace}`;
  const activeBefore = getWorkspaceTarget() === target;

  if (activeBefore && !silent) {
    state.threadListLoading = true;
    state.threadListLoadingTarget = target;
    renderThreads(state.threadItems);
  }

  try {
    const data = await api(`/codex/threads?${query}`, { signal: controller.signal });
    if ((state.threadRefreshReqSeqByWorkspace[target] || 0) !== reqSeq) return;
    const items = ensureArrayItems(data.items).map((item) => {
      if (!item || typeof item !== "object") return item;
      return {
        ...item,
        workspace: String(item.workspace || "").trim() || target,
      };
    });
    const nextSig = items
      .map((item) => {
        const id = item?.id || item?.threadId || "";
        const ts = item?.updatedAt ?? item?.createdAt ?? "";
        const status = String(item?.status?.type || item?.status || item?.state || "").trim();
        const preview = String(item?.preview || item?.title || item?.name || "").trim();
        return `${id}:${ts}:${status}:${preview}`;
      })
      .join("|");
    state.threadItemsByWorkspace[target] = items;
    if (getWorkspaceTarget() !== target) return;
    // If nothing changed, avoid re-rendering (keeps scroll position stable and reduces work on mobile).
    if (!force && state.threadListRenderSigByWorkspace[target] === nextSig) return;
    state.threadListRenderSigByWorkspace[target] = nextSig;
    state.threadItemsAll = items;
    updateWorkspaceAvailabilityFromThreads(items);
    syncActiveThreadMetaFromList();
    applyThreadFilter();
    updateHeaderUi();
  } finally {
    if (state.threadRefreshAbortByWorkspace[target] === controller) {
      state.threadRefreshAbortByWorkspace[target] = null;
    }
    if ((state.threadRefreshReqSeqByWorkspace[target] || 0) === reqSeq && getWorkspaceTarget() === target && !silent) {
      state.threadListLoading = false;
      state.threadListLoadingTarget = "";
      // If the response is an empty list, we still need a final render pass after flipping the
      // loading flag; otherwise the sidebar can get stuck showing "Loading chats...".
      renderThreads(state.threadItems);
    }
  }
}

async function refreshHosts() {
  const data = await api("/codex/hosts");
  renderHosts(Array.isArray(data.items) ? data.items : []);
}

async function refreshPendingFromHttp() {
  const [approvals, userInputs] = await Promise.all([api("/codex/approvals/pending"), api("/codex/user-input/pending")]);
  applyPendingPayloads(approvals.items, userInputs.items);
}

async function refreshPending() {
  connectWs();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    wsSend({ type: "events.refresh", reqId: nextReqId(), payload: {} });
    return;
  }
  await refreshPendingFromHttp();
}

async function refreshAll() {
  await Promise.all([refreshThreads(), refreshHosts()]);
  await refreshPending();
}

async function connect() {
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
  setMainTab("chat");
  setMobileTab("chat");
}

async function addHost() {
  if (blockInSandbox("host changes")) return;
  const name = byId("hostNameInput").value.trim();
  const baseUrl = byId("hostUrlInput").value.trim();
  if (!name || !baseUrl) throw new Error("host name and base URL are required");
  await api("/codex/hosts", { method: "POST", body: { name, baseUrl, tokenHint: "" } });
  byId("hostNameInput").value = "";
  byId("hostUrlInput").value = "";
  await refreshHosts();
}

async function newThread() {
  if (blockInSandbox("new thread")) return;
  setChatOpening(false);
  // Immediately switch UI back to the fresh-chat state.
  setActiveThread("");
  state.activeThreadStarted = false;
  state.activeThreadWorkspace = getWorkspaceTarget();
  clearChatMessages();
  showWelcomeCard();
  updateHeaderUi();

  const data = await api("/codex/threads", { method: "POST", body: { workspace: getWorkspaceTarget() } });
  const id = data.id || data.threadId || data?.thread?.id || "";
  if (id) {
    setActiveThread(id);
    state.activeThreadStarted = false;
    state.activeThreadWorkspace = getWorkspaceTarget();
    clearChatMessages();
    showWelcomeCard();
    updateHeaderUi();
  }
  await refreshThreads();
  setMainTab("chat");
}

async function sendTurn() {
  if (blockInSandbox("send turn")) return;
  const prompt = getPromptValue();
  if (!prompt) return;
  await waitPendingThreadResume(state.activeThreadId);
  const payload = {
    threadId: state.activeThreadId || null,
    prompt,
    model: state.selectedModel || undefined,
    reasoningEffort: state.selectedReasoningEffort || undefined,
    collaborationMode: "default",
  };
  const shouldAnimateWorkspaceBadge = !state.activeThreadStarted;
  state.activeThreadStarted = true;
  state.activeThreadWorkspace = getWorkspaceTarget();
  updateHeaderUi(shouldAnimateWorkspaceBadge);
  addChat("user", prompt);
  state.chatShouldStickToBottom = true;
  scrollToBottomReliable();
  setMainTab("chat");
  clearPromptValue();
  connectWs();

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    const reqId = nextReqId();
    let text = "";
    hideWelcomeCard();
    const { msg, body } = createAssistantStreamingMessage();
    if (!body) return;
    byId("chatBox").appendChild(msg);
    // Don't "snap" to bottom for live streaming; follow smoothly as content grows.
    scheduleChatLiveFollow(900);
    await new Promise((resolve) => {
      state.wsReqHandlers.set(reqId, (evt) => {
        const type = evt.type;
        const data = evt.payload || {};
        if (type === "delta") {
          if (typeof data.text === "string" && data.text) {
            const chunk = (text ? " " : "") + data.text;
            text += chunk;
            appendStreamingDelta(body, chunk);
          }
          // Keep the streaming assistant near bottom without snapping.
          scheduleChatLiveFollow(700);
          if (typeof data.threadId === "string" && data.threadId) setActiveThread(data.threadId);
        } else if (type === "completed") {
          const result = data.result || {};
          const threadId = result.threadId || result.thread_id || result?.thread?.id || state.activeThreadId;
          if (threadId) setActiveThread(threadId);
          if (!text.trim()) text = normalizeTextPayload(result);
          finalizeAssistantMessage(msg, body, text);
          scheduleChatLiveFollow(800);
          maybeNotifyTurnDone(text || "");
          state.wsReqHandlers.delete(reqId);
          resolve();
        } else if (type === "error") {
          setStatus(evt.message || "WS stream error.", true);
          finalizeAssistantMessage(msg, body, text);
          scheduleChatLiveFollow(800);
          state.wsReqHandlers.delete(reqId);
          resolve();
        }
      });
      if (!wsSend({ type: "turn.stream", reqId, payload })) {
        state.wsReqHandlers.delete(reqId);
        resolve();
      }
    });
    await refreshThreads();
    return;
  }

  const headers = { "Content-Type": "application/json" };
  if (state.token.trim()) headers.Authorization = `Bearer ${state.token.trim()}`;
  const res = await fetch("/codex/turns/stream", { method: "POST", headers, body: JSON.stringify(payload) });
  if (!res.ok || !res.body) {
    const fallback = await api("/codex/turns/start", { method: "POST", body: payload });
    const threadId = fallback.threadId || fallback.thread_id || fallback?.thread?.id || state.activeThreadId;
    if (threadId) setActiveThread(threadId);
    addChat("assistant", normalizeTextPayload(fallback.result || fallback));
    await refreshThreads();
    return;
  }

  let text = "";
  hideWelcomeCard();
  const { msg, body } = createAssistantStreamingMessage();
  if (!body) return;
  byId("chatBox").appendChild(msg);
  scheduleChatLiveFollow(900);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    sseBuffer += decoder.decode(part.value, { stream: true });
    const chunks = sseBuffer.split("\n\n");
    sseBuffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let evtName = "message";
      let dataLine = "";
      for (const line of lines) {
        if (line.startsWith("event:")) evtName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      let data = {};
      try { data = JSON.parse(dataLine); } catch { data = {}; }
      if (evtName === "delta") {
        const delta = typeof data.text === "string" ? data.text : "";
        if (delta) {
          const chunk = (text ? " " : "") + delta;
          text += chunk;
          appendStreamingDelta(body, chunk);
        }
        scheduleChatLiveFollow(700);
        if (typeof data.threadId === "string" && data.threadId) setActiveThread(data.threadId);
      } else if (evtName === "completed") {
        const result = data.result || {};
        const threadId = result.threadId || result.thread_id || result?.thread?.id || state.activeThreadId;
        if (threadId) setActiveThread(threadId);
        if (!text.trim()) text = normalizeTextPayload(result);
        finalizeAssistantMessage(msg, body, text);
        scheduleChatLiveFollow(800);
        maybeNotifyTurnDone(text || "");
      } else if (evtName === "error") {
        setStatus(data?.message || "Stream error.", true);
      }
    }
  }
  if (body.childNodes.length === 0) finalizeAssistantMessage(msg, body, text);
  await refreshThreads();
}

async function uploadAttachment(file) {
  if (blockInSandbox("attachment upload")) return;
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const base64Data = btoa(binary);
  const data = await api("/codex/attachments/upload", {
    method: "POST",
    body: {
      threadId: state.activeThreadId || "unassigned",
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      base64Data,
    },
  });
  renderAttachmentPills([file]);
  setStatus(`Attachment uploaded: ${data.fileName || file.name}`);
}

async function resolveApproval() {
  if (blockInSandbox("approval resolve")) return;
  const id = byId("approvalIdInput").value.trim();
  const decision = byId("approvalDecisionSelect").value;
  if (!id) throw new Error("approval id required");
  connectWs();
  let data;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    data = await wsCall("approval.resolve", { id, decision }, "approval.resolved");
  } else {
    data = await api(`/codex/approvals/${encodeURIComponent(id)}/resolve`, { method: "POST", body: { decision } });
  }
  addChat("system", `approval resolved: ${JSON.stringify(data)}`);
  await refreshPending();
}

async function resolveUserInput() {
  if (blockInSandbox("user input resolve")) return;
  const id = byId("userInputIdInput").value.trim();
  const answerKey = byId("userInputAnswerKeyInput").value.trim();
  const answerValue = byId("userInputAnswerValueInput").value.trim();
  if (!id || !answerKey) throw new Error("user_input id and answer key required");
  const answers = { [answerKey]: answerValue };
  connectWs();
  let data;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    data = await wsCall("user_input.resolve", { id, answers }, "user_input.resolved");
  } else {
    data = await api(`/codex/user-input/${encodeURIComponent(id)}/resolve`, { method: "POST", body: { answers } });
  }
  addChat("system", `user input resolved: ${JSON.stringify(data)}`);
  await refreshPending();
}

function setMobileTab(tab) {
  document.body.classList.remove("drawer-left-open", "drawer-right-open");
  if (tab === "threads") document.body.classList.add("drawer-left-open");
  if (tab === "tools") document.body.classList.add("drawer-right-open");
  byId("mobileDrawerBackdrop").classList.toggle("show", tab === "threads" || tab === "tools");
}

function wireActions() {
  bindClick("addHostBtn", () => addHost().catch((e) => setStatus(e.message, true)));
  bindClick("resolveApprovalBtn", () => resolveApproval().catch((e) => setStatus(e.message, true)));
  bindClick("resolveUserInputBtn", () => resolveUserInput().catch((e) => setStatus(e.message, true)));
  bindClick("refreshPendingBtn", () => refreshPending().catch((e) => setStatus(e.message, true)));
  bindInput("attachInput", "change", (event) => {
    uploadAttachment(event.target?.files?.[0]).catch((e) => setStatus(e.message, true));
  });
  bindClick("mobileAttachBtn", () => byId("attachInput")?.click());
  bindClick("mobileSendBtn", () => sendTurn().catch((e) => setStatus(e.message, true)));
  bindInput("mobilePromptInput", "input", () => updateMobileComposerState());
  bindInput("mobilePromptInput", "keyup", () => updateMobileComposerState());
  bindInput("mobilePromptInput", "change", () => updateMobileComposerState());
  bindInput("mobilePromptInput", "keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendTurn().catch((e) => setStatus(e.message, true));
    }
  });
  bindClick("enableNotifBtn", async () => {
    if (!("Notification" in window)) {
      setStatus("Notifications are not supported.", true);
      return;
    }
    try { await Notification.requestPermission(); } catch {}
    updateNotificationState();
  });
  bindClick("dismissGuideBtn", () => {
    localStorage.setItem(GUIDE_DISMISSED_KEY, "1");
    if (byId("guideList")) byId("guideList").style.display = "none";
  });
  // Prefer pointerdown for responsiveness on mobile WebViews.
  {
    const btn = byId("mobileMenuBtn");
    if (btn && !btn.__wiredPointerOpenDrawer) {
      btn.__wiredPointerOpenDrawer = true;
      const open = (event) => {
        try {
          event?.preventDefault?.();
          event?.stopPropagation?.();
        } catch {}
        if (event && String(event.type || "") === "pointerdown") {
          armSyntheticClickSuppression(450);
        }
        setMobileTab("threads");
      };
      btn.addEventListener("pointerdown", open, { passive: false });
      btn.addEventListener("click", open);
    }
  }
  // Mobile WebViews can drop/delay "click" during heavy UI work (e.g. while opening a large chat).
  // Close drawers on pointerdown to keep the app feeling responsive.
  {
    const backdrop = byId("mobileDrawerBackdrop");
    if (backdrop && !backdrop.__wiredCloseDrawer) {
      backdrop.__wiredCloseDrawer = true;
      const close = (event) => {
        if (shouldSuppressSyntheticClick(event)) return;
        try {
          event?.preventDefault?.();
          event?.stopPropagation?.();
        } catch {}
        if (event && String(event.type || "") === "pointerdown") {
          // Guard against click-through: after closing the drawer on pointerdown,
          // some WebViews still dispatch a synthesized click to the element behind the backdrop.
          armSyntheticClickSuppression(420);
        }
        setMobileTab("chat");
      };
      backdrop.addEventListener("pointerdown", close, { passive: false });
      backdrop.addEventListener("click", close);
    }
  }
  bindClick("leftStartDirBtn", () => {
    setStatus(`Current start directory target: ${getWorkspaceTarget().toUpperCase()}.`);
    setMobileTab("threads");
  });
  bindClick("leftNewChatBtn", () => {
    newThread().catch((e) => setStatus(e.message, true));
    setMainTab("chat");
    setMobileTab("chat");
  });
  bindClick("leftSettingsBtn", () => {
    setMainTab("settings");
    refreshCodexVersions().catch(() => {});
    setMobileTab("chat");
  });
  bindClick("welcomeWorkspaceBtn", () => {
    setStatus(`Current start directory target: ${getWorkspaceTarget().toUpperCase()}.`);
    setMobileTab("threads");
  });
  bindClick("workspaceWindowsBtn", () => setWorkspaceTarget("windows").catch((e) => setStatus(e.message, true)));
  bindClick("workspaceWslBtn", () => setWorkspaceTarget("wsl2").catch((e) => setStatus(e.message, true)));
  bindClick("drawerWorkspaceWindowsBtn", () => setWorkspaceTarget("windows").catch((e) => setStatus(e.message, true)));
  bindClick("drawerWorkspaceWslBtn", () => setWorkspaceTarget("wsl2").catch((e) => setStatus(e.message, true)));
  const headerModelPicker = byId("headerModelPicker");
  const headerModelTrigger = byId("headerModelTrigger");
  if (headerModelTrigger) {
    const toggle = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.modelOptionsLoading) return;
      if (event && String(event.type || "") === "pointerdown") armSyntheticClickSuppression(380);
      const isOpen = !!headerModelPicker?.classList.contains("open");
      setHeaderModelMenuOpen(!isOpen);
    };
    if (!headerModelTrigger.__wiredPointerToggle) {
      headerModelTrigger.__wiredPointerToggle = true;
      // Use a single activation event to avoid double-toggling on mobile taps
      // (pointerdown opens, then the synthesized click closes).
      if (typeof window !== "undefined" && "PointerEvent" in window) {
        headerModelTrigger.addEventListener("pointerdown", toggle, { passive: false });
      } else {
        headerModelTrigger.addEventListener("click", toggle);
      }
    }
    headerModelTrigger.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (state.modelOptionsLoading) return;
        const isOpen = !!headerModelPicker?.classList.contains("open");
        setHeaderModelMenuOpen(!isOpen);
      } else if (event.key === "Escape") {
        setHeaderModelMenuOpen(false);
      }
    };
  }
  if (!document.__wiredSyntheticClickCapture) {
    document.__wiredSyntheticClickCapture = true;
    // Capture-phase guard so suppressed synthetic clicks never reach underlying buttons.
    document.addEventListener("click", (event) => {
      shouldSuppressSyntheticClick(event);
    }, true);
  }
  document.addEventListener("click", (event) => {
    if (shouldSuppressSyntheticClick(event)) return;
    const target = event.target;
    if (!headerModelPicker || !(target instanceof Node)) return;
    if (!headerModelPicker.contains(target)) {
      setHeaderModelMenuOpen(false);
      closeInlineEffortOverlay();
    }
  });
  bindClick("quickPrompt1", () => {
    const text = "Explain the current codebase structure";
    if (byId("mobilePromptInput")) byId("mobilePromptInput").value = text;
    updateMobileComposerState();
  });
  bindClick("quickPrompt2", () => {
    const text = "Write tests for the main module";
    if (byId("mobilePromptInput")) byId("mobilePromptInput").value = text;
    updateMobileComposerState();
  });
  const threadSearchInput = byId("threadSearchInput");
  if (threadSearchInput) threadSearchInput.oninput = (event) => {
    state.threadSearchQuery = String(event?.target?.value || "");
    renderThreads(state.threadItems);
  };
  wireThreadPullToRefresh();
  window.addEventListener("resize", () => {
    updateMobileComposerState();
    setMobileTab("chat");
  });
}

function bootstrap() {
  // E2E-only hooks (guarded). This avoids relying on a running gateway just to validate
  // UI behaviors like scroll anchoring, scrollbar hiding, and history rendering.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("e2e") === "1" && !window.__webCodexE2E) {
      const historyByThreadId = new Map();
      window.__webCodexE2E = {
        _activeThreadId: "",
        setModelLoading(loading = true) {
          state.modelOptionsLoading = !!loading;
          if (loading) state.modelOptions = [];
          setHeaderModelMenuOpen(false);
          updateHeaderUi();
          return { ok: true, loading: state.modelOptionsLoading };
        },
        setModels(items) {
          // E2E helper: seed deterministic models without requiring a running gateway.
          state.modelOptions = ensureArrayItems(items).map(normalizeModelOption).filter(Boolean);
          state.modelOptionsLoading = false;
          // Populate state even if the picker hasn't rendered yet (avoid brittle DOM timing in tests).
          const options = Array.isArray(state.modelOptions) ? state.modelOptions : [];
          state.selectedModel = pickLatestModelId(options) || options.find((x) => x && x.isDefault)?.id || options[0]?.id || "";
          if (state.selectedModel) {
            const active = options.find((x) => x && x.id === state.selectedModel) || options[0] || null;
            const supported = Array.isArray(active?.supportedReasoningEfforts) ? active.supportedReasoningEfforts : [];
            const persisted = String(localStorage.getItem(REASONING_EFFORT_KEY) || "").trim();
            if (supported.length) {
              const ok = persisted && supported.some((x) => x && x.effort === persisted);
              const hasMedium = supported.some((x) => String(x?.effort || "").trim() === "medium");
              const next = ok ? persisted : (hasMedium ? "medium" : String(active.defaultReasoningEffort || supported[0]?.effort || "").trim());
              state.selectedReasoningEffort = next;
              if (next) localStorage.setItem(REASONING_EFFORT_KEY, next);
            } else {
              state.selectedReasoningEffort = persisted;
            }
          }
          renderHeaderModelMenu();
          updateHeaderUi();
          return { ok: true, count: state.modelOptions.length };
        },
        loadModelsWithMinLoadingMs(items, minLoadingMs = MODEL_LOADING_MIN_MS) {
          // E2E helper: emulate "models load too fast" without a gateway, while enforcing minimum
          // loading time to avoid label flash.
          const minMs = Math.max(0, Number(minLoadingMs || 0));
          const seq = Number(state.modelOptionsLoadingSeq || 0) + 1;
          state.modelOptionsLoadingSeq = seq;
          state.modelOptionsLoadingStartedAt = performance.now();
          state.modelOptionsLoading = true;
          state.modelOptions = [];
          setHeaderModelMenuOpen(false);
          updateHeaderUi();

          state.modelOptions = ensureArrayItems(items).map(normalizeModelOption).filter(Boolean);
          // Populate state even if the picker hasn't rendered yet (avoid brittle DOM timing in tests).
          const options = Array.isArray(state.modelOptions) ? state.modelOptions : [];
          state.selectedModel = pickLatestModelId(options) || options.find((x) => x && x.isDefault)?.id || options[0]?.id || "";
          if (state.selectedModel) {
            const active = options.find((x) => x && x.id === state.selectedModel) || options[0] || null;
            const supported = Array.isArray(active?.supportedReasoningEfforts) ? active.supportedReasoningEfforts : [];
            const persisted = String(localStorage.getItem(REASONING_EFFORT_KEY) || "").trim();
            if (supported.length) {
              const ok = persisted && supported.some((x) => x && x.effort === persisted);
              const hasMedium = supported.some((x) => String(x?.effort || "").trim() === "medium");
              const next = ok ? persisted : (hasMedium ? "medium" : String(active.defaultReasoningEffort || supported[0]?.effort || "").trim());
              state.selectedReasoningEffort = next;
              if (next) localStorage.setItem(REASONING_EFFORT_KEY, next);
            } else {
              state.selectedReasoningEffort = persisted;
            }
          }
          renderHeaderModelMenu();
          updateHeaderUi();

          const elapsed = performance.now() - Number(state.modelOptionsLoadingStartedAt || 0);
          const remaining = Math.max(0, minMs - elapsed);
          setTimeout(() => {
            try {
              if (state.modelOptionsLoadingSeq !== seq) return;
              state.modelOptionsLoading = false;
              updateHeaderUi();
            } catch {}
          }, remaining);
          return { ok: true, remainingMs: Math.round(remaining) };
        },
        seedThreads(count = 260) {
          const items = [];
          for (let i = 0; i < count; i += 1) {
            items.push({
              id: `e2e_${i}`,
              title: `Row ${i}`,
              preview: `preview ${i}`,
              cwd: i % 2 === 0 ? "API-Router" : "XAUUSD-Calendar-Agent",
              workspace: i % 3 === 0 ? "wsl2" : "windows",
              createdAt: Math.floor(Date.now() / 1000) - i * 60,
              updatedAt: Math.floor(Date.now() / 1000) - i * 60,
            });
          }
          state.threadItemsByWorkspace.windows = items.filter((x) => x.workspace !== "wsl2");
          state.threadItemsByWorkspace.wsl2 = items.filter((x) => x.workspace === "wsl2");
          state.threadItemsAll = items;
          applyThreadFilter();
          return { ok: true, count: items.length };
        },
        rerenderThreads() {
          renderThreads(state.threadItems);
          return { ok: true };
        },
        setThreadHistory(threadId, thread) {
          if (!threadId || !thread) return { ok: false };
          historyByThreadId.set(String(threadId), thread);
          return { ok: true };
        },
        seedHeavyThreadHistory(threadId, config = {}) {
          const id = String(threadId || "").trim();
          if (!id) return { ok: false, error: "missing threadId" };
          const turnsN = Math.max(1, Math.min(1200, Number(config.turns || 240) | 0));
          const itemsPerTurn = Math.max(2, Math.min(40, Number(config.itemsPerTurn || 6) | 0));
          const textSize = Math.max(16, Math.min(12000, Number(config.textSize || 1600) | 0));
          const base = "x".repeat(textSize);
          const mk = (prefix, ti, ii) => `${prefix} ${ti}.${ii}\n${base}`;
          const turns = [];
          for (let ti = 0; ti < turnsN; ti += 1) {
            const items = [];
            items.push({
              type: "userMessage",
              content: [{ type: "text", text: mk("User", ti, 0) }],
            });
            for (let ii = 1; ii < itemsPerTurn; ii += 1) {
              items.push({ type: "assistantMessage", text: mk("Assistant", ti, ii) });
            }
            turns.push({ id: `t_${ti}`, items });
          }
          const thread = { id, modelName: "gpt-5.3-codex", turns };
          historyByThreadId.set(id, thread);
          return { ok: true, turns: turnsN, itemsPerTurn, textSize };
        },
        getThreadHistory(threadId) {
          return historyByThreadId.get(String(threadId || ""));
        },
        parseUserContentParts(content) {
          try {
            const item = { content: Array.isArray(content) ? content : [] };
            const parsed = parseUserMessageParts(item);
            return { ok: true, text: parsed.text || "", images: parsed.images || [] };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        renderAttachmentsHtml(images) {
          try {
            const html = renderMessageAttachments(Array.isArray(images) ? images : []);
            return { ok: true, html: String(html || "") };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        async openThread(threadId) {
          const id = String(threadId || "").trim();
          if (!id) return { ok: false, error: "missing threadId" };
          this._activeThreadId = id;
          setMainTab("chat");
          setMobileTab("chat");
          setActiveThread(id);
          setChatOpening(false);
          await loadThreadMessages(id, { animateBadge: true, forceRender: true, stickToBottom: true });
          return { ok: true };
        },
        startOpenThreadSlow(threadId, opts = {}) {
          const id = String(threadId || "").trim();
          if (!id) return { ok: false, error: "missing threadId" };
          this._activeThreadId = id;
          setMainTab("chat");
          setMobileTab("chat");
          setActiveThread(id);
          setChatOpening(true);
          // Intentionally slow, chunked render for regression testing "header remains clickable while opening".
          window.__webCodexE2E_openPromise = loadThreadMessages(id, {
            animateBadge: true,
            forceRender: true,
            stickToBottom: true,
            slowRender: true,
          });
          return { ok: true };
        },
        async awaitSlowOpenDone() {
          try {
            await window.__webCodexE2E_openPromise;
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        async refreshActiveThread() {
          const id = String(this._activeThreadId || state.activeThreadId || "").trim();
          if (!id) return { ok: false, error: "missing active threadId" };
          await loadThreadMessages(id, { animateBadge: false, forceRender: true });
          return { ok: true };
        },
        async refreshThreadsWithMock(target = "windows", items = []) {
          const workspace = normalizeWorkspaceTarget(String(target || "windows"));
          const origFetch = window.fetch;
          window.fetch = async (input, init) => {
            try {
              const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
              if (typeof url === "string" && url.startsWith("/codex/threads")) {
                const body = JSON.stringify({ items: { data: Array.isArray(items) ? items : [], nextCursor: null } });
                return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
              }
            } catch {}
            return origFetch(input, init);
          };
          try {
            await refreshThreads(workspace, { force: true });
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          } finally {
            window.fetch = origFetch;
          }
        },
        emitWsPayload(payload) {
          try {
            handleWsPayload(payload);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        setChatStickiness(sticky = true) {
          state.chatShouldStickToBottom = !!sticky;
          state.chatUserScrolledAwayAt = sticky ? 0 : Date.now();
          return { ok: true, sticky: state.chatShouldStickToBottom };
        },
        scrollChatToBottomNow() {
          try {
            state.chatShouldStickToBottom = true;
            state.chatUserScrolledAwayAt = 0;
            scrollChatToBottom({ force: true });
            scrollToBottomReliable();
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        createStreamingMessage() {
          try {
            const created = createAssistantStreamingMessage();
            const msg = created?.msg;
            const body = created?.body;
            const box = byId("chatBox");
            if (!msg || !body || !box) return { ok: false };
            box.appendChild(msg);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        appendStreamingDelta(text) {
          try {
            const box = byId("chatBox");
            const body = box?.querySelector?.(".msg.assistant:last-of-type .msgBody") || null;
            if (!body) return { ok: false, error: "missing streaming body" };
            appendStreamingDelta(body, String(text || ""));
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        installFetchRecorder() {
          try {
            if (window.__webCodexE2E_fetchRecorderInstalled) return { ok: true };
            window.__webCodexE2E_fetchRecorderInstalled = true;
            const calls = [];
            window.__webCodexE2E_fetchCalls = calls;
            const orig = window.fetch;
            window.__webCodexE2E_fetchOrig = orig;
            window.fetch = async (input, init) => {
              const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
              calls.push({ url: String(url || ""), method: String(init?.method || "GET") });
              if (typeof url === "string" && url.includes("/codex/threads/") && url.includes("/history")) {
                const id = String(url.split("/codex/threads/")[1] || "").split("/")[0] || "e2e";
                const thread = { id: decodeURIComponent(id), turns: [{ items: [{ type: "assistantMessage", text: "ok" }] }] };
                return new Response(JSON.stringify({ thread }), { status: 200, headers: { "Content-Type": "application/json" } });
              }
              return orig(input, init);
            };
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        getFetchCalls() {
          try {
            return Array.isArray(window.__webCodexE2E_fetchCalls) ? window.__webCodexE2E_fetchCalls.slice() : [];
          } catch {
            return [];
          }
        },
        setWsConnectedForE2E(connected = true) {
          state.wsSubscribedEvents = !!connected;
          if (connected) state.ws = { readyState: 1 };
          else state.ws = null;
          return { ok: true };
        },
        async triggerHistoryFetchForE2E({ threadId, workspace = "windows", rolloutPath = "" } = {}) {
          const id = String(threadId || "").trim() || "e2e_net_thread";
          setActiveThread(id);
          state.activeThreadWorkspace = workspace === "wsl2" ? "wsl2" : "windows";
          state.activeThreadRolloutPath = String(rolloutPath || "").trim();
          await loadThreadMessages(id, { animateBadge: false, forceRender: true, workspace: state.activeThreadWorkspace, rolloutPath: state.activeThreadRolloutPath });
          return { ok: true };
        },
      };
      setStatus("E2E mode enabled.", true);
    }
  } catch {}

  const embeddedToken = getEmbeddedToken();
  const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  const savedWorkspaceTarget = localStorage.getItem(WORKSPACE_TARGET_KEY) || "windows";
  const savedFavoritesRaw = localStorage.getItem(FAVORITE_THREADS_KEY) || "[]";
  const savedModel = String(localStorage.getItem(SELECTED_MODEL_KEY) || "").trim();
  try {
    const savedFavorites = JSON.parse(savedFavoritesRaw);
    if (Array.isArray(savedFavorites)) {
      state.favoriteThreadIds = new Set(savedFavorites.map((v) => String(v)));
    }
  } catch {
    state.favoriteThreadIds = new Set();
  }
  const initialToken = embeddedToken || savedToken;
  if (initialToken) {
    state.token = initialToken;
    if (!embeddedToken) byId("tokenInput").value = initialToken;
  }
  state.workspaceTarget = normalizeWorkspaceTarget(savedWorkspaceTarget);
  state.activeThreadWorkspace = state.workspaceTarget;
  if (savedModel) state.selectedModel = savedModel;
  updateWorkspaceAvailability(false, false);
  applyWorkspaceUi();
  syncHeaderModelPicker();
  if (SANDBOX_MODE) {
    const sandboxBadge = byId("sandboxBadge");
    if (sandboxBadge) sandboxBadge.style.display = "inline-flex";
    setStatus("Sandbox mode enabled: read-only preview against live data.", true);
  } else {
    setStatus("Ready.");
  }
  if (localStorage.getItem(GUIDE_DISMISSED_KEY) === "1" && byId("guideList")) byId("guideList").style.display = "none";
  updateNotificationState();
  applyManagedTokenUi();
  renderPendingLists();
  renderAttachmentPills([]);
  updateMobileComposerState();
  syncSettingsControlsFromMain();
  updateWelcomeSelections();
  setMainTab("chat");
  wireActions();
  // Floating "scroll to bottom" affordance (ChatGPT-style).
  try {
    const chatBox = byId("chatBox");
    if (chatBox && !chatBox.__wiredScrollToBottom) {
      chatBox.__wiredScrollToBottom = true;
      ensureScrollToBottomBtn();
      // Capture "user intent" signals so we can distinguish user scrolling from our own
      // programmatic scrollTop updates (especially during the open-chat auto-stick window).
      if (!chatBox.__wiredUserGesture) {
        chatBox.__wiredUserGesture = true;
        const markGesture = () => {
          state.chatLastUserGestureAt = Date.now();
          // Any user gesture should immediately cancel live-follow so we never "yank" the user back down.
          stopChatLiveFollow();
        };
        chatBox.addEventListener("pointerdown", markGesture, { passive: true });
        chatBox.addEventListener("touchstart", markGesture, { passive: true });
        chatBox.addEventListener("wheel", markGesture, { passive: true });
      }
      chatBox.addEventListener(
        "scroll",
        () => {
          updateScrollToBottomBtn();
          // clawdex-style: update stickiness based on distance-to-bottom when we observe a user gesture.
          const now = Date.now();
          // During our short "programmatic scroll" windows, still respect user gestures:
          // if the user is touching/scrolling, treat this as real intent and allow cancellation.
          const inProgrammatic = now <= Number(state.chatProgrammaticScrollUntil || 0);
          const recentGesture = now - Number(state.chatLastUserGestureAt || 0) <= 900;
          // Smooth-scroll windows are for our own UI animations; they must NOT suppress a real user
          // "scroll away" intent (otherwise we yank them back to bottom).
          if (now <= Number(state.chatSmoothScrollUntil || 0) && !recentGesture) return;
          if (inProgrammatic && !recentGesture) return;
          // No recent user intent: treat as layout-induced scroll (images/fonts/DOM changes),
          // and do not flip stickiness off. Flipping it off breaks open-chat pinning and live-follow.
          if (!recentGesture) return;
          const dist = chatDistanceFromBottom(chatBox);
          const nextSticky = dist <= CHAT_STICKY_BOTTOM_PX;
          // Important: while we're in a programmatic scroll window (open-chat pinning, follow-bottom,
          // etc.), do NOT let those programmatic scroll events re-enable stickiness. Otherwise a user
          // who scrolls up "immediately after open" can get yanked back to bottom because the follow
          // scroll runs after their gesture and flips sticky=true again.
          if (inProgrammatic && nextSticky) return;
          dbgSet({
            lastChatScrollDist: Math.round(dist),
            lastChatScrollSticky: !!nextSticky,
            lastChatScrollInProgrammatic: !!inProgrammatic,
            lastChatScrollRecentGesture: !!recentGesture,
          });
          state.chatShouldStickToBottom = nextSticky;
          if (!nextSticky) {
            state.chatUserScrolledAwayAt = now;
            stopChatLiveFollow();
          } else {
            state.chatUserScrolledAwayAt = 0;
          }
        },
        { passive: true }
      );
      updateScrollToBottomBtn();
    }
  } catch {}
  // Live follow: when new content is appended while the user is near bottom (streaming deltas),
  // smoothly follow the bottom instead of snapping (prevents "blank jump" then fade-in).
  try {
    const chatBox = byId("chatBox");
    if (chatBox && !chatBox.__wiredLiveFollow) {
      chatBox.__wiredLiveFollow = true;
      let scheduled = false;
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          scheduleChatLiveFollow(520);
        });
      };
      const obs = new MutationObserver(() => {
        // Ignore while an explicit smooth-scroll is running (user-initiated).
        if (Date.now() <= Number(state.chatSmoothScrollUntil || 0)) return;
        const now = Date.now();
        const alreadyFollowing = now <= Number(state.chatLiveFollowUntil || 0);
        if (!alreadyFollowing && !canStartChatLiveFollow()) return;
        schedule();
      });
      obs.observe(chatBox, { childList: true, subtree: true, characterData: true });
    }
  } catch {}
  // Late-settles: images (and other async media) can change layout without mutating DOM, so a MutationObserver
  // won't fire. Use a capture-phase load/error listener to keep sticky-to-bottom chats pinned while media loads.
  try {
    const chatBox = byId("chatBox");
    if (chatBox && !chatBox.__wiredMediaSettleFollow) {
      chatBox.__wiredMediaSettleFollow = true;
      const onSettle = () => {
        // Ignore while an explicit smooth-scroll is running (user-initiated).
        if (Date.now() <= Number(state.chatSmoothScrollUntil || 0)) return;
        if (!canStartChatLiveFollow()) return;
        scheduleChatLiveFollow(1200);
      };
      chatBox.addEventListener("load", onSettle, true);
      chatBox.addEventListener("error", onSettle, true);
    }
  } catch {}
  startThreadAutoRefreshLoop();
  startActiveThreadLivePollLoop();
  setMobileTab("chat");
  // Always attempt connect: gateway auth can now come from HttpOnly cookie.
  connect().catch((e) => setStatus(e.message, true));
}

bootstrap();
