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
  activeThreadRenderSig: "",
  activeThreadMessages: [],
  wsLastEventId: 0,
  wsRecentEventIds: new Set(),
  wsRecentEventIdQueue: [],
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
  chatAutoStickUntil: 0,
  activeThreadModelLabel: "",
  activeThreadWorkspace: "windows",
  modelOptions: [],
  selectedModel: "",
  openingThreadReqId: 0,
  pendingThreadResumes: new Map(),
};

const GUIDE_DISMISSED_KEY = "web_codex_guide_dismissed_v2";
const TOKEN_STORAGE_KEY = "web_codex_token_v1";
const WORKSPACE_TARGET_KEY = "web_codex_workspace_target_v1";
const FAVORITE_THREADS_KEY = "web_codex_favorite_threads_v1";
const SANDBOX_MODE =
  window.__WEB_CODEX_SANDBOX__ === true ||
  window.location.pathname.startsWith("/sandbox/") ||
  new URLSearchParams(window.location.search).get("sandbox") === "1";
const THREAD_PULL_REFRESH_TRIGGER_PX = 44;
const THREAD_PULL_REFRESH_MAX_PX = 84;
const THREAD_PULL_REFRESH_MIN_MS = 520;
const THREAD_PULL_HINT_CLEAR_DELAY_MS = 160;
const THREAD_REFRESH_DEBOUNCE_MS = 260;
const THREAD_AUTO_REFRESH_CONNECTED_MS = 2000;
const THREAD_AUTO_REFRESH_DISCONNECTED_MS = 3500;
const ACTIVE_THREAD_REFRESH_DEBOUNCE_MS = 380;
const ACTIVE_THREAD_LIVE_POLL_MS = 1500;
const RECENT_EVENT_ID_CACHE_SIZE = 2048;
const MOBILE_PROMPT_MIN_HEIGHT_PX = 40;
const MOBILE_PROMPT_MAX_HEIGHT_PX = 420;

function getEmbeddedToken() {
  const raw = "";
  return raw;
}

function byId(id) {
  return document.getElementById(id);
}

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
  const source = toRecord(params?.source) || toRecord(msg?.source);
  const subagent = toRecord(toRecord(source?.subagent)?.thread_spawn);
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
    readString(source?.thread_id) ||
    readString(source?.threadId) ||
    readString(source?.parent_thread_id) ||
    readString(source?.parentThreadId) ||
    readString(subagent?.parent_thread_id) ||
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

function pickActiveThreadModelLabel(thread) {
  const directModel = thread?.model;
  if (typeof directModel === "string" && directModel.trim()) return directModel.trim();
  if (directModel && typeof directModel === "object") {
    const modelId = String(directModel.id || "").trim();
    if (modelId) return modelId;
  }
  const topLevelModel = String(thread?.modelName || thread?.model_name || "").trim();
  if (topLevelModel) return topLevelModel;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const turnModel = String(lastTurn?.model || "").trim();
  if (turnModel) return turnModel;
  return "";
}

function syncActiveThreadMetaFromList(threadId = state.activeThreadId) {
  if (!threadId) return;
  const thread = state.threadItemsAll.find((item) => (item?.id || item?.threadId || "") === threadId);
  if (!thread) return;
  const target = detectThreadWorkspaceTarget(thread);
  if (target !== "unknown") state.activeThreadWorkspace = target;
  const rolloutPath = String(thread?.path || "").trim();
  if (rolloutPath) state.activeThreadRolloutPath = rolloutPath;
  const modelLabel = pickActiveThreadModelLabel(thread);
  if (modelLabel) state.activeThreadModelLabel = modelLabel;
}

function updateHeaderUi(animateBadge = false) {
  const panelTitle = document.querySelector(".chatPanel .panelHeader .panelTitle");
  const headerSwitch = byId("headerWorkspaceSwitch");
  const headerBadge = byId("headerWorkspaceBadge");
  const modelPicker = byId("headerModelPicker");
  const modelLabel = byId("headerModelLabel");
  const inSettings = state.activeMainTab === "settings";
  const showBadge = !inSettings && state.activeThreadStarted;
  const displayModel = state.activeThreadModelLabel || state.selectedModel || "Codex";
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
  if (modelLabel) modelLabel.textContent = displayTitle;
  if (inSettings) setHeaderModelMenuOpen(false);

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
  return { id, label, isDefault };
}

function setHeaderModelMenuOpen(open) {
  const picker = byId("headerModelPicker");
  const trigger = byId("headerModelTrigger");
  if (!picker || !trigger) return;
  picker.classList.toggle("open", !!open);
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
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
  for (const model of options) {
    const optionBtn = document.createElement("button");
    optionBtn.type = "button";
    optionBtn.className = `headerModelOption${model.id === current ? " active" : ""}`;
    optionBtn.setAttribute("role", "option");
    optionBtn.setAttribute("aria-selected", model.id === current ? "true" : "false");
    optionBtn.innerHTML = `<span>${escapeHtml(model.label || model.id)}</span><span class="check" aria-hidden="true">✓</span>`;
    optionBtn.onclick = () => {
      state.selectedModel = model.id;
      if (state.activeThreadStarted) state.activeThreadModelLabel = model.id;
      renderHeaderModelMenu();
      updateHeaderUi();
      setHeaderModelMenuOpen(false);
    };
    menu.appendChild(optionBtn);
  }
}

function syncHeaderModelPicker() {
  const picker = byId("headerModelPicker");
  if (!picker) return;
  const options = Array.isArray(state.modelOptions) ? state.modelOptions : [];
  if (!options.length) {
    state.selectedModel = "";
    renderHeaderModelMenu();
    updateHeaderUi();
    return;
  }
  const selected = state.selectedModel && options.some((item) => item.id === state.selectedModel)
    ? state.selectedModel
    : options.find((item) => item.isDefault)?.id || options[0].id;
  state.selectedModel = selected;
  renderHeaderModelMenu();
  updateHeaderUi();
}

async function refreshModels() {
  const data = await api("/codex/models");
  const rawItems = ensureArrayItems(data.items);
  const mapped = [];
  for (const item of rawItems) {
    const normalized = normalizeModelOption(item);
    if (normalized) mapped.push(normalized);
  }
  state.modelOptions = mapped;
  syncHeaderModelPicker();
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
  state.threadItems = state.threadItemsAll.filter(shouldRenderThreadForCurrentTarget);
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
  if (!hasDualWorkspaceTargets()) {
    const nextTarget = state.workspaceAvailability.wsl2Installed ? "wsl2" : "windows";
    state.workspaceTarget = normalizeWorkspaceTarget(nextTarget);
    localStorage.setItem(WORKSPACE_TARGET_KEY, state.workspaceTarget);
  }
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

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function looksLikeFileRef(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return (
    /^%[A-Za-z0-9_]+%[\\/]/.test(text) ||
    /^[a-z]:[\\/]/i.test(text) ||
    text.startsWith("/") ||
    text.startsWith("\\\\") ||
    text.includes("\\") ||
    /(?:^|\/)[^/\s]+\.[a-z0-9]{1,8}(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?$/i.test(text)
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
      html += buildMessageLink(match[6], match[6], true);
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
    return { indent, marker: match[2], text: match[3] };
  };
  const isListLine = (line) => !!parseListLine(line);
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
        const firstParsed = parseListLine(listLines[0]);
        const ordered = !!(firstParsed && /^\d+\.$/.test(firstParsed.marker));
        html += ordered ? "<ol>" : "<ul>";
        for (const itemLine of listLines) {
          const parsed = parseListLine(itemLine);
          if (!parsed) continue;
          const depth = Math.min(6, Math.floor(parsed.indent / 2));
          html += `<li class="msgListItem depth-${depth}">${renderInlineMessageText(parsed.text)}</li>`;
        }
        html += ordered ? "</ol>" : "</ul>";
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

  const canShowPreview = (src) => /^data:image\//i.test(src) || /^https?:\/\//i.test(src);
  const renderMissingTile = (label, extraHtml = "") =>
    `<button class="msgAttachmentCard msgAttachmentCard-missing tile" type="button" data-image-src="" data-image-label="${escapeHtml(label)}">` +
      `<div class="msgAttachmentChip mono">[image]</div>` +
      `<div class="msgAttachmentLabelBadge mono">${escapeHtml(label || "image")}</div>` +
      `${extraHtml}` +
    `</button>`;

  const renderTile = (src, label, overlay = "") => {
    if (canShowPreview(src)) {
      return (
        `<button class="msgAttachmentCard tile" type="button" data-image-src="${escapeHtml(src)}" data-image-label="${escapeHtml(label)}">` +
          `<img class="msgAttachmentImage" alt="${escapeHtml(label || "image")}" src="${escapeHtml(src)}" />` +
          `<div class="msgAttachmentLabelBadge mono">${escapeHtml(label || "image")}</div>` +
          `${overlay}` +
        `</button>`
      );
    }
    return renderMissingTile(label, overlay);
  };

  // WhatsApp-like: for 2+ images, always use a uniform mosaic grid (consistent tile sizing).
  // When there are many images, collapse to a 2x2 mosaic with a "+N" overlay.
  if (imgs.length >= 2) {
    const shown = imgs.length > 4 ? imgs.slice(0, 4) : imgs;
    const remaining = Math.max(0, imgs.length - shown.length);
    for (let idx = 0; idx < shown.length; idx += 1) {
      const img = shown[idx];
      const src = img.src.trim();
      const label = String(img.label || "").trim() || `Image #${idx + 1}`;
      const overlay = idx === 3 && remaining > 0 ? `<div class="msgAttachmentMoreOverlay">+${remaining}</div>` : "";
      nodes.push(renderTile(src, label, overlay));
    }
    const mosaicClass = shown.length === 3 ? "mosaic cols-3" : "mosaic";
    return `<div class="msgAttachments ${mosaicClass}">${nodes.join("")}</div>`;
  }

  for (const img of imgs) {
    const src = img.src.trim();
    const label = String(img.label || "").trim();
    // Allow data URLs and http(s). For local paths, we just show a chip for now
    // because the browser context may not have file access.
    if (canShowPreview(src)) {
      nodes.push(
        `<button class="msgAttachmentCard" type="button" data-image-src="${escapeHtml(src)}" data-image-label="${escapeHtml(label)}">` +
          `<img class="msgAttachmentImage" alt="${escapeHtml(label || "image")}" src="${escapeHtml(src)}" />` +
          `<div class="msgAttachmentCaption mono">${escapeHtml(label || "image")}</div>` +
        `</button>`
      );
    } else {
      nodes.push(
        `<button class="msgAttachmentCard msgAttachmentCard-missing" type="button" data-image-src="" data-image-label="${escapeHtml(label)}">` +
          `<div class="msgAttachmentChip mono">[image]</div>` +
          `<div class="msgAttachmentCaption mono">${escapeHtml(label || "image")}</div>` +
        `</button>`
      );
    }
  }
  return `<div class="msgAttachments">${nodes.join("")}</div>`;
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

function scrollChatToBottom({ force = false } = {}) {
  const box = byId("chatBox");
  if (!box) return;
  if (!force && !isChatNearBottom()) return;
  box.scrollTop = box.scrollHeight;
}

function stickChatToBottomFor(ms) {
  state.chatAutoStickUntil = Date.now() + Math.max(0, Number(ms || 0));
  scrollChatToBottom({ force: true });
  // Images/layout can settle on the next frame(s); keep the box pinned briefly.
  requestAnimationFrame(() => scrollChatToBottom({ force: Date.now() <= state.chatAutoStickUntil }));
  requestAnimationFrame(() => scrollChatToBottom({ force: Date.now() <= state.chatAutoStickUntil }));
  setTimeout(() => scrollChatToBottom({ force: Date.now() <= state.chatAutoStickUntil }), 220);
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
    event.preventDefault();
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
      const force = now <= Number(state.chatAutoStickUntil || 0);
      scrollChatToBottom({ force });
    };
    img.addEventListener("load", onSettled, { once: true });
    img.addEventListener("error", onSettled, { once: true });
  }
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
  node.className = `msg ${role}${kind ? ` kind-${kind}` : ""}`.trim();
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
  if (options.scroll !== false) box.scrollTop = box.scrollHeight;
}

function createAssistantStreamingMessage() {
  const msg = document.createElement("div");
  msg.className = "msg assistant";
  msg.innerHTML = `<div class="msgHead">assistant</div><div class="msgBody"></div>`;
  animateMessageNode(msg, 50);
  const body = msg.querySelector(".msgBody");
  return { msg, body };
}

function finalizeAssistantMessage(msgNode, bodyNode, text) {
  if (!msgNode || !bodyNode) return;
  const finalText = String(text || "").trim();
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

function clearChatMessages() {
  const box = byId("chatBox");
  if (!box) return;
  const nodes = box.querySelectorAll(".msg");
  for (const node of nodes) node.remove();
  box.scrollTop = 0;
  state.activeThreadRenderSig = "";
  state.activeThreadMessages = [];
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
  return thread?.updatedAt || "";
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
  if (/^data:/i.test(text)) return "inline-image";
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
  const source = String(text || "");
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
        const label = pendingImageLabels.shift() || fileName || `Image ${images.length + 1}`;
        images.push({ src: path, label, kind: "path" });
      }
      continue;
    }
    if (partType === "image") {
      const url = String(part.url || "").trim();
      if (url) {
        const label = pendingImageLabels.shift() || compactAttachmentLabel(url) || `Image ${images.length + 1}`;
        images.push({ src: url, label, kind: "url" });
      }
      continue;
    }
    if (partType === "inputimage") {
      const url = String(part.image_url || "").trim();
      if (url) {
        const label = pendingImageLabels.shift() || `Image ${images.length + 1}`;
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

function mapThreadReadMessages(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages = [];
  let seenAssistant = false;
  let seenNonBootstrapUser = false;
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      const type = String(item?.type || "").trim();
      if (type === "userMessage") {
        const parsed = parseUserMessageParts(item);
        const text = parsed.text;
        // Only hide Codex bootstrap prompt when it appears as the initial seed
        // before the first assistant output (so user pastes later are not hidden).
        if (text && isBootstrapAgentsPrompt(text) && !seenAssistant && !seenNonBootstrapUser) {
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

function applyThreadToChat(thread, options = {}) {
  const messages = mapThreadReadMessages(thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const renderSig = [
    String(thread?.id || state.activeThreadId || ""),
    String(turns.length),
    String(messages.length),
    String(lastMsg?.role || ""),
    String(lastMsg?.text || ""),
  ].join("::");
  state.activeThreadStarted = messages.length > 0 || turns.length > 0;
  const modelLabel = pickActiveThreadModelLabel(thread);
  if (modelLabel) state.activeThreadModelLabel = modelLabel;
  else state.activeThreadModelLabel = state.selectedModel || "";
  const target = detectThreadWorkspaceTarget(thread);
  if (target !== "unknown") state.activeThreadWorkspace = target;
  if (!options.forceRender && state.activeThreadRenderSig === renderSig) {
    if (state.activeThreadStarted) hideWelcomeCard();
    else showWelcomeCard();
    updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
    return;
  }

  const box = byId("chatBox");
  const nearBottom = !!(
    box &&
    box.scrollTop + box.clientHeight >= box.scrollHeight - 80
  );

  const prevMessages = Array.isArray(state.activeThreadMessages) ? state.activeThreadMessages : [];
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
        if (nearBottom && box) box.scrollTop = box.scrollHeight;
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
    if (nearBottom && box) box.scrollTop = box.scrollHeight;
  } else {
    clearChatMessages();
    for (const msg of messages) addChat(msg.role, msg.text, { scroll: false, kind: msg.kind || "", attachments: msg.images || [] });
    state.activeThreadMessages = messages;
    state.activeThreadRenderSig = renderSig;
    if (box) box.scrollTop = box.scrollHeight;
  }

  if (options.stickToBottom) stickChatToBottomFor(1200);

  if (state.activeThreadStarted) hideWelcomeCard();
  else showWelcomeCard();
  updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
}

async function loadThreadMessages(threadId, options = {}) {
  if (!threadId) return;
  try {
    const e2e = window.__webCodexE2E;
    if (e2e && typeof e2e.getThreadHistory === "function") {
      const seeded = e2e.getThreadHistory(threadId);
      if (seeded) {
        applyThreadToChat(seeded, options);
        return;
      }
    }
  } catch (_) {
    // Ignore and continue with normal fetch paths.
  }
  try {
    const query = [];
    const workspace = options.workspace || state.activeThreadWorkspace || "";
    if (workspace === "windows" || workspace === "wsl2") {
      query.push(`workspace=${encodeURIComponent(workspace)}`);
    }
    const rolloutPath = String(options.rolloutPath || state.activeThreadRolloutPath || "").trim();
    if (rolloutPath) query.push(`rolloutPath=${encodeURIComponent(rolloutPath)}`);
    const path = query.length
      ? `/codex/threads/${encodeURIComponent(threadId)}/history?${query.join("&")}`
      : `/codex/threads/${encodeURIComponent(threadId)}/history`;
    const history = await api(path, { method: "GET", signal: options.signal });
    if (state.activeThreadId && state.activeThreadId !== threadId) return;
    const thread = history?.thread || history?.result?.thread || null;
    if (thread) {
      applyThreadToChat(thread, options);
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
  applyThreadToChat(thread, options);
}

function ensureArrayItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return value ? [value] : [];
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
    state.activeThreadModelLabel = "";
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
  ws.onopen = () => {
    setStatus("Connected (HTTP + WS).");
    wsSend({ type: "subscribe.events", reqId: nextReqId(), payload: { events: true } });
  };
  ws.onerror = () => setStatus("WS error; fallback to HTTP.", true);
  ws.onclose = () => setStatus("WS closed; fallback to HTTP.", true);
  ws.onmessage = (event) => {
    let payload = {};
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
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
      }
      const threadId = extractNotificationThreadId(record);
      if (shouldRefreshThreadsFromNotification(method)) scheduleThreadRefresh();
      if (threadId && shouldRefreshActiveThreadFromNotification(method)) scheduleActiveThreadRefresh(threadId);
      return;
    }
    if (payload.type === "subscribed") setStatus("WS subscribed.");
  };
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
          // 1) Show full history immediately from the local JSONL file (matches `codex resume` output).
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
            setStatus(`Loaded history ${label} ${truncateLabel(id, 12)} in ${historyLatencyMs}ms`);
          }

          // 2) Resume in background so the thread is runnable for new turns.
          const resumeQuery = [];
          if (workspaceHint === "windows" || workspaceHint === "wsl2") {
            resumeQuery.push(`workspace=${encodeURIComponent(workspaceHint)}`);
          }
          if (rolloutPath) resumeQuery.push(`rolloutPath=${encodeURIComponent(rolloutPath)}`);
          const resumePath = resumeQuery.length
            ? `/codex/threads/${encodeURIComponent(id)}/resume?${resumeQuery.join("&")}`
            : `/codex/threads/${encodeURIComponent(id)}/resume`;
          const resumeTask = api(resumePath, { method: "POST", body: {}, signal: controller.signal })
            .then(() => null)
            .catch(() => null)
            .finally(() => {
              if (state.openingThreadReqId === reqId) scheduleThreadRefresh();
            });
          registerPendingThreadResume(id, resumeTask);

          if (state.openingThreadReqId === reqId) setChatOpening(false);
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
    const isConnected = !!(state.ws && state.ws.readyState === WebSocket.OPEN);
    const minInterval = isConnected ? THREAD_AUTO_REFRESH_CONNECTED_MS : THREAD_AUTO_REFRESH_DISCONNECTED_MS;
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
        return `${id}:${ts}`;
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
  state.activeThreadModelLabel = state.selectedModel || "";
  state.activeThreadWorkspace = getWorkspaceTarget();
  clearChatMessages();
  showWelcomeCard();
  updateHeaderUi();

  const data = await api("/codex/threads", { method: "POST", body: { workspace: getWorkspaceTarget() } });
  const id = data.id || data.threadId || data?.thread?.id || "";
  if (id) {
    setActiveThread(id);
    state.activeThreadStarted = false;
    state.activeThreadModelLabel = state.selectedModel || "";
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
    collaborationMode: "default",
  };
  const shouldAnimateWorkspaceBadge = !state.activeThreadStarted;
  state.activeThreadStarted = true;
  state.activeThreadWorkspace = getWorkspaceTarget();
  if (state.selectedModel) state.activeThreadModelLabel = state.selectedModel;
  updateHeaderUi(shouldAnimateWorkspaceBadge);
  addChat("user", prompt);
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
    byId("chatBox").scrollTop = byId("chatBox").scrollHeight;
    await new Promise((resolve) => {
      state.wsReqHandlers.set(reqId, (evt) => {
        const type = evt.type;
        const data = evt.payload || {};
        if (type === "delta") {
          if (typeof data.text === "string" && data.text) {
            text += (text ? " " : "") + data.text;
            body.textContent = text;
          }
          if (typeof data.threadId === "string" && data.threadId) setActiveThread(data.threadId);
        } else if (type === "completed") {
          const result = data.result || {};
          const threadId = result.threadId || result.thread_id || result?.thread?.id || state.activeThreadId;
          if (threadId) setActiveThread(threadId);
          if (!text.trim()) text = normalizeTextPayload(result);
          finalizeAssistantMessage(msg, body, text);
          maybeNotifyTurnDone(text || "");
          state.wsReqHandlers.delete(reqId);
          resolve();
        } else if (type === "error") {
          setStatus(evt.message || "WS stream error.", true);
          finalizeAssistantMessage(msg, body, text);
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
  byId("chatBox").scrollTop = byId("chatBox").scrollHeight;

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
          text += (text ? " " : "") + delta;
          body.textContent = text;
        }
        if (typeof data.threadId === "string" && data.threadId) setActiveThread(data.threadId);
      } else if (evtName === "completed") {
        const result = data.result || {};
        const threadId = result.threadId || result.thread_id || result?.thread?.id || state.activeThreadId;
        if (threadId) setActiveThread(threadId);
        if (!text.trim()) text = normalizeTextPayload(result);
        finalizeAssistantMessage(msg, body, text);
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
  bindClick("mobileMenuBtn", () => setMobileTab("threads"));
  bindClick("mobileDrawerBackdrop", () => setMobileTab("chat"));
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
    headerModelTrigger.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = !!headerModelPicker?.classList.contains("open");
      setHeaderModelMenuOpen(!isOpen);
    };
    headerModelTrigger.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const isOpen = !!headerModelPicker?.classList.contains("open");
        setHeaderModelMenuOpen(!isOpen);
      } else if (event.key === "Escape") {
        setHeaderModelMenuOpen(false);
      }
    };
  }
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!headerModelPicker || !(target instanceof Node)) return;
    if (!headerModelPicker.contains(target)) setHeaderModelMenuOpen(false);
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
        getThreadHistory(threadId) {
          return historyByThreadId.get(String(threadId || ""));
        },
        async openThread(threadId) {
          const id = String(threadId || "").trim();
          if (!id) return { ok: false, error: "missing threadId" };
          setMainTab("chat");
          setMobileTab("chat");
          setActiveThread(id);
          setChatOpening(false);
          await loadThreadMessages(id, { animateBadge: true, forceRender: true, stickToBottom: true });
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
  startThreadAutoRefreshLoop();
  startActiveThreadLivePollLoop();
  setMobileTab("chat");
  // Always attempt connect: gateway auth can now come from HttpOnly cookie.
  connect().catch((e) => setStatus(e.message, true));
}

bootstrap();
