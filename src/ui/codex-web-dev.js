try {
  window.__webCodexScriptLoaded = true;
} catch {}

const WEB_CODEX_DEV_DEBUG_VERSION = "2026-03-09-debug-7";
const CONTEXT_LEFT_BASELINE_TOKENS = 12000;
const CONTEXT_LEFT_DIGIT_ANIMATION_MS = 640;
const CONTEXT_LEFT_DIGIT_STAGGER_MS = 112;
const CONTEXT_LEFT_DIGIT_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const CONTEXT_LEFT_DIGIT_TRAVEL_PERCENT = 104;

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
  threadWorkspaceHydratedByWorkspace: {
    windows: false,
    wsl2: false,
  },
  threadListRenderSigByWorkspace: {
    windows: "",
    wsl2: "",
  },
  threadListLoading: false,
  threadListLoadingTarget: "",
  threadListAnimateNextRender: false,
  threadListAnimateThreadIds: new Set(),
  threadListExpandAnimateGroupKeys: new Set(),
  threadListPendingSidebarOpenAnimation: false,
  threadListPendingVisibleAnimationByWorkspace: {
    windows: false,
    wsl2: false,
  },
  threadListVisibleOpenAnimationUntil: 0,
  threadListVisibleAnimationTimer: 0,
  threadListAnimationHoldUntilByWorkspace: {
    windows: 0,
    wsl2: 0,
  },
  threadListDeferredRenderTimerByWorkspace: {
    windows: 0,
    wsl2: 0,
  },
  threadListSkipScrollRestoreOnce: false,
  threadListPreferLoadingPlaceholder: false,
  drawerOpenPhaseTimer: 0,
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
  threadForceRefreshLastMsByWorkspace: {
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
  collapsedWorkspaceKeysByWorkspace: {
    windows: new Set(),
    wsl2: new Set(),
  },
  threadGroupCollapseInitializedByWorkspace: {
    windows: false,
    wsl2: false,
  },
  sidebarCollapsed: false,
  threadSearchQuery: "",
  activeMainTab: "chat",
  workspaceTarget: "windows",
  workspaceAvailability: {
    windowsInstalled: false,
    wsl2Installed: false,
  },
  gatewayBuildStaleWarned: false,
  startCwdByWorkspace: {
    windows: "",
    wsl2: "",
  },
  folderPickerOpen: false,
  folderPickerWorkspace: "windows",
  folderPickerCurrentPath: "",
  folderPickerParentPath: "",
  folderPickerItems: [],
  folderPickerLoading: false,
  folderPickerError: "",
  folderPickerReqSeq: 0,
  folderPickerListRenderSig: "",
  folderPickerKeepContentWhileLoading: true,
  favoriteThreadIds: new Set(),
  threadListChevronOpenAnimateKeys: new Set(),
  threadListChevronCloseAnimateKeys: new Set(),
  threadListCollapseAnimateGroupKeys: new Set(),
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
  historyWindowSize: 60,
  historyWindowChunk: 60,
  historyWindowLoading: false,
  historyAllMessages: [],
  activeThreadHistoryTurns: [],
  activeThreadHistoryThreadId: "",
  activeThreadHistoryHasMore: false,
  activeThreadHistoryIncomplete: false,
  activeThreadHistoryBeforeCursor: "",
  activeThreadHistoryTotalTurns: 0,
  activeThreadHistoryReqSeq: 0,
  activeThreadHistoryInFlightPromise: null,
  activeThreadHistoryInFlightThreadId: "",
  activeThreadHistoryPendingRefresh: null,
  activeThreadTokenUsage: null,
};

const threadAnimDebug = {
  enabled: false,
  events: [],
  seq: 0,
};

function isThreadAnimDebugEnabled() {
  return !!threadAnimDebug.enabled;
}

function pushThreadAnimDebug(type, detail = {}) {
  if (!threadAnimDebug.enabled) return;
  const entry = {
    seq: ++threadAnimDebug.seq,
    ts: Math.round(performance.now()),
    type: String(type || ""),
    workspace: normalizeWorkspaceTarget(state.workspaceTarget || "windows"),
    drawerOpen: document.body.classList.contains("drawer-left-open"),
    drawerOpening: document.body.classList.contains("drawer-left-opening"),
    threadListLoading: !!state.threadListLoading,
    threadItemsCount: Array.isArray(state.threadItems) ? state.threadItems.length : 0,
    ...detail,
  };
  threadAnimDebug.events.push(entry);
  if (threadAnimDebug.events.length > 400) threadAnimDebug.events.splice(0, threadAnimDebug.events.length - 400);
}

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
      // Unified click-through guard for all blurred backdrops.
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

const GUIDE_DISMISSED_KEY = "web_codex_guide_dismissed_v2";
const TOKEN_STORAGE_KEY = "web_codex_token_v1";
const WORKSPACE_TARGET_KEY = "web_codex_workspace_target_v1";
const START_CWD_BY_WORKSPACE_KEY = "web_codex_start_cwd_by_workspace_v1";
const FAVORITE_THREADS_KEY = "web_codex_favorite_threads_v1";
const SELECTED_MODEL_KEY = "web_codex_selected_model_v1";
const MODELS_CACHE_KEY = "web_codex_models_cache_v1";
const THREADS_CACHE_KEY = "web_codex_threads_cache_v1";
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
const THREAD_FORCE_REFRESH_MIN_INTERVAL_MS = 1800;
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

// Start windowing much earlier so medium-large threads also stay responsive and expose
// a consistent "Load older" affordance across Windows and WSL2.
const HISTORY_WINDOW_THRESHOLD = 180;

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
  el.addEventListener("pointerdown", (event) => {
    try {
      event?.preventDefault?.();
      event?.stopPropagation?.();
    } catch {}
    el.__responsiveClickSuppressUntil = Date.now() + suppressMs;
    run(event);
  }, { passive: false });
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
    loadThreadMessages(threadId, {
      animateBadge: false,
      workspace: state.activeThreadWorkspace,
      rolloutPath: state.activeThreadRolloutPath,
    }).catch(() => {});
  }, delayMs);
}

function normalizeWorkspaceTarget(value) {
  return value === "wsl2" ? "wsl2" : "windows";
}

function getWorkspaceTarget() {
  return normalizeWorkspaceTarget(state.workspaceTarget || "windows");
}

function normalizeStartCwd(value, target = "windows") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (target === "wsl2") {
    if (!text.startsWith("/")) return "";
    return text.replace(/[\\/]+$/, "") || "/";
  }
  const cleaned = text.replace(/^\\\\\?\\/, "").trim();
  if (!cleaned) return "";
  if (!/^[a-z]:[\\/]/i.test(cleaned) && !cleaned.startsWith("\\\\")) return "";
  return cleaned.replace(/[\\/]+$/, "");
}

function getStartCwdForWorkspace(target = getWorkspaceTarget()) {
  const workspace = normalizeWorkspaceTarget(target);
  return normalizeStartCwd(state.startCwdByWorkspace?.[workspace] || "", workspace);
}

function persistStartCwdByWorkspace() {
  try {
    const payload = {
      windows: normalizeStartCwd(state.startCwdByWorkspace?.windows || "", "windows"),
      wsl2: normalizeStartCwd(state.startCwdByWorkspace?.wsl2 || "", "wsl2"),
    };
    localStorage.setItem(START_CWD_BY_WORKSPACE_KEY, JSON.stringify(payload));
  } catch {}
}

function setStartCwdForWorkspace(target, value) {
  const workspace = normalizeWorkspaceTarget(target);
  state.startCwdByWorkspace[workspace] = normalizeStartCwd(value, workspace);
  persistStartCwdByWorkspace();
  applyWorkspaceUi();
}

function folderDisplayName(path, target = getWorkspaceTarget()) {
  const text = String(path || "").trim();
  if (!text) return "";
  if (target === "wsl2") {
    const normalized = text.replace(/[\\/]+$/, "") || "/";
    if (normalized === "/") return "/";
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }
  const normalized = text.replace(/[\\/]+$/, "");
  if (/^[a-z]:$/i.test(normalized)) return `${normalized}\\`;
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function getWorkspaceLabel() {
  const target = getWorkspaceTarget();
  const cwd = getStartCwdForWorkspace(target);
  if (!cwd) return "Select folder";
  return folderDisplayName(cwd, target) || cwd;
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
    : (compactModelLabel(state.selectedModel) || "Loading models...");
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
    persistModelsCache();
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
  if (state.folderPickerOpen) renderFolderPicker();
  updateHeaderUi();
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
  if (!items.length) {
    const emptySig = `${target}|${currentPath}|${parentPath}|empty|${error}`;
    if (state.folderPickerListRenderSig !== emptySig) {
      list.innerHTML = `<div class="folderPickerEmpty">No folders found.</div>`;
      list.setAttribute("data-has-content", "0");
      state.folderPickerListRenderSig = emptySig;
    }
    return;
  }
  const itemsSig = items
    .map((item) => `${String(item?.name || "").trim()}\u0001${String(item?.path || "").trim()}`)
    .join("\u0002");
  const renderSig = `${target}|${currentPath}|${parentPath}|${itemsSig}`;
  if (state.folderPickerListRenderSig === renderSig) {
    return;
  }
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
      refreshFolderPicker(nextPath).catch((e) => {
        state.folderPickerError = e?.message || "Failed to browse folders.";
        renderFolderPicker();
      });
    };
  }
}

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
    const items = ensureArrayItems(data?.items).map((item) => ({
      name: String(item?.name || "").trim(),
      path: String(item?.path || "").trim(),
    })).filter((item) => item.name && item.path);
    state.folderPickerCurrentPath = String(data?.currentPath || "").trim();
    state.folderPickerParentPath = String(data?.parentPath || "").trim();
    state.folderPickerItems = items;
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

function detectThreadWorkspaceTarget(thread) {
  const pathLikeRaw = String(
    thread?.cwd || thread?.project || thread?.directory || thread?.path || ""
  ).trim();
  const workspaceRaw = String(thread?.workspace || "").trim();
  const raw = pathLikeRaw || workspaceRaw;
  if (!raw) return "unknown";
  const text = raw.toLowerCase();
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
  const queryWorkspaceRaw = String(thread?.__workspaceQueryTarget || "").trim().toLowerCase();
  if (queryWorkspaceRaw === "wsl2" || queryWorkspaceRaw === "wsl") return "wsl2";
  if (queryWorkspaceRaw === "windows" || queryWorkspaceRaw === "win") return "windows";
  if (workspaceRaw) {
    const workspaceText = workspaceRaw.toLowerCase();
    if (workspaceText === "wsl2" || workspaceText === "wsl") return "wsl2";
    if (workspaceText === "windows" || workspaceText === "win") return "windows";
  }
  return "unknown";
}

function shouldRenderThreadForCurrentTarget(thread) {
  if (!hasDualWorkspaceTargets()) return true;
  const target = detectThreadWorkspaceTarget(thread);
  if (target === "unknown") return true;
  return target === getWorkspaceTarget();
}

function isThreadListActuallyVisible() {
  const list = byId("threadList");
  if (!list) return false;
  if (!list.isConnected) return false;
  const isActuallyOnscreen = (node) => {
    if (!node) return false;
    const styles = window.getComputedStyle(node);
    if (styles.display === "none" || styles.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0);
    const viewportHeight = Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0);
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  };
  if (!isActuallyOnscreen(list)) return false;
  const panel = list.closest(".leftPanel");
  if (panel && !isActuallyOnscreen(panel)) return false;
  return true;
}

function scheduleThreadListVisibleAnimationRender(delayMs = 0) {
  if (state.threadListVisibleAnimationTimer) {
    clearTimeout(state.threadListVisibleAnimationTimer);
    state.threadListVisibleAnimationTimer = 0;
  }
  const waitMs = Math.max(0, Number(delayMs || 0));
  state.threadListVisibleAnimationTimer = setTimeout(() => {
    state.threadListVisibleAnimationTimer = 0;
    if (!Array.isArray(state.threadItems) || !state.threadItems.length) return;
    if (!isThreadListActuallyVisible()) return;
    state.threadListAnimateNextRender = true;
    state.threadListAnimateThreadIds = new Set();
    state.threadListExpandAnimateGroupKeys = new Set();
    state.threadListSkipScrollRestoreOnce = true;
    renderThreads(state.threadItems);
  }, waitMs);
}

function scheduleThreadListDeferredRender(workspaceTarget, delayMs = 0) {
  const target = normalizeWorkspaceTarget(workspaceTarget);
  const existingTimer = Number(state.threadListDeferredRenderTimerByWorkspace?.[target] || 0);
  if (existingTimer) {
    clearTimeout(existingTimer);
    state.threadListDeferredRenderTimerByWorkspace[target] = 0;
  }
  const waitMs = Math.max(0, Number(delayMs || 0));
  state.threadListDeferredRenderTimerByWorkspace[target] = setTimeout(() => {
    state.threadListDeferredRenderTimerByWorkspace[target] = 0;
    if (getWorkspaceTarget() !== target) return;
    const latest = Array.isArray(state.threadItemsByWorkspace[target]) ? state.threadItemsByWorkspace[target] : [];
    state.threadItemsAll = latest;
    syncActiveThreadMetaFromList();
    state.threadListAnimateNextRender = false;
    state.threadListAnimateThreadIds = new Set();
    applyThreadFilter();
    updateHeaderUi();
    pushThreadAnimDebug("threadListDeferredRender:flush", {
      target,
      count: latest.length,
    });
  }, waitMs);
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
  updateWorkspaceAvailability(hasWindows, hasWsl2, { applyFilter: false });
}

function updateWorkspaceAvailability(windowsInstalled, wsl2Installed, options = {}) {
  state.workspaceAvailability = {
    windowsInstalled: !!windowsInstalled,
    wsl2Installed: !!wsl2Installed,
  };
  // Never auto-switch workspace target here.
  // Policy: default is windows; after user selection, keep that choice until user changes it.
  applyWorkspaceUi();
  if (state.threadItemsAll.length && options.applyFilter !== false) applyThreadFilter();
}

async function setWorkspaceTarget(nextTarget) {
  const target = normalizeWorkspaceTarget(nextTarget);
  if (!isWorkspaceAvailable(target)) return;
  if (state.workspaceTarget === target) return;
  const previousTarget = normalizeWorkspaceTarget(state.workspaceTarget);
  state.collapsedWorkspaceKeysByWorkspace[previousTarget] = state.collapsedWorkspaceKeys;
  state.workspaceTarget = target;
  state.collapsedWorkspaceKeys =
    state.collapsedWorkspaceKeysByWorkspace[target] instanceof Set
      ? state.collapsedWorkspaceKeysByWorkspace[target]
      : new Set();
  localStorage.setItem(WORKSPACE_TARGET_KEY, target);
  applyWorkspaceUi();
  setStatus(`Workspace target: ${target.toUpperCase()}`);
  const cached = Array.isArray(state.threadItemsByWorkspace[target])
    ? state.threadItemsByWorkspace[target]
    : [];
  const hasHydrated = !!state.threadWorkspaceHydratedByWorkspace[target];
  pushThreadAnimDebug("setWorkspaceTarget", {
    target,
    previousTarget,
    hasHydrated,
    cachedCount: cached.length,
    listActuallyVisible: isThreadListActuallyVisible(),
  });
  if (hasHydrated) {
    state.threadItemsAll = cached;
    state.threadListRenderSigByWorkspace[target] = buildThreadRenderSig(cached);
    syncActiveThreadMetaFromList();
    state.threadListLoading = false;
    state.threadListLoadingTarget = "";
    state.threadListPreferLoadingPlaceholder = false;
    // Workspace switch should feel explicit, but only consume the enter animation once the
    // thread list is actually visible. Otherwise F5 + immediate switch/open can render offscreen
    // and lose the animation before the user sees it.
    state.threadListPendingVisibleAnimationByWorkspace[target] = cached.length > 0;
    state.threadListAnimateNextRender = cached.length > 0 && isThreadListActuallyVisible();
    state.threadListAnimateThreadIds = new Set();
    applyThreadFilter();
    updateHeaderUi();
    setStatus(`Refreshing ${target.toUpperCase()} chats...`);
  } else {
    // First-time workspace: show explicit loading placeholder.
    state.threadItemsAll = [];
    state.threadItems = [];
    state.threadListLoading = true;
    state.threadListLoadingTarget = target;
    state.threadListPreferLoadingPlaceholder = true;
    state.threadListAnimateNextRender = false;
    state.threadListAnimateThreadIds = new Set();
    renderThreads([]);
    updateHeaderUi();
    setStatus(`Loading ${target.toUpperCase()} chats...`);
  }
  // Workspace switch should prefer cached/incremental refresh for responsiveness.
  // Hard force is reserved for explicit pull-to-refresh.
  refreshThreads(target, { force: false, silent: hasHydrated }).catch((e) => setStatus(e.message, true));
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
  if (isHttpUrl(text)) return false;
  if (isDottedIdentifierPath(text)) return false;
  if (/^[\\/]+$/.test(text)) return false;
  if (/^\/[^\/\s.?#]+$/.test(text)) return false;
  if (/^%[A-Za-z0-9_]+%(?:[\\/]+)?$/.test(text)) return false;
  if (/^[a-z]:(?:[\\/]+)?$/i.test(text)) return false;
  const hasPathSeparator = text.includes("/") || text.includes("\\");
  const hasUncPrefix = /^\\\\[A-Za-z0-9_.-]+[\\/]/.test(text);
  const hasAbsolutePrefix =
    /^%[A-Za-z0-9_]+%[\\/]/.test(text) ||
    /^[a-z]:[\\/]/i.test(text) ||
    text.startsWith("/") ||
    hasUncPrefix;
  const hasExplicitRelativePrefix = /^(?:\.{1,2}|~)[\\/]/.test(text);
  const hasFileLikeSuffix = /(?:^|[\\/])[^\\/\s]+\.[a-z0-9]{1,8}(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?$/i.test(text);
  if (!hasPathSeparator && !hasAbsolutePrefix) return false;
  if (!hasAbsolutePrefix && !hasExplicitRelativePrefix && !hasFileLikeSuffix) return false;
  return hasAbsolutePrefix || hasExplicitRelativePrefix || hasFileLikeSuffix;
}

function normalizeCodeSpanContent(value) {
  const raw = String(value || "").replace(/\r?\n/g, " ");
  if (raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ") && /[^\s]/.test(raw)) {
    return raw.slice(1, -1);
  }
  return raw;
}

function isMarkdownEscapedAt(source, index) {
  const text = String(source || "");
  let slashCount = 0;
  for (let i = Number(index || 0) - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findNextInlineCodeSpan(source, fromIndex = 0) {
  const text = String(source || "");
  for (let start = Math.max(0, Number(fromIndex) || 0); start < text.length; start += 1) {
    if (text[start] !== "`") continue;
    if (isMarkdownEscapedAt(text, start)) continue;
    let fenceLen = 1;
    while (text[start + fenceLen] === "`") fenceLen += 1;
    for (let cursor = start + fenceLen; cursor < text.length; cursor += 1) {
      if (text[cursor] !== "`") continue;
      if (isMarkdownEscapedAt(text, cursor)) continue;
      let closeLen = 1;
      while (text[cursor + closeLen] === "`") closeLen += 1;
      if (closeLen === fenceLen) {
        return {
          start,
          end: cursor + closeLen,
          fenceLen,
          content: text.slice(start + fenceLen, cursor),
        };
      }
      cursor += closeLen - 1;
    }
    start += fenceLen - 1;
  }
  return null;
}

function unescapeMarkdownText(value) {
  return String(value || "").replace(/\\([\\!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
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

function renderInlineCodeSpan(content, fenceLen = 1) {
  const normalized = normalizeCodeSpanContent(content);
  if (Number(fenceLen || 0) === 1 && looksLikeFileRef(normalized)) {
    return buildMessageLink(normalized, normalized, true);
  }
  return `<code class="msgInlineCode">${escapeHtml(normalized)}</code>`;
}

const INLINE_MESSAGE_PLAIN_TOKEN_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>()]+)|((?:(?:(?:%[A-Za-z0-9_]+%|[A-Za-z]:|\\\\[^\\\s]+|\/)?[\\/])?(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?)/g;

function renderPlainInlineToken(match) {
  if (match[1] && match[2]) {
    const href = String(match[2] || "").trim();
    return buildMessageLink(match[1], href, looksLikeFileRef(href) || looksLikeFileRef(match[1]));
  }
  if (match[3]) {
    return `<strong>${escapeHtml(match[3])}</strong>`;
  }
  if (match[4]) {
    return buildMessageLink(match[4], match[4], false);
  }
  if (match[5]) {
    const candidate = String(match[5] || "").trim();
    return looksLikeFileRef(candidate)
      ? buildMessageLink(candidate, candidate, true)
      : escapeHtml(candidate);
  }
  return escapeHtml(String(match[0] || ""));
}

function renderPlainTextSegment(text) {
  const source = String(text || "");
  let cursor = 0;
  let html = "";
  for (const match of source.matchAll(INLINE_MESSAGE_PLAIN_TOKEN_PATTERN)) {
    const full = String(match[0] || "");
    const index = match.index || 0;
    if (index > cursor) html += escapeHtml(unescapeMarkdownText(source.slice(cursor, index)));
    html += renderPlainInlineToken(match);
    cursor = index + full.length;
  }
  if (cursor < source.length) html += escapeHtml(unescapeMarkdownText(source.slice(cursor)));
  return html;
}

function renderInlineMessageText(text) {
  const source = String(text || "");
  let cursor = 0;
  let html = "";
  while (cursor < source.length) {
    const span = findNextInlineCodeSpan(source, cursor);
    if (!span) {
      html += renderPlainTextSegment(source.slice(cursor));
      break;
    }
    if (span.start > cursor) {
      html += renderPlainTextSegment(source.slice(cursor, span.start));
    }
    html += renderInlineCodeSpan(span.content, span.fenceLen);
    cursor = span.end;
  }
  return html;
}

function renderMessageRichHtml(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  if (!source.trim()) return "";
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
  const lines = source.split("\n");
  let paragraphLines = [];
  let listLines = [];
  let codeLines = [];
  let inCodeBlock = false;
  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    html += `<p>${paragraphLines.map((line) => renderInlineMessageText(line)).join("<br>")}</p>`;
    paragraphLines = [];
  };
  const flushList = () => {
    if (!listLines.length) return;
    html += renderListBlock(listLines);
    listLines = [];
  };
  const flushCode = () => {
    const code = codeLines.join("\n").replace(/\n$/, "");
    html += `<pre class="msgCodeBlock"><code>${escapeHtml(code)}</code></pre>`;
    codeLines = [];
  };
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    const trimmedStart = String(line || "").trimStart();
    const isFenceLine = trimmedStart.startsWith("```");
    if (inCodeBlock) {
      if (isFenceLine) {
        flushCode();
        inCodeBlock = false;
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (isFenceLine) {
      flushParagraph();
      flushList();
      inCodeBlock = true;
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (isListLine(line)) {
      flushParagraph();
      listLines.push(line);
      continue;
    }
    flushList();
    paragraphLines.push(line);
  }
  if (inCodeBlock) flushCode();
  flushParagraph();
  flushList();
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
  wireBlurBackdropShield(backdrop, { onClose: close, modalSelector: ".imageViewer", suppressMs: 420 });
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

  const removeBrokenAttachment = (img) => {
    const card = img?.closest(".msgAttachmentCard");
    if (!card) return;
    const wrap = card.closest(".msgAttachments");
    const msg = card.closest(".msg");
    card.remove();
    if (wrap && !wrap.querySelector(".msgAttachmentCard")) {
      wrap.remove();
      if (msg) {
        msg.classList.remove("withAttachments");
        const body = msg.querySelector(".msgBody");
        if (body && !String(body.textContent || "").trim()) msg.remove();
      }
    }
  };

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
    img.addEventListener("error", () => {
      removeBrokenAttachment(img);
      onSettled();
    }, { once: true });
    if (img.complete && !(img.naturalWidth > 0)) {
      removeBrokenAttachment(img);
      onSettled();
    }
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

function attachMessageDebugMeta(node, payload = {}) {
  if (!node) return node;
  try {
    node.__webCodexRole = String(payload.role || "").trim();
    node.__webCodexKind = String(payload.kind || "").trim();
    node.__webCodexRawText = typeof payload.text === "string" ? payload.text : String(payload.text || "");
    node.__webCodexSource = String(payload.source || "").trim();
  } catch {}
  return node;
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
  attachMessageDebugMeta(node, { role, kind, text, source: "addChat" });
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
  attachMessageDebugMeta(msg, { role: "assistant", kind: "", text: "", source: "streaming" });
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
  attachMessageDebugMeta(msgNode, { role: "assistant", kind: "", text: finalText, source: "finalizeAssistantMessage" });
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

function compactTokenUsageCount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const units = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const scaled = n / size;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
      const rounded = Number(scaled.toFixed(digits));
      return `${rounded % 1 === 0 ? String(Math.trunc(rounded)) : rounded.toFixed(1)}${suffix}`;
    }
  }
  return String(Math.round(n));
}

function normalizeThreadTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const readStats = (value) => {
    if (!value || typeof value !== "object") return null;
    const totalTokens = readNumber(value.totalTokens ?? value.total_tokens);
    const inputTokens = readNumber(value.inputTokens ?? value.input_tokens);
    const cachedInputTokens = readNumber(value.cachedInputTokens ?? value.cached_input_tokens);
    const outputTokens = readNumber(value.outputTokens ?? value.output_tokens);
    const reasoningOutputTokens = readNumber(value.reasoningOutputTokens ?? value.reasoning_output_tokens);
    if (
      totalTokens === null &&
      inputTokens === null &&
      cachedInputTokens === null &&
      outputTokens === null &&
      reasoningOutputTokens === null
    ) {
      return null;
    }
    return {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    };
  };
  const total = readStats(usage.total ?? usage.total_token_usage);
  const last = readStats(usage.last ?? usage.last_token_usage);
  const modelContextWindow = readNumber(usage.modelContextWindow ?? usage.model_context_window);
  if (!total && !last && modelContextWindow === null) return null;
  return { total, last, modelContextWindow };
}

function formatContextLeftDisplay(tokenUsage) {
  const usage = normalizeThreadTokenUsage(tokenUsage);
  const totalTokens = readNumber(usage?.total?.totalTokens);
  const lastTokens = readNumber(usage?.last?.totalTokens);
  const modelContextWindow = readNumber(usage?.modelContextWindow);
  if (modelContextWindow !== null && modelContextWindow > CONTEXT_LEFT_BASELINE_TOKENS && lastTokens !== null) {
    const effectiveWindow = modelContextWindow - CONTEXT_LEFT_BASELINE_TOKENS;
    const used = Math.max(0, lastTokens - CONTEXT_LEFT_BASELINE_TOKENS);
    const remaining = Math.max(0, effectiveWindow - used);
    const percentLeft = clamp(Math.round((remaining / effectiveWindow) * 100), 0, 100);
    return {
      kind: "percent",
      value: percentLeft,
      suffix: "% context left",
      text: `${percentLeft}% context left`,
    };
  }
  if (totalTokens !== null && totalTokens >= 0) {
    return {
      kind: "text",
      value: null,
      suffix: "",
      text: `${compactTokenUsageCount(totalTokens)} used`,
    };
  }
  return {
    kind: "percent",
    value: 100,
    suffix: "% context left",
    text: "100% context left",
  };
}

function contextLeftPercentDigits(value) {
  const text = String(Math.max(0, Math.min(100, Number(value || 0) | 0))).padStart(3, " ");
  return text.split("").map((ch) => (ch === " " ? " " : ch));
}

function createContextLeftDigitSlot(char, className = "mobileContextLeftDigitCurrent") {
  const slot = document.createElement("span");
  slot.className = "mobileContextLeftDigitSlot";
  const inner = document.createElement("span");
  inner.className = className;
  inner.textContent = char;
  slot.appendChild(inner);
  return slot;
}

function createStaticContextLeftPercentMarkup(value, suffix) {
  const viewport = document.createElement("span");
  viewport.className = "mobileContextLeftNumberViewport";
  for (const char of contextLeftPercentDigits(value)) {
    viewport.appendChild(createContextLeftDigitSlot(char));
  }
  const suffixNode = document.createElement("span");
  suffixNode.className = "mobileContextLeftSuffix";
  suffixNode.textContent = suffix;
  const frag = document.createDocumentFragment();
  frag.appendChild(viewport);
  frag.appendChild(suffixNode);
  return frag;
}

function renderStaticComposerContextLeft(node, display) {
  node.__contextLeftRenderSeq = (Number(node.__contextLeftRenderSeq || 0) + 1) | 0;
  if (display.kind === "percent") {
    node.replaceChildren(createStaticContextLeftPercentMarkup(display.value, display.suffix));
  } else {
    node.textContent = display.text;
  }
  node.setAttribute("aria-label", display.text);
  node.dataset.contextKind = display.kind;
  node.dataset.contextText = display.text;
  node.dataset.contextValue = display.value === null ? "" : String(display.value);
}

function renderAnimatedComposerContextLeftPercent(node, nextDisplay, prevValue) {
  const viewport = node.querySelector(".mobileContextLeftNumberViewport");
  if (!viewport) {
    renderStaticComposerContextLeft(node, nextDisplay);
    return;
  }
  const renderSeq = (Number(node.__contextLeftRenderSeq || 0) + 1) | 0;
  node.__contextLeftRenderSeq = renderSeq;
  node.setAttribute("aria-label", nextDisplay.text);
  node.dataset.contextKind = "percent";
  node.dataset.contextText = nextDisplay.text;
  node.dataset.contextValue = String(nextDisplay.value);
  const prevDigits = contextLeftPercentDigits(prevValue);
  const nextDigits = contextLeftPercentDigits(nextDisplay.value);
  if (typeof viewport.animate !== "function") {
    viewport.replaceChildren(...nextDigits.map((char) => createContextLeftDigitSlot(char)));
    return;
  }
  try {
    const animations = [];
    if (typeof viewport.getAnimations === "function") animations.push(...viewport.getAnimations());
    const activeDigits = viewport.querySelectorAll(".mobileContextLeftDigit");
    for (const digit of activeDigits) {
      if (typeof digit.getAnimations === "function") animations.push(...digit.getAnimations());
    }
    for (const animation of animations) animation.cancel();
  } catch {}
  const direction = nextDisplay.value >= prevValue ? 1 : -1;
  const travel = `${CONTEXT_LEFT_DIGIT_TRAVEL_PERCENT}%`;
  const incomingFrom = direction > 0 ? travel : `-${travel}`;
  const outgoingTo = direction > 0 ? `-${travel}` : travel;
  const slotNodes = [];
  const animationPromises = [];
  for (let i = 0; i < nextDigits.length; i += 1) {
    const prevChar = prevDigits[i];
    const nextChar = nextDigits[i];
    const slot = document.createElement("span");
    slot.className = "mobileContextLeftDigitSlot";
    const delay = (nextDigits.length - 1 - i) * CONTEXT_LEFT_DIGIT_STAGGER_MS;
    if (prevChar === nextChar) {
      const current = document.createElement("span");
      current.className = "mobileContextLeftDigitCurrent";
      current.textContent = nextChar;
      slot.appendChild(current);
      slotNodes.push(slot);
      continue;
    }
    const outgoing = document.createElement("span");
    outgoing.className = "mobileContextLeftDigit";
    outgoing.textContent = prevChar;
    outgoing.style.transform = "translateY(0%)";
    outgoing.style.opacity = "1";
    const incoming = document.createElement("span");
    incoming.className = "mobileContextLeftDigit";
    incoming.textContent = nextChar;
    incoming.style.transform = `translateY(${incomingFrom})`;
    incoming.style.opacity = "0.24";
    slot.append(outgoing, incoming);
    slotNodes.push(slot);
    outgoing.animate(
      [
        { transform: "translateY(0%)", opacity: 1 },
        { transform: `translateY(${outgoingTo})`, opacity: 0.24 },
      ],
      {
        duration: CONTEXT_LEFT_DIGIT_ANIMATION_MS,
        delay,
        easing: CONTEXT_LEFT_DIGIT_EASING,
        fill: "both",
      }
    );
    const incomingAnimation = incoming.animate(
      [
        { transform: `translateY(${incomingFrom})`, opacity: 0.24 },
        { transform: "translateY(0%)", opacity: 1 },
      ],
      {
        duration: CONTEXT_LEFT_DIGIT_ANIMATION_MS,
        delay,
        easing: CONTEXT_LEFT_DIGIT_EASING,
        fill: "both",
      }
    );
    if (incomingAnimation && typeof incomingAnimation.finished?.then === "function") {
      animationPromises.push(incomingAnimation.finished.catch(() => null));
    }
  }
  viewport.replaceChildren(...slotNodes);
  const finalize = () => {
    if (!viewport.isConnected) return;
    if (Number(node.__contextLeftRenderSeq || 0) != renderSeq) return;
    viewport.replaceChildren(...nextDigits.map((char) => createContextLeftDigitSlot(char)));
  };
  if (animationPromises.length) {
    Promise.allSettled(animationPromises).then(finalize);
  } else {
    finalize();
  }
}

function renderComposerContextLeft() {
  const node = byId("mobileContextLeft");
  if (!node) return;
  const display = formatContextLeftDisplay(state.activeThreadTokenUsage);
  const prevKind = String(node.dataset.contextKind || "");
  const prevText = String(node.dataset.contextText || node.textContent || "").trim();
  const prevValue = readNumber(node.dataset.contextValue);
  if (prevText === display.text && prevKind === display.kind) {
    if (!prevText) renderStaticComposerContextLeft(node, display);
    return;
  }
  if (display.kind !== "percent") {
    renderStaticComposerContextLeft(node, display);
    return;
  }
  if (prevKind !== "percent" || prevValue === null) {
    renderStaticComposerContextLeft(node, display);
    return;
  }
  renderAnimatedComposerContextLeftPercent(node, display, prevValue);
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
  state.activeThreadHistoryTurns = [];
  state.activeThreadHistoryThreadId = "";
  state.activeThreadHistoryHasMore = false;
  state.activeThreadHistoryIncomplete = false;
  state.activeThreadHistoryBeforeCursor = "";
  state.activeThreadHistoryTotalTurns = 0;
  state.activeThreadHistoryReqSeq = 0;
  state.activeThreadHistoryInFlightPromise = null;
  state.activeThreadHistoryInFlightThreadId = "";
  state.activeThreadHistoryPendingRefresh = null;
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

function persistModelsCache() {
  try {
    const items = Array.isArray(state.modelOptions) ? state.modelOptions : [];
    localStorage.setItem(
      MODELS_CACHE_KEY,
      JSON.stringify({
        items,
        updatedAt: Date.now(),
      })
    );
  } catch {}
}

function restoreModelsCache() {
  try {
    const raw = String(localStorage.getItem(MODELS_CACHE_KEY) || "").trim();
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const items = ensureArrayItems(parsed?.items).map(normalizeModelOption).filter(Boolean);
    if (!items.length) return false;
    state.modelOptions = items;
    if (!String(state.selectedModel || "").trim()) {
      state.selectedModel =
        pickLatestModelId(items) ||
        items.find((x) => x && x.isDefault)?.id ||
        items[0]?.id ||
        "";
    }
    const active = items.find((x) => x && x.id === state.selectedModel) || items[0] || null;
    const supported = Array.isArray(active?.supportedReasoningEfforts) ? active.supportedReasoningEfforts : [];
    const persisted = String(localStorage.getItem(REASONING_EFFORT_KEY) || "").trim();
    if (supported.length) {
      const ok = persisted && supported.some((x) => x && x.effort === persisted);
      const hasMedium = supported.some((x) => String(x?.effort || "").trim() === "medium");
      state.selectedReasoningEffort = ok
        ? persisted
        : (hasMedium ? "medium" : String(active?.defaultReasoningEffort || supported[0]?.effort || "").trim());
    }
    return true;
  } catch {
    return false;
  }
}

function persistThreadsCache() {
  try {
    localStorage.setItem(
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
    const raw = String(localStorage.getItem(THREADS_CACHE_KEY) || "").trim();
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
    // Cache hydration should use the same visible-list animation policy as later workspace hydration:
    // animate immediately when the list is already onscreen, otherwise keep one pending enter animation
    // for the first time the user actually sees the list after refresh/startup.
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
        }
        continue;
      }
      const text = normalizeThreadItemText(item);
      if (text) {
        if (type === "agentMessage" || type === "assistantMessage") {
          messages.push({ role: "assistant", text, kind: "" });
        }
        continue;
      }
    }
  }
  return messages;
}

function normalizeSessionAssistantText(content) {
  const parts = Array.isArray(content) ? content : [];
  const lines = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const partType = normalizeType(part.type);
    if (partType !== "outputtext" && partType !== "inputtext") continue;
    const text = stripCodexImageBlocks(String(part.text || "")).trim();
    if (text) lines.push(text);
  }
  return lines.join("\n").trim();
}

async function mapSessionHistoryMessages(items) {
  const historyItems = Array.isArray(items) ? items : [];
  const messages = [];
  let lastYieldMs = performance.now();
  const yieldBudgetMs = 7.5;
  if (historyItems.length >= 40) await nextFrame();

  for (let index = 0; index < historyItems.length; index += 1) {
    if (historyItems.length >= 40 && performance.now() - lastYieldMs >= yieldBudgetMs) {
      lastYieldMs = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await nextFrame();
    }
    const item = historyItems[index];
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "").trim();
    if (type === "message") {
      const role = String(item.role || "").trim();
      if (role === "user") {
        const parsed = parseUserMessageParts({ content: item.content });
        const text = parsed.text;
        if (text && isBootstrapAgentsPrompt(text)) continue;
        if (text || parsed.images.length) {
          messages.push({ role: "user", text, kind: "", images: parsed.images });
        }
        continue;
      }
      if (role === "assistant") {
        const text = normalizeSessionAssistantText(item.content);
        if (text) messages.push({ role: "assistant", text, kind: "" });
        continue;
      }
      continue;
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
  const historyItems = Array.isArray(thread?.historyItems) ? thread.historyItems : [];
  const messages = historyItems.length
    ? await mapSessionHistoryMessages(historyItems)
    : await mapThreadReadMessages(thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  state.activeThreadTokenUsage = normalizeThreadTokenUsage(thread?.tokenUsage);
  renderComposerContextLeft();
  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const renderSig = [
    String(thread?.id || state.activeThreadId || ""),
    String(turns.length),
    String(messages.length),
    String(lastMsg?.role || ""),
    String(lastMsg?.text || ""),
  ].join("::");
  const threadId = String(thread?.id || state.activeThreadId || "");
  state.activeThreadStarted = messages.length > 0 || turns.length > 0 || historyItems.length > 0;
  // Model selection is global (header picker), not per-thread.
  const detectedTarget = detectThreadWorkspaceTarget(thread);
  const target = detectedTarget !== "unknown"
    ? detectedTarget
    : ((options.workspace === "windows" || options.workspace === "wsl2") ? options.workspace : "unknown");
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
        if (start > 0 || state.activeThreadHistoryHasMore) ensureLoadOlderControl(box2);
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

function buildThreadHistoryUrl(threadId, options = {}) {
  const params = new URLSearchParams();
  const workspace = options.workspace || state.activeThreadWorkspace || "";
  const before = String(options.before || "").trim();
  const limit = Number(options.limit || 0) || 0;
  if (workspace === "windows" || workspace === "wsl2") params.set("workspace", workspace);
  if (before) params.set("before", before);
  if (limit > 0) params.set("limit", String(limit));
  const query = params.toString();
  return `/codex/threads/${encodeURIComponent(threadId)}/history${query ? `?${query}` : ""}`;
}

function mergeHistoryTurns(existingTurns, incomingTurns) {
  const merged = [];
  const seen = new Set();
  const pushTurn = (turn) => {
    if (!turn || typeof turn !== "object") return;
    const id = String(turn.id || "").trim();
    const key = id || JSON.stringify(turn);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(turn);
  };
  for (const turn of Array.isArray(existingTurns) ? existingTurns : []) pushTurn(turn);
  for (const turn of Array.isArray(incomingTurns) ? incomingTurns : []) pushTurn(turn);
  return merged;
}

function queuePendingActiveThreadHistoryRefresh(threadId, options = {}) {
  if (!threadId) return;
  const previous = state.activeThreadHistoryPendingRefresh;
  const next = {
    threadId,
    animateBadge: !!(previous?.animateBadge || options.animateBadge),
    forceRender: !!(previous?.forceRender || options.forceRender),
    forceHistoryWindow: !!(previous?.forceHistoryWindow || options.forceHistoryWindow),
    workspace: String(options.workspace || previous?.workspace || state.activeThreadWorkspace || "").trim(),
    rolloutPath: String(options.rolloutPath || previous?.rolloutPath || state.activeThreadRolloutPath || "").trim(),
  };
  const limit = Number(options.limit || previous?.limit || 0) || 0;
  if (limit > 0) next.limit = limit;
  state.activeThreadHistoryPendingRefresh = next;
}

async function loadThreadMessages(threadId, options = {}) {
  if (!threadId) return;
  // Keep one canonical in-flight history load per active thread. Follow-up refresh requests for the
  // same thread are merged into a single pending refresh so the opening render cannot be invalidated
  // mid-flight and leave an empty chat surface behind.
  if (
    state.activeThreadHistoryInFlightPromise &&
    state.activeThreadHistoryInFlightThreadId === threadId
  ) {
    queuePendingActiveThreadHistoryRefresh(threadId, options);
    return state.activeThreadHistoryInFlightPromise;
  }
  const reqSeq = (Number(state.activeThreadHistoryReqSeq || 0) + 1) | 0;
  state.activeThreadHistoryReqSeq = reqSeq;
  // Any explicit history fetch should satisfy the live-poll interval so the timer loop doesn't
  // immediately re-fetch right after open/refresh actions.
  state.activeThreadLiveLastPollMs = Date.now();
  const loadPromise = (async () => {
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
      const limit = Number(options.limit || state.historyWindowSize || 160) || 160;
      const history = await api(buildThreadHistoryUrl(threadId, {
        workspace: options.workspace,
        rolloutPath: options.rolloutPath,
        limit,
      }), {
        signal: options.signal,
      });
      if (reqSeq !== state.activeThreadHistoryReqSeq) return;
      if (state.activeThreadId && state.activeThreadId !== threadId) return;
      const page = history?.page || {};
      const incomingThread = history?.thread || null;
      const incomingTurns = Array.isArray(incomingThread?.turns) ? incomingThread.turns : [];
      const shouldReplaceTurns = !!page?.incomplete || !!state.activeThreadHistoryIncomplete;
      const mergedTurns = shouldReplaceTurns
        ? incomingTurns
        : mergeHistoryTurns(
            state.activeThreadHistoryThreadId === threadId ? state.activeThreadHistoryTurns : [],
            incomingTurns
          );
      state.activeThreadHistoryTurns = mergedTurns;
      state.activeThreadHistoryThreadId = threadId;
      state.activeThreadHistoryHasMore = !!page?.hasMore;
      state.activeThreadHistoryIncomplete = !!page?.incomplete;
      state.activeThreadHistoryBeforeCursor = String(page?.beforeCursor || "").trim();
      state.activeThreadHistoryTotalTurns = Number(page?.totalTurns || incomingTurns.length || 0) || incomingTurns.length || 0;
      const thread = incomingThread ? {
        ...incomingThread,
        turns: mergedTurns,
        page,
      } : null;
      if (thread) {
        try { window.__webCodexE2E_lastHistorySource = "history"; } catch {}
        await applyThreadToChat(thread, { ...options, forceHistoryWindow: !!page?.hasMore });
        return;
      }
    } catch (error) {
      throw error;
    }
  })();
  state.activeThreadHistoryInFlightPromise = loadPromise;
  state.activeThreadHistoryInFlightThreadId = threadId;
  try {
    return await loadPromise;
  } finally {
    if (state.activeThreadHistoryInFlightPromise === loadPromise) {
      state.activeThreadHistoryInFlightPromise = null;
      state.activeThreadHistoryInFlightThreadId = "";
      const pending = state.activeThreadHistoryPendingRefresh;
      if (pending && pending.threadId === threadId) {
        state.activeThreadHistoryPendingRefresh = null;
        setTimeout(() => {
          if (state.activeThreadId !== threadId) return;
          loadThreadMessages(threadId, pending).catch(() => {});
        }, 0);
      }
    }
  }
}

function ensureArrayItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return value ? [value] : [];
}

function buildThreadRenderSig(items) {
  return sortThreadsByNewest(ensureArrayItems(items).slice())
    .map((item) => {
      const id = item?.id || item?.threadId || "";
      const ts = item?.updatedAt ?? item?.createdAt ?? "";
      const status = String(item?.status?.type || item?.status || item?.state || "").trim();
      const preview = String(item?.preview || item?.title || item?.name || "").trim();
      return `${id}:${ts}:${status}:${preview}`;
    })
    .join("|");
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
  attachMessageDebugMeta(node, { role: msg.role, kind, text: msg.text, source: "buildMsgNode" });
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
  const loadedTurns = Array.isArray(state.activeThreadHistoryTurns) ? state.activeThreadHistoryTurns.length : 0;
  const serverRemaining = Math.max(0, Number(state.activeThreadHistoryTotalTurns || 0) - loadedTurns);
  if (!remaining && !state.activeThreadHistoryHasMore) {
    if (wrap) wrap.remove();
    return;
  }
  ensureLoadOlderControl(box);
  const btn = byId("loadOlderBtn");
  if (btn) {
    btn.disabled = !!state.historyWindowLoading;
    const count = remaining || serverRemaining;
    btn.textContent = state.historyWindowLoading ? "Loading..." : (count > 0 ? `Load older (${count})` : "Load older");
  }
}

function shouldUseHistoryWindow(messages, options = {}) {
  if (!Array.isArray(messages)) return false;
  if (options.forceHistoryWindow || state.activeThreadHistoryHasMore) return true;
  if (messages.length < HISTORY_WINDOW_THRESHOLD) return false;
  // For huge threads, keep windowing enabled across refreshes; otherwise a single new message can
  // accidentally trigger a full-history render (loading everything) and "lose" the Load older affordance.
  return true;
}

async function loadOlderHistoryChunk() {
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
    if (state.activeThreadHistoryHasMore && state.activeThreadId) {
      try {
        const page = await api(buildThreadHistoryUrl(state.activeThreadId, {
          workspace: state.activeThreadWorkspace,
          rolloutPath: state.activeThreadRolloutPath,
          before: state.activeThreadHistoryBeforeCursor,
          limit: Math.max(1, Number(state.historyWindowChunk || 0)),
        }));
        const pageMeta = page?.page || {};
        const olderTurns = Array.isArray(page?.thread?.turns) ? page.thread.turns : [];
          const mergedTurns = mergeHistoryTurns(olderTurns, state.activeThreadHistoryTurns);
          state.activeThreadHistoryTurns = mergedTurns;
          state.activeThreadHistoryThreadId = state.activeThreadId;
          state.activeThreadHistoryHasMore = !!pageMeta?.hasMore;
          state.activeThreadHistoryIncomplete = !!pageMeta?.incomplete;
          state.activeThreadHistoryBeforeCursor = String(pageMeta?.beforeCursor || "").trim();
        state.activeThreadHistoryTotalTurns = Number(pageMeta?.totalTurns || mergedTurns.length || 0) || mergedTurns.length || 0;
        await applyThreadToChat({
          ...(page?.thread || {}),
          id: state.activeThreadId,
          workspace: state.activeThreadWorkspace,
          rolloutPath: state.activeThreadRolloutPath,
          turns: mergedTurns,
          page: pageMeta,
        }, {
          forceRender: true,
          workspace: state.activeThreadWorkspace,
          rolloutPath: state.activeThreadRolloutPath,
          forceHistoryWindow: !!state.activeThreadHistoryHasMore,
        });
      } finally {
        state.historyWindowLoading = false;
        updateLoadOlderControl();
      }
      return;
    }
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
  if (!text) return "Default folder";
  const normalized = text
    .replace(/^\\\\\?\\/, "")
    .replace(/^\\\\\?\\UNC\\/, "\\\\")
    .replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last || "Default folder";
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
  if (!list) return;
  const sourceItems = Array.isArray(items) ? items : [];
  const currentWorkspaceKey = normalizeWorkspaceTarget(getWorkspaceTarget());
  const pendingVisibleAnimation =
    !!state.threadListPendingVisibleAnimationByWorkspace?.[currentWorkspaceKey];
  const listActuallyVisible = isThreadListActuallyVisible();
  const openWindowActive =
    document.body.classList.contains("drawer-left-open") &&
    sourceItems.length > 0 &&
    Date.now() < Math.max(0, Number(state.threadListVisibleOpenAnimationUntil || 0));
  const animateEnter =
    !!state.threadListAnimateNextRender ||
    openWindowActive ||
    (pendingVisibleAnimation && listActuallyVisible && sourceItems.length > 0);
  if (openWindowActive && animateEnter) {
    // The sidebar-open enter animation is a one-shot transition. Once a non-empty render consumes it,
    // subsequent refresh renders during the same 520ms window must not replay it.
    state.threadListVisibleOpenAnimationUntil = 0;
  }
  if (animateEnter && sourceItems.length > 0 && document.body.classList.contains("drawer-left-open")) {
    state.threadListAnimationHoldUntilByWorkspace[currentWorkspaceKey] = Date.now() + 420;
  }
  pushThreadAnimDebug("renderThreads", {
    sourceCount: sourceItems.length,
    pendingVisibleAnimation,
    listActuallyVisible,
    animateEnter,
    animateNextRender: !!state.threadListAnimateNextRender,
    holdUntilMs: Math.max(0, Number(state.threadListAnimationHoldUntilByWorkspace[currentWorkspaceKey] || 0)) - Date.now(),
    visibleOpenUntilMs: Math.max(0, Number(state.threadListVisibleOpenAnimationUntil || 0)) - Date.now(),
  });
  const animateThreadIds =
    state.threadListAnimateThreadIds instanceof Set ? state.threadListAnimateThreadIds : new Set();
  const expandAnimateGroupKeys =
    state.threadListExpandAnimateGroupKeys instanceof Set ? state.threadListExpandAnimateGroupKeys : new Set();
  const collapseAnimateGroupKeys =
    state.threadListCollapseAnimateGroupKeys instanceof Set ? state.threadListCollapseAnimateGroupKeys : new Set();
  const chevronOpenAnimateKeys =
    state.threadListChevronOpenAnimateKeys instanceof Set ? state.threadListChevronOpenAnimateKeys : new Set();
  const chevronCloseAnimateKeys =
    state.threadListChevronCloseAnimateKeys instanceof Set ? state.threadListChevronCloseAnimateKeys : new Set();
  const animateExpandBody = (body) => {
    if (!body) return;
    const computed = window.getComputedStyle(body);
    const targetPaddingTop = computed.paddingTop || "0px";
    const targetPaddingBottom = computed.paddingBottom || "0px";
    const expandedHeight = Math.max(0, body.getBoundingClientRect().height);
    if (expandedHeight <= 0) return;
    body.classList.add("is-expanding");
    body.style.height = "0px";
    body.style.opacity = "0";
    body.style.paddingTop = "0px";
    body.style.paddingBottom = "0px";
    body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      body.style.height = `${expandedHeight}px`;
      body.style.opacity = "1";
      body.style.paddingTop = targetPaddingTop;
      body.style.paddingBottom = targetPaddingBottom;
    });
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      body.classList.remove("is-expanding");
      body.style.height = "";
      body.style.opacity = "";
      body.style.paddingTop = "";
      body.style.paddingBottom = "";
      body.style.overflow = "";
    };
    body.addEventListener("transitionend", (event) => {
      if (event?.propertyName !== "height") return;
      cleanup();
    }, { once: true });
    setTimeout(cleanup, 260);
  };
  const animateCollapseBody = (body, onDone) => {
    if (!body) {
      onDone?.();
      return;
    }
    if (body.classList.contains("is-collapsing")) return;
    const startHeight = Math.max(0, body.getBoundingClientRect().height);
    if (startHeight <= 0) {
      onDone?.();
      return;
    }
    body.classList.add("is-collapsing");
    body.style.height = `${startHeight}px`;
    body.style.opacity = "1";
    body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      body.style.height = "0px";
      body.style.opacity = "0";
      body.style.paddingTop = "0px";
      body.style.paddingBottom = "0px";
    });
    let done = false;
    const finalize = () => {
      if (done) return;
      done = true;
      onDone?.();
    };
    body.addEventListener("transitionend", (event) => {
      if (event?.propertyName !== "height") return;
      finalize();
    }, { once: true });
    setTimeout(finalize, 260);
  };

  const startExclusiveGroupSwitch = (nextGroupKey, currentGroupKey, allGroupKeys) => {
    const nextKey = String(nextGroupKey || "");
    const currentKey = String(currentGroupKey || "");
    for (const key of allGroupKeys) state.collapsedWorkspaceKeys.add(key);
    if (nextKey) state.collapsedWorkspaceKeys.delete(nextKey);
    state.threadListAnimateNextRender = false;
    state.threadListAnimateThreadIds = new Set();
    state.threadListExpandAnimateGroupKeys = nextKey ? new Set([nextKey]) : new Set();
    state.threadListCollapseAnimateGroupKeys =
      currentKey && currentKey !== nextKey ? new Set([currentKey]) : new Set();
    state.threadListChevronOpenAnimateKeys = nextKey ? new Set([nextKey]) : new Set();
    state.threadListChevronCloseAnimateKeys =
      currentKey && currentKey !== nextKey ? new Set([currentKey]) : new Set();
    state.threadListSkipScrollRestoreOnce = true;
    renderThreads(state.threadItems);
  };
  let threadEnterIndex = 0;
  let groupEnterIndex = 0;
  const nextThreadEnterDelayMs = () => Math.min(420, threadEnterIndex++ * 28);
  const nextGroupEnterDelayMs = () => Math.min(640, groupEnterIndex++ * 120);
  const animateStateTextSwap = (node, nextLabel) => {
    if (!node) return;
    const text = String(nextLabel || "");
    if (node.textContent === text) return;
    node.textContent = text;
    node.classList.remove("is-text-swap");
    void node.offsetWidth;
    node.classList.add("is-text-swap");
  };
  const renderThreadListState = (label, mode = "plain") => {
    const text = String(label || "");
    if (mode === "spinner") {
      const current = list.firstElementChild;
      if (current && current.classList?.contains("threadListState") && current.getAttribute("data-state-mode") === "spinner") {
        const textNode = current.querySelector(".threadListStateText");
        animateStateTextSwap(textNode, text);
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "threadListState";
      wrap.setAttribute("data-state-mode", "spinner");
      wrap.innerHTML =
        `<span class="threadListStateSpinner" aria-hidden="true"></span>` +
        `<span class="threadListStateText is-text-swap">${escapeHtml(text)}</span>`;
      list.innerHTML = "";
      list.appendChild(wrap);
      return;
    }
    const current = list.firstElementChild;
    if (current && current.classList?.contains("threadListPlainState") && current.getAttribute("data-state-mode") === "plain") {
      animateStateTextSwap(current, text);
      return;
    }
    const plain = document.createElement("div");
    plain.className = "muted threadListPlainState is-text-swap";
    plain.setAttribute("data-state-mode", "plain");
    plain.textContent = text;
    list.innerHTML = "";
    list.appendChild(plain);
  };
  const skipScrollRestore = !!state.threadListSkipScrollRestoreOnce;
  state.threadListSkipScrollRestoreOnce = false;
  const prevListScrollTop = list?.scrollTop ?? 0;
  const shouldRestoreListScroll = !skipScrollRestore && prevListScrollTop > 0;
  const prevGroupScroll = new Map();
  const pendingScrollRestores = [];
  if (!skipScrollRestore) {
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
  }
  const query = state.threadSearchQuery.trim().toLowerCase();
  const groups = new Map();
  const groupLabels = new Map();
  for (const thread of sourceItems) {
    const keyLabel = workspaceKeyOfThread(thread);
    const key = keyLabel.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    if (!groupLabels.has(key)) groupLabels.set(key, keyLabel);
    groups.get(key).push(thread);
  }
  const entries = Array.from(groups.entries())
    .map(([k, v]) => [groupLabels.get(k) || k, v, k])
    .sort((a, b) => String(a[0] || "").localeCompare(String(b[0] || ""), undefined, { sensitivity: "base", numeric: true }));
  if (!entries.length) {
    if (state.threadListLoading && (!state.threadListLoadingTarget || state.threadListLoadingTarget === getWorkspaceTarget())) {
      renderThreadListState("Loading chats...", "spinner");
      state.threadListAnimateNextRender = false;
      state.threadListAnimateThreadIds = new Set();
      state.threadListExpandAnimateGroupKeys = new Set();
      return;
    }
    const waitingWorkspaceDetection =
      !state.workspaceAvailability.windowsInstalled &&
      !state.workspaceAvailability.wsl2Installed;
    if (waitingWorkspaceDetection) {
      renderThreadListState("Waiting for WIN/WSL2...", "spinner");
      state.threadListAnimateNextRender = false;
      state.threadListAnimateThreadIds = new Set();
      state.threadListExpandAnimateGroupKeys = new Set();
      return;
    }
    if (state.threadItemsAll.length && hasDualWorkspaceTargets()) {
      renderThreadListState(`No ${getWorkspaceTarget().toUpperCase()} chats yet.`);
    } else {
      renderThreadListState("No threads yet.");
    }
    state.threadListAnimateNextRender = false;
    state.threadListAnimateThreadIds = new Set();
    state.threadListExpandAnimateGroupKeys = new Set();
    state.threadListChevronOpenAnimateKeys = new Set();
    state.threadListChevronCloseAnimateKeys = new Set();
    state.threadListCollapseAnimateGroupKeys = new Set();
    return;
  }
  list.innerHTML = "";
  const validKeys = new Set(entries.map(([, ,k]) => k));
  if (state.collapsedWorkspaceKeys.size) {
    state.collapsedWorkspaceKeys = new Set(
      Array.from(state.collapsedWorkspaceKeys).filter((k) => validKeys.has(k) || String(k).startsWith("__section_"))
    );
  }
  const collapseInitKey = normalizeWorkspaceTarget(getWorkspaceTarget());
  const collapseInitialized = !!state.threadGroupCollapseInitializedByWorkspace?.[collapseInitKey];
  if (!collapseInitialized) {
    for (let i = 0; i < entries.length; i += 1) state.collapsedWorkspaceKeys.add(entries[i][2]);
    state.threadGroupCollapseInitializedByWorkspace[collapseInitKey] = true;
  }

  let renderedThreads = 0;
  const favoriteSet = state.favoriteThreadIds;
  const favoriteItems = sourceItems.filter((thread) => {
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
      if (animateEnter || (id && animateThreadIds.has(id))) {
        card.classList.add("threadEnter");
        card.style.setProperty("--thread-enter-delay", `${nextThreadEnterDelayMs()}ms`);
      }
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
            setStatus(`Opened ${label} ${truncateLabel(id, 12)} history ${historyLatencyMs}ms`); 
          } 
          if (state.openingThreadReqId === reqId) scheduleThreadRefresh();

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
    if (animateEnter) {
      group.classList.add("groupEnter");
      group.style.setProperty("--thread-group-enter-delay", `${nextGroupEnterDelayMs()}ms`);
    }
    group.setAttribute("data-group-key", String(sectionKey));
    const header = document.createElement("button");
    const collapsed = state.collapsedWorkspaceKeys.has(sectionKey);
    header.className = `groupHeader${collapsed ? " is-collapsed" : ""}${animateEnter ? " threadHeaderEnter" : ""}`;
    const animClass = chevronCloseAnimateKeys.has(String(sectionKey))
      ? " anim-close"
      : (chevronOpenAnimateKeys.has(String(sectionKey)) ? " anim-open" : "");
    header.innerHTML =
      `<span class="itemTitle">${escapeHtml(sectionTitle)}</span>` +
      `<span class="groupChevron${collapsed ? " is-collapsed" : ""}${animClass}" aria-hidden="true">` +
      `<svg class="groupChevronIcon" viewBox="0 0 16 16" focusable="false"><path d="M6 4l4 4-4 4"></path></svg>` +
      `</span>`;
    header.onclick = () => {
      const currentlyCollapsed = state.collapsedWorkspaceKeys.has(sectionKey);
      if (currentlyCollapsed) {
        state.collapsedWorkspaceKeys.delete(sectionKey);
        state.threadListAnimateNextRender = false;
        state.threadListAnimateThreadIds = new Set();
        state.threadListExpandAnimateGroupKeys = new Set([String(sectionKey)]);
        state.threadListCollapseAnimateGroupKeys = new Set();
        state.threadListChevronOpenAnimateKeys = new Set([String(sectionKey)]);
        state.threadListChevronCloseAnimateKeys = new Set();
        state.threadListSkipScrollRestoreOnce = true;
        renderThreads(state.threadItems);
        return;
      }
      const bodyNode = group.querySelector(".groupBody");
      state.threadListChevronOpenAnimateKeys = new Set();
      state.threadListChevronCloseAnimateKeys = new Set([String(sectionKey)]);
      animateCollapseBody(bodyNode, () => {
        state.collapsedWorkspaceKeys.add(sectionKey);
        state.threadListAnimateNextRender = false;
        state.threadListAnimateThreadIds = new Set();
        state.threadListExpandAnimateGroupKeys = new Set();
        state.threadListCollapseAnimateGroupKeys = new Set();
        state.threadListSkipScrollRestoreOnce = true;
        renderThreads(state.threadItems);
      });
    };
    group.appendChild(header);
    let bodyForExpandAnim = null;
    if (!collapsed) {
      const body = document.createElement("div");
      body.className = "groupBody";
      for (const thread of sectionItems) body.appendChild(renderThreadCard(thread));
      group.appendChild(body);
      if (expandAnimateGroupKeys.has(String(sectionKey))) bodyForExpandAnim = body;
      const prevTop = prevGroupScroll.get(String(sectionKey));
      if (typeof prevTop === "number" && Number.isFinite(prevTop) && prevTop > 0) {
        pendingScrollRestores.push({ node: body, top: prevTop });
      }
    }
    list.appendChild(group);
    if (bodyForExpandAnim) animateExpandBody(bodyForExpandAnim);
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
    if (animateEnter) {
      group.classList.add("groupEnter");
      group.style.setProperty("--thread-group-enter-delay", `${nextGroupEnterDelayMs()}ms`);
    }
    group.setAttribute("data-group-key", String(workspaceKey));
    const header = document.createElement("button");
    const collapsed = state.collapsedWorkspaceKeys.has(workspaceKey);
    header.className = `groupHeader${collapsed ? " is-collapsed" : ""}${animateEnter ? " threadHeaderEnter" : ""}`;
    const animClass = chevronCloseAnimateKeys.has(String(workspaceKey))
      ? " anim-close"
      : (chevronOpenAnimateKeys.has(String(workspaceKey)) ? " anim-open" : "");
    header.innerHTML =
      `<span class="itemTitle">${escapeHtml(workspace)}</span>` +
      `<span class="groupChevron${collapsed ? " is-collapsed" : ""}${animClass}" aria-hidden="true">` +
      `<svg class="groupChevronIcon" viewBox="0 0 16 16" focusable="false"><path d="M6 4l4 4-4 4"></path></svg>` +
      `</span>`;
    header.onclick = () => {
      const currentlyCollapsed = state.collapsedWorkspaceKeys.has(workspaceKey);
      if (currentlyCollapsed) {
        const currentlyOpenKey =
          entries.find(([, , key]) => key !== workspaceKey && !state.collapsedWorkspaceKeys.has(key))?.[2] || "";
        startExclusiveGroupSwitch(
          workspaceKey,
          currentlyOpenKey,
          entries.map(([, , key]) => key),
        );
        return;
      }
      const bodyNode = group.querySelector(".groupBody");
      state.threadListChevronOpenAnimateKeys = new Set();
      state.threadListChevronCloseAnimateKeys = new Set([String(workspaceKey)]);
      animateCollapseBody(bodyNode, () => {
        // Collapse this group when tapping it again.
        state.collapsedWorkspaceKeys.add(workspaceKey);
        state.threadListAnimateNextRender = false;
        state.threadListAnimateThreadIds = new Set();
        state.threadListExpandAnimateGroupKeys = new Set();
        state.threadListCollapseAnimateGroupKeys = new Set();
        state.threadListSkipScrollRestoreOnce = true;
        renderThreads(state.threadItems);
      });
    };
    group.appendChild(header);
    let bodyForExpandAnim = null;
    let bodyForCollapseAnim = null;
    const renderCollapsedBody = collapsed && collapseAnimateGroupKeys.has(String(workspaceKey));
    if (!collapsed || renderCollapsedBody) {
      const body = document.createElement("div");
      body.className = "groupBody";
      for (const thread of filtered) body.appendChild(renderThreadCard(thread));
      group.appendChild(body);
      if (renderCollapsedBody) bodyForCollapseAnim = body;
      else if (expandAnimateGroupKeys.has(String(workspaceKey))) bodyForExpandAnim = body;
      const prevTop = prevGroupScroll.get(String(workspaceKey));
      if (!renderCollapsedBody && typeof prevTop === "number" && Number.isFinite(prevTop) && prevTop > 0) {
        pendingScrollRestores.push({ node: body, top: prevTop });
      }
    }
    list.appendChild(group);
    if (bodyForExpandAnim) animateExpandBody(bodyForExpandAnim);
    if (bodyForCollapseAnim) {
      animateCollapseBody(bodyForCollapseAnim, () => {
        const activeCollapseKeys =
          state.threadListCollapseAnimateGroupKeys instanceof Set
            ? state.threadListCollapseAnimateGroupKeys
            : new Set();
        state.threadListCollapseAnimateGroupKeys = new Set(
          Array.from(activeCollapseKeys).filter((key) => key !== String(workspaceKey)),
        );
        state.threadListAnimateNextRender = false;
        state.threadListAnimateThreadIds = new Set();
        state.threadListSkipScrollRestoreOnce = true;
        renderThreads(state.threadItems);
      });
    }
  }
  if (!renderedThreads) renderThreadListState("No threads match search.");
  if (!list.childElementCount && !String(list.textContent || "").trim()) {
    if (state.threadListLoading) renderThreadListState("Loading chats...", "spinner");
    else renderThreadListState("Waiting for chats...", "spinner");
  }
  if (pendingVisibleAnimation && listActuallyVisible && sourceItems.length > 0) {
    state.threadListPendingVisibleAnimationByWorkspace[currentWorkspaceKey] = false;
  }
  state.threadListAnimateNextRender = false;
  state.threadListAnimateThreadIds = new Set();
  state.threadListExpandAnimateGroupKeys = new Set();
  state.threadListChevronOpenAnimateKeys = new Set();
  state.threadListChevronCloseAnimateKeys = new Set();
  if (animateEnter && sourceItems.length > 0 && document.body.classList.contains("drawer-left-open")) {
    // Consume the "open sidebar with enter animation" intent on the first non-empty onscreen render.
    // Without this, a later refresh/finalizer render can replay the same group-enter animation a second
    // time, which shows up as a brief flash/restart after F5 + immediate open/switch.
    state.threadListPendingVisibleAnimationByWorkspace[currentWorkspaceKey] = false;
  }
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
  let nestedScrollSource = null;
  let waitingNestedReachTop = false;

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
    const target = event.target instanceof Element ? event.target : null;
    const innerGroupBody = target?.closest?.(".groupBody");
    startY = event.touches[0].clientY;
    pullPx = 0;
    nestedScrollSource = innerGroupBody && list.contains(innerGroupBody) ? innerGroupBody : null;
    waitingNestedReachTop = !!nestedScrollSource;
    if (nestedScrollSource) {
      tracking = nestedScrollSource.scrollTop <= 0 && list.scrollTop <= 0;
      return;
    }
    if (list.scrollTop > 0) return;
    tracking = true;
  }, { passive: true });

  list.addEventListener("touchmove", (event) => {
    if (state.threadPullRefreshing) return;
    const y = event.touches[0]?.clientY ?? startY;
    if (!tracking && waitingNestedReachTop && nestedScrollSource) {
      // Human-friendly handoff: when inner list is already pulled to top and user keeps pulling down,
      // switch to outer pull-to-refresh within the same gesture.
      if (nestedScrollSource.scrollTop > 0) return;
      if (list.scrollTop > 0) return;
      const armRaw = y - startY;
      if (armRaw <= 0) return;
      tracking = true;
      waitingNestedReachTop = false;
      startY = y;
      pullPx = 0;
      return;
    }
    if (!tracking) return;
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
    if (!tracking) {
      nestedScrollSource = null;
      waitingNestedReachTop = false;
      return;
    }
    tracking = false;
    nestedScrollSource = null;
    waitingNestedReachTop = false;
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
    if (state.threadRefreshAbortByWorkspace?.[target]) return;
    const wsOpen = !!(state.ws && state.ws.readyState === WebSocket.OPEN);
    const wsSubscribed = !!(wsOpen && state.wsSubscribedEvents);
    const minInterval = wsSubscribed ? THREAD_AUTO_REFRESH_CONNECTED_MS : THREAD_AUTO_REFRESH_DISCONNECTED_MS;
    const now = Date.now();
    const lastMs = state.threadAutoRefreshLastMsByWorkspace?.[target] || 0;
    if (now - lastMs < minInterval) return;
    state.threadAutoRefreshLastMsByWorkspace[target] = now;
    state.threadAutoRefreshInFlight = true;
    refreshThreads(target, { force: false, silent: true })
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
      await loadThreadMessages(threadId, {
        animateBadge: false,
        workspace: state.activeThreadWorkspace,
        rolloutPath: state.activeThreadRolloutPath,
      });
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
  const force = options.force === true;
  if (force) {
    const now = Date.now();
    const last = Number(state.threadForceRefreshLastMsByWorkspace[target] || 0);
    if (now - last < THREAD_FORCE_REFRESH_MIN_INTERVAL_MS) return;
    state.threadForceRefreshLastMsByWorkspace[target] = now;
  }
  const reqSeq = (state.threadRefreshReqSeqByWorkspace[target] || 0) + 1;
  state.threadRefreshReqSeqByWorkspace[target] = reqSeq;

  if (state.threadRefreshAbortByWorkspace[target]) {
    try {
      state.threadRefreshAbortByWorkspace[target].abort();
    } catch {}
  }
  const controller = new AbortController();
  state.threadRefreshAbortByWorkspace[target] = controller;

  const silent = options.silent === true;
  const workspace = encodeURIComponent(target);
  const query = force ? `workspace=${workspace}&force=true` : `workspace=${workspace}`;
  const activeBefore = getWorkspaceTarget() === target;
  pushThreadAnimDebug("refreshThreads:start", {
    target,
    force,
    silent,
    activeBefore,
  });

  if (activeBefore && !silent) {
    state.threadListLoading = true;
    state.threadListLoadingTarget = target;
    if (!state.threadListPreferLoadingPlaceholder) {
      renderThreads(state.threadItems);
    }
  }

  try {
    const previousItems = Array.isArray(state.threadItemsByWorkspace[target])
      ? state.threadItemsByWorkspace[target]
      : [];
    const threadListNode = byId("threadList");
    const domWasPlaceholder =
      !!threadListNode?.querySelector?.(".threadListState, .threadListPlainState") ||
      !threadListNode?.querySelector?.(".groupCard, .itemCard");
    const previousIdSet = new Set(
      previousItems
        .map((item) => item?.id || item?.threadId || "")
        .filter(Boolean)
    );
    const data = await api(`/codex/threads?${query}`, { signal: controller.signal });
    const meta = data && typeof data === "object" ? data.meta || null : null;
    if (meta && typeof meta === "object") {
      const totalMs = Number(meta.totalMs || 0);
      const rebuildMs = Number(meta.rebuildMs || 0);
      const pagesScanned = Number(meta.pagesScanned || 0);
      const cacheHit = !!meta.cacheHit;
      if (totalMs >= 1500) {
        const cacheLabel = cacheHit ? "cache" : "rebuild";
        setStatus(
          `${target.toUpperCase()} chats ${cacheLabel} total ${Math.round(totalMs)}ms` +
            (rebuildMs > 0 ? ` rebuild ${Math.round(rebuildMs)}ms` : "") +
            (pagesScanned > 0 ? ` pages ${pagesScanned}` : "")
        );
      }
    }
    if ((state.threadRefreshReqSeqByWorkspace[target] || 0) !== reqSeq) return;
    const items = ensureArrayItems(data.items).map((item) => {
      if (!item || typeof item !== "object") return item;
      return {
        ...item,
        __workspaceQueryTarget: target,
      };
    });
    const nextSig = buildThreadRenderSig(items);
    const nextNewThreadIdSet = new Set();
    for (const item of items) {
      const id = item?.id || item?.threadId || "";
      if (!id) continue;
      if (!previousIdSet.has(id)) nextNewThreadIdSet.add(id);
    }
    const shouldAnimateFullList = previousItems.length === 0 && items.length > 0;
    const canAnimatePendingVisibleNow =
      !!state.threadListPendingVisibleAnimationByWorkspace?.[target] && isThreadListActuallyVisible() && items.length > 0;
    state.threadItemsByWorkspace[target] = items;
    state.threadWorkspaceHydratedByWorkspace[target] = true;
    persistThreadsCache();
    if (getWorkspaceTarget() !== target) return;
    const shouldAnimateVisibleListFromPlaceholder = domWasPlaceholder && items.length > 0;
    const animationHoldRemainingMs = Math.max(
      0,
      Number(state.threadListAnimationHoldUntilByWorkspace?.[target] || 0) - Date.now()
    );
    const shouldDeferVisibleRerender =
      !force &&
      getWorkspaceTarget() === target &&
      document.body.classList.contains("drawer-left-open") &&
      animationHoldRemainingMs > 0 &&
      !shouldAnimateFullList &&
      !shouldAnimateVisibleListFromPlaceholder &&
      !canAnimatePendingVisibleNow;
    pushThreadAnimDebug("refreshThreads:data", {
      target,
      force,
      silent,
      domWasPlaceholder,
      previousCount: previousItems.length,
      nextCount: items.length,
      sigSame: state.threadListRenderSigByWorkspace[target] === nextSig,
      prevSig: String(state.threadListRenderSigByWorkspace[target] || "").slice(0, 180),
      nextSig: String(nextSig || "").slice(0, 180),
      shouldAnimateFullList,
      shouldAnimateVisibleListFromPlaceholder,
      canAnimatePendingVisibleNow,
      animationHoldRemainingMs,
      shouldDeferVisibleRerender,
      pendingVisibleAnimation: !!state.threadListPendingVisibleAnimationByWorkspace?.[target],
      listActuallyVisible: isThreadListActuallyVisible(),
    });
    // If nothing changed, avoid re-rendering (keeps scroll position stable and reduces work on mobile).
    if (
      !force &&
      state.threadListRenderSigByWorkspace[target] === nextSig &&
      !shouldAnimateVisibleListFromPlaceholder &&
      !canAnimatePendingVisibleNow
    ) {
      state.threadListAnimateThreadIds = new Set();
      return;
    }
    state.threadListRenderSigByWorkspace[target] = nextSig;
    if (shouldDeferVisibleRerender) {
      pushThreadAnimDebug("refreshThreads:deferVisibleRerender", {
        target,
        remainingMs: animationHoldRemainingMs,
      });
      scheduleThreadListDeferredRender(target, animationHoldRemainingMs + 16);
      return;
    }
    state.threadItemsAll = items;
    if (items.length > 0 && !isThreadListActuallyVisible()) {
      state.threadListPendingVisibleAnimationByWorkspace[target] = true;
    }
    if (shouldAnimateFullList || shouldAnimateVisibleListFromPlaceholder || canAnimatePendingVisibleNow) {
      state.threadListAnimateNextRender = true;
      state.threadListAnimateThreadIds = new Set();
    } else {
      state.threadListAnimateNextRender = false;
      state.threadListAnimateThreadIds = nextNewThreadIdSet;
    }
    updateWorkspaceAvailabilityFromThreads(items);
    syncActiveThreadMetaFromList();
    applyThreadFilter();
    updateHeaderUi();
  } finally {
    if (state.threadRefreshAbortByWorkspace[target] === controller) {
      state.threadRefreshAbortByWorkspace[target] = null;
    }
    if ((state.threadRefreshReqSeqByWorkspace[target] || 0) === reqSeq && getWorkspaceTarget() === target && !silent) {
      const list = byId("threadList");
      const hadLoadingPlaceholder = !!list?.querySelector?.(".threadListState");
      const needsFinalRender = hadLoadingPlaceholder || !Array.isArray(state.threadItems) || state.threadItems.length === 0;
      state.threadListLoading = false;
      state.threadListLoadingTarget = "";
      state.threadListPreferLoadingPlaceholder = false;
      const sidebarOpen = document.body.classList.contains("drawer-left-open");
      pushThreadAnimDebug("refreshThreads:finally", {
        target,
        silent,
        hadLoadingPlaceholder,
        needsFinalRender,
        sidebarOpen,
        pendingSidebarOpenAnimation: !!state.threadListPendingSidebarOpenAnimation,
      });
      if (state.threadListPendingSidebarOpenAnimation) {
        state.threadListPendingSidebarOpenAnimation = false;
        if (sidebarOpen && Array.isArray(state.threadItems) && state.threadItems.length) {
          scheduleThreadListVisibleAnimationRender(230);
          return;
        }
      }
      // Only do a final render pass when we need to clear loading/empty placeholders.
      // For non-empty lists we skip this extra render so enter animations are not overwritten.
      if (needsFinalRender) renderThreads(state.threadItems);
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
  const currentTarget = getWorkspaceTarget();
  const otherTarget = currentTarget === "wsl2" ? "windows" : "wsl2";
  const tasks = [refreshThreads(currentTarget, { force: false, silent: false }), refreshHosts()];
  if (isWorkspaceAvailable(otherTarget)) {
    tasks.push(refreshThreads(otherTarget, { force: false, silent: true }).catch(() => null));
  }
  await Promise.all(tasks);
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
  const workspace = getWorkspaceTarget();
  const startCwd = getStartCwdForWorkspace(workspace);
  setChatOpening(false);
  // Immediately switch UI back to the fresh-chat state.
  setActiveThread("");
  state.activeThreadStarted = false;
  state.activeThreadWorkspace = workspace;
  state.activeThreadTokenUsage = null;
  renderComposerContextLeft();
  clearChatMessages();
  showWelcomeCard();
  updateHeaderUi();

  const data = await api("/codex/threads", {
    method: "POST",
    body: {
      workspace,
      cwd: startCwd || undefined,
    },
  });
  const id = data.id || data.threadId || data?.thread?.id || "";
  if (id) {
    setActiveThread(id);
    state.activeThreadStarted = false;
    state.activeThreadWorkspace = workspace;
    state.activeThreadTokenUsage = null;
    renderComposerContextLeft();
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
  const workspace = getWorkspaceTarget();
  const startCwd = getStartCwdForWorkspace(workspace);
  const shouldSendStartCwd = !String(state.activeThreadId || "").trim();
  await waitPendingThreadResume(state.activeThreadId);
  const payload = {
    threadId: state.activeThreadId || null,
    prompt,
    cwd: shouldSendStartCwd ? (startCwd || undefined) : undefined,
    model: state.selectedModel || undefined,
    reasoningEffort: state.selectedReasoningEffort || undefined,
    collaborationMode: "default",
  };
  const shouldAnimateWorkspaceBadge = !state.activeThreadStarted;
  state.activeThreadStarted = true;
  state.activeThreadWorkspace = workspace;
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
  const wasThreadsOpen = document.body.classList.contains("drawer-left-open");
  pushThreadAnimDebug("setMobileTab:start", {
    tab,
    wasThreadsOpen,
  });
  document.body.classList.remove("drawer-left-open", "drawer-right-open");
  document.body.classList.remove("drawer-left-opening", "drawer-right-opening");
  if (state.drawerOpenPhaseTimer) {
    clearTimeout(state.drawerOpenPhaseTimer);
    state.drawerOpenPhaseTimer = 0;
  }
  if (tab === "threads") document.body.classList.add("drawer-left-open");
  if (tab === "tools") document.body.classList.add("drawer-right-open");
  if (tab === "threads" && !wasThreadsOpen) {
    state.threadListVisibleOpenAnimationUntil = Date.now() + 520;
    document.body.classList.add("drawer-left-opening");
    state.drawerOpenPhaseTimer = setTimeout(() => {
      document.body.classList.remove("drawer-left-opening");
      state.drawerOpenPhaseTimer = 0;
    }, 220);
  }
  if (tab === "tools") {
    document.body.classList.add("drawer-right-opening");
    state.drawerOpenPhaseTimer = setTimeout(() => {
      document.body.classList.remove("drawer-right-opening");
      state.drawerOpenPhaseTimer = 0;
    }, 220);
  }
  byId("mobileDrawerBackdrop").classList.toggle("show", tab === "threads" || tab === "tools");
  if (tab !== "threads") {
    state.threadListPendingSidebarOpenAnimation = false;
    state.threadListVisibleOpenAnimationUntil = 0;
    if (state.threadListVisibleAnimationTimer) {
      clearTimeout(state.threadListVisibleAnimationTimer);
      state.threadListVisibleAnimationTimer = 0;
    }
  }
  if (tab === "threads" && !wasThreadsOpen) {
    const currentWorkspaceKey = normalizeWorkspaceTarget(getWorkspaceTarget());
    const hasThreadItems = Array.isArray(state.threadItems) && state.threadItems.length > 0;
    const animateVisibleThreadListNow = () => {
      pushThreadAnimDebug("setMobileTab:animateVisibleNow", {
        currentWorkspaceKey,
        hasThreadItems,
      });
      state.threadListPendingVisibleAnimationByWorkspace[currentWorkspaceKey] = true;
      state.threadListAnimateNextRender = true;
      state.threadListAnimateThreadIds = new Set();
      state.threadListExpandAnimateGroupKeys = new Set();
      state.threadListSkipScrollRestoreOnce = true;
      renderThreads(state.threadItems);
    };
    if (state.threadListLoading) {
      if (hasThreadItems) {
        // If cached groups already exist, re-render them immediately after the drawer starts opening so the
        // same DOM does not simply slide onscreen without enter animation. The CSS opening phase pauses the
        // animation until the drawer has finished sliding in.
        state.threadListPendingSidebarOpenAnimation = false;
        animateVisibleThreadListNow();
      } else {
        pushThreadAnimDebug("setMobileTab:pendingSidebarAnimation", {
          currentWorkspaceKey,
        });
        state.threadListPendingSidebarOpenAnimation = true;
      }
      return;
    }
    if (hasThreadItems) {
      animateVisibleThreadListNow();
      return;
    }
  }
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
    wireBlurBackdropShield(backdrop, { onClose: () => setMobileTab("chat"), suppressMs: 420 });
  }
  {
    const folderBackdrop = byId("folderPickerBackdrop");
    wireBlurBackdropShield(folderBackdrop, { onClose: closeFolderPicker, modalSelector: ".folderPickerModal", suppressMs: 420 });
  }
  bindClick("folderPickerCloseBtn", () => closeFolderPicker());
  bindClick("folderPickerUpBtn", () => {
    if (state.folderPickerLoading) return;
    const parentPath = String(state.folderPickerParentPath || "").trim();
    if (!parentPath) return;
    refreshFolderPicker(parentPath).catch((e) => {
      state.folderPickerError = e?.message || "Failed to browse folders.";
      renderFolderPicker();
    });
  });
  bindClick("folderPickerUseCurrentBtn", () => confirmFolderPickerCurrentPath());
  bindClick("folderPickerUseDefaultBtn", () => resetFolderPickerPath());
  bindClick("folderPickerWorkspaceWindowsBtn", () =>
    switchFolderPickerWorkspace("windows").catch((e) => {
      state.folderPickerError = String(e?.message || e || "Failed to switch workspace.");
      renderFolderPicker();
    })
  );
  bindClick("folderPickerWorkspaceWslBtn", () =>
    switchFolderPickerWorkspace("wsl2").catch((e) => {
      state.folderPickerError = String(e?.message || e || "Failed to switch workspace.");
      renderFolderPicker();
    })
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.folderPickerOpen) closeFolderPicker();
  });
  bindClick("leftStartDirBtn", () => {
    openFolderPicker().catch((e) => setStatus(e.message, true));
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
    openFolderPicker().catch((e) => setStatus(e.message, true));
  });
  bindResponsiveClick("workspaceWindowsBtn", () => setWorkspaceTarget("windows").catch((e) => setStatus(e.message, true)));
  bindResponsiveClick("workspaceWslBtn", () => setWorkspaceTarget("wsl2").catch((e) => setStatus(e.message, true)));
  bindResponsiveClick("drawerWorkspaceWindowsBtn", () => setWorkspaceTarget("windows").catch((e) => setStatus(e.message, true)));
  bindResponsiveClick("drawerWorkspaceWslBtn", () => setWorkspaceTarget("wsl2").catch((e) => setStatus(e.message, true)));
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

function readDebugMessageNode(node, index) {
  const body = node?.querySelector?.(".msgBody") || null;
  const inline = body ? Array.from(body.querySelectorAll("code.msgInlineCode")).map((n) => String(n.textContent || "").trim()) : [];
  const pseudo = body ? Array.from(body.querySelectorAll(".msgPseudoLink")).map((n) => String(n.textContent || "").trim()) : [];
  const links = body ? Array.from(body.querySelectorAll("a.msgLink")).map((n) => ({
    text: String(n.textContent || "").trim(),
    href: String(n.getAttribute("href") || "").trim(),
  })) : [];
  return {
    index,
    className: String(node?.className || ""),
    role: String(node?.__webCodexRole || ""),
    kind: String(node?.__webCodexKind || ""),
    source: String(node?.__webCodexSource || ""),
    rawText: typeof node?.__webCodexRawText === "string" ? node.__webCodexRawText : "",
    headText: String(node?.querySelector?.(".msgHead")?.textContent || "").trim(),
    bodyText: String(body?.textContent || ""),
    bodyHtml: String(body?.innerHTML || ""),
    inline,
    pseudo,
    links,
  };
}

function installWebCodexDebug() {
  try {
    const previous = window.__webCodexDebug || {};
    window.__webCodexDebug = {
      ...previous,
      version: WEB_CODEX_DEV_DEBUG_VERSION,
      scriptUrl: typeof import.meta !== "undefined" ? String(import.meta.url || "") : "",
      loadedAt: new Date().toISOString(),
      getScriptInfo() {
        return {
          version: WEB_CODEX_DEV_DEBUG_VERSION,
          scriptUrl: typeof import.meta !== "undefined" ? String(import.meta.url || "") : "",
          loadedAt: String(window.__webCodexDebug?.loadedAt || ""),
          activeThreadId: String(state.activeThreadId || ""),
          activeThreadWorkspace: String(state.activeThreadWorkspace || ""),
          activeThreadRenderSig: String(state.activeThreadRenderSig || ""),
          messageCount: document.querySelectorAll("#chatBox .msg").length,
        };
      },
      dumpMessages(limit = 8) {
        const max = Math.max(1, Number(limit || 8) | 0);
        const nodes = Array.from(document.querySelectorAll("#chatBox .msg"));
        return nodes.slice(Math.max(0, nodes.length - max)).map((node, index) => readDebugMessageNode(node, nodes.length - Math.min(max, nodes.length) + index));
      },
      findMessage(needle) {
        const query = String(needle || "");
        const nodes = Array.from(document.querySelectorAll("#chatBox .msg"));
        for (let i = 0; i < nodes.length; i += 1) {
          const info = readDebugMessageNode(nodes[i], i);
          if (!query || info.rawText.includes(query) || info.bodyText.includes(query) || info.bodyHtml.includes(query)) return info;
        }
        return null;
      },
      getChatHtml() {
        return String(document.getElementById("chatBox")?.innerHTML || "");
      },
      renderInlineText(text) {
        return renderInlineMessageText(String(text || ""));
      },
      scanInlineText(text) {
        const source = String(text || "");
        const spans = [];
        let cursor = 0;
        while (cursor < source.length) {
          const span = findNextInlineCodeSpan(source, cursor);
          if (!span) break;
          spans.push({
            kind: "code",
            start: span.start,
            end: span.end,
            fenceLen: span.fenceLen || 0,
            content: typeof span.content === "string" ? span.content : "",
            raw: source.slice(span.start, span.end),
          });
          cursor = span.end;
        }
        return spans;
      },
    };
  } catch {}
}

function installThreadAnimDebug() {
  if (!threadAnimDebug.enabled) return;
  const list = byId("threadList");
  if (!list || list.__threadAnimDebugInstalled) return;
  list.__threadAnimDebugInstalled = true;
  const recordAnimationEvent = (eventType) => (event) => {
    const target = event?.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.classList.contains("groupCard")) return;
    pushThreadAnimDebug(`animation:${eventType}`, {
      groupKey: target.getAttribute("data-group-key") || "",
      className: target.className,
      animationName: String(event?.animationName || ""),
      elapsedTime: Number(event?.elapsedTime || 0),
    });
  };
  list.addEventListener("animationstart", recordAnimationEvent("start"));
  list.addEventListener("animationcancel", recordAnimationEvent("cancel"));
  list.addEventListener("animationend", recordAnimationEvent("end"));
}

function bootstrap() {
  // E2E-only hooks (guarded). This avoids relying on a running gateway just to validate
  // UI behaviors like scroll anchoring, scrollbar hiding, and history rendering.
  try {
    installWebCodexDebug();
  const params = new URLSearchParams(window.location.search);
    if (params.get("animdebug") === "1") {
      threadAnimDebug.enabled = true;
      installThreadAnimDebug();
      pushThreadAnimDebug("debug:enabled");
      window.__webCodexAnimDebug = {
        getEvents() {
          return threadAnimDebug.events.slice();
        },
        clear() {
          threadAnimDebug.events = [];
          threadAnimDebug.seq = 0;
          return { ok: true };
        },
      };
    }
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
        getComposerContextLeft() {
          const node = document.getElementById("mobileContextLeft");
          if (!node) return { text: "", top: 0, left: 0, width: 0, height: 0 };
          const rect = node.getBoundingClientRect();
          return {
            text: String(node.getAttribute("aria-label") || node.textContent || "").trim(),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          };
        },
        setComposerTokenUsage(tokenUsage) {
          state.activeThreadTokenUsage = normalizeThreadTokenUsage(tokenUsage);
          renderComposerContextLeft();
          return this.getComposerContextLeft();
        },
        setChatOpeningState(opening) {
          setChatOpening(!!opening);
          return this.getComposerContextLeft();
        },
        resetComposerToNewChat() {
          setChatOpening(false);
          setActiveThread("");
          state.activeThreadStarted = false;
          state.activeThreadWorkspace = getWorkspaceTarget();
          state.activeThreadTokenUsage = null;
          renderComposerContextLeft();
          clearChatMessages();
          showWelcomeCard();
          updateHeaderUi();
          return this.getComposerContextLeft();
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
          await loadThreadMessages(id, {
            animateBadge: true,
            forceRender: true,
            stickToBottom: true,
            workspace: state.activeThreadWorkspace,
            rolloutPath: state.activeThreadRolloutPath,
          });
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
            workspace: state.activeThreadWorkspace,
            rolloutPath: state.activeThreadRolloutPath,
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
          await loadThreadMessages(id, {
            animateBadge: false,
            forceRender: true,
            workspace: state.activeThreadWorkspace,
            rolloutPath: state.activeThreadRolloutPath,
          });
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
        async refreshThreadsWithMockDelay(target = "windows", items = [], delayMs = 0) {
          const workspace = normalizeWorkspaceTarget(String(target || "windows"));
          const waitMs = Math.max(0, Number(delayMs || 0));
          const origFetch = window.fetch;
          window.fetch = async (input, init) => {
            try {
              const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
              if (typeof url === "string" && url.startsWith("/codex/threads")) {
                if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
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
        async setWorkspaceTarget(target = "windows") {
          try {
            await setWorkspaceTarget(target);
            return { ok: true, target: normalizeWorkspaceTarget(target) };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        setMobileTabForE2E(tab = "chat") {
          try {
            setMobileTab(String(tab || "chat"));
            return { ok: true, tab: String(tab || "chat") };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
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
              if (typeof url === "string" && url.includes("/codex/threads/") && url.includes("/resume")) {
                const id = String(url.split("/codex/threads/")[1] || "").split("/")[0] || "e2e";
                return new Response(JSON.stringify({ threadId: decodeURIComponent(id), ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
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
        getThreadAnimDebugEvents() {
          try {
            return window.__webCodexAnimDebug?.getEvents?.() || [];
          } catch {
            return [];
          }
        },
        clearThreadAnimDebugEvents() {
          try {
            return window.__webCodexAnimDebug?.clear?.() || { ok: false };
          } catch {
            return { ok: false };
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
  const savedStartCwdRaw = localStorage.getItem(START_CWD_BY_WORKSPACE_KEY) || "";
  const savedFavoritesRaw = localStorage.getItem(FAVORITE_THREADS_KEY) || "[]";
  const savedModel = String(localStorage.getItem(SELECTED_MODEL_KEY) || "").trim();
  try {
    if (savedStartCwdRaw) {
      const parsed = JSON.parse(savedStartCwdRaw);
      const windowsCwd = normalizeStartCwd(parsed?.windows || "", "windows");
      const wsl2Cwd = normalizeStartCwd(parsed?.wsl2 || "", "wsl2");
      state.startCwdByWorkspace = {
        windows: windowsCwd,
        wsl2: wsl2Cwd,
      };
    }
  } catch {
    state.startCwdByWorkspace = {
      windows: "",
      wsl2: "",
    };
  }
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
  state.collapsedWorkspaceKeys =
    state.collapsedWorkspaceKeysByWorkspace[state.workspaceTarget] instanceof Set
      ? state.collapsedWorkspaceKeysByWorkspace[state.workspaceTarget]
      : new Set();
  state.activeThreadWorkspace = state.workspaceTarget;
  if (savedModel) state.selectedModel = savedModel;
  restoreModelsCache();
  restoreThreadsCache(state.workspaceTarget);
  updateWorkspaceAvailability(false, false);
  if (state.threadItemsByWorkspace.windows.length || state.threadItemsByWorkspace.wsl2.length) {
    updateWorkspaceAvailability(
      state.threadItemsByWorkspace.windows.length > 0,
      state.threadItemsByWorkspace.wsl2.length > 0,
      { applyFilter: false }
    );
  }
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
  renderFolderPicker();
  renderAttachmentPills([]);
  renderComposerContextLeft();
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
  document.body.classList.add("thread-list-bootstrapped");
  // Always attempt connect: gateway auth can now come from HttpOnly cookie.
  connect().catch((e) => setStatus(e.message, true));
}

bootstrap();
