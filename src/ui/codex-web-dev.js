const state = {
  token: "",
  activeHostId: "",
  activeThreadId: "",
  ws: null,
  wsReqHandlers: new Map(),
  pendingApprovals: [],
  pendingUserInputs: [],
  threadItemsAll: [],
  threadItems: [],
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
};

const GUIDE_DISMISSED_KEY = "web_codex_guide_dismissed_v2";
const TOKEN_STORAGE_KEY = "web_codex_token_v1";
const WORKSPACE_TARGET_KEY = "web_codex_workspace_target_v1";
const FAVORITE_THREADS_KEY = "web_codex_favorite_threads_v1";
const SANDBOX_MODE =
  window.__WEB_CODEX_SANDBOX__ === true ||
  window.location.pathname.startsWith("/sandbox/") ||
  new URLSearchParams(window.location.search).get("sandbox") === "1";

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

function normalizeWorkspaceTarget(value) {
  return value === "wsl2" ? "wsl2" : "windows";
}

function getWorkspaceTarget() {
  return normalizeWorkspaceTarget(state.workspaceTarget || "windows");
}

function getWorkspaceLabel() {
  return getWorkspaceTarget() === "wsl2" ? "Bridge WSL2 workspace" : "Bridge Windows workspace";
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
  const headerSwitch = byId("headerWorkspaceSwitch");
  const drawerSwitch = byId("drawerWorkspaceSwitch");
  const canUseWindows = isWorkspaceAvailable("windows");
  const canUseWsl2 = isWorkspaceAvailable("wsl2");

  if (headerSwitch) {
    if (state.activeMainTab === "settings") {
      headerSwitch.style.display = "none";
    } else {
      headerSwitch.style.display = "inline-flex";
      headerSwitch.style.visibility = "visible";
      headerSwitch.style.pointerEvents = "auto";
    }
  }
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
  await refreshThreads(target);
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

function addChat(role, text) {
  const box = byId("chatBox");
  const welcome = byId("welcomeCard");
  if (welcome) welcome.style.display = "none";
  const node = document.createElement("div");
  node.className = `msg ${role}`.trim();
  node.innerHTML = `<div class="msgHead">${escapeHtml(role)}</div>${escapeHtml(text || "")}`;
  box.appendChild(node);
  box.scrollTop = box.scrollHeight;
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

function updateMobileComposerState() {
  const wrap = byId("mobilePromptWrap");
  const input = byId("mobilePromptInput");
  if (!wrap || !input) return;
  wrap.classList.toggle("has-text", !!String(input.value || "").trim());
}

function setMainTab(tab) {
  state.activeMainTab = tab === "settings" ? "settings" : "chat";
  const settingsTab = byId("settingsTab");
  const settingsInfoSection = byId("settingsInfoSection");
  const chatBox = byId("chatBox");
  const composer = document.querySelector(".composer");
  const panelTitle = document.querySelector(".chatPanel .panelHeader .panelTitle");
  const headerSwitch = byId("headerWorkspaceSwitch");
  const isSideTab = state.activeMainTab === "settings";
  if (settingsTab) settingsTab.classList.toggle("show", isSideTab);
  if (settingsInfoSection) settingsInfoSection.style.display = "";
  if (chatBox) chatBox.style.display = isSideTab ? "none" : "";
  if (composer) composer.style.display = isSideTab ? "none" : "";
  if (headerSwitch) headerSwitch.style.display = isSideTab ? "none" : "";
  if (panelTitle) panelTitle.textContent = state.activeMainTab === "settings" ? "Settings" : "New chat";
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
  state.activeThreadId = id || "";
  const activeThreadLabel = byId("activeThreadId");
  if (activeThreadLabel) activeThreadLabel.textContent = state.activeThreadId || "(none)";
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
  const homeLikeMatch =
    text.match(/^\/home\/([^\\/]+)$/i) ||
    text.match(/^\/users\/([^\\/]+)$/i) ||
    text.match(/^[a-z]:\\users\\([^\\\/]+)$/i) ||
    text.match(/^\\\\wsl\.localhost\\[^\\\/]+\\home\\([^\\\/]+)$/i);
  if (homeLikeMatch) return "Home";
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
    if (payload.type === "subscribed") setStatus("WS subscribed.");
  };
}

function renderThreads(items) {
  const list = byId("threadList");
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
        await api(`/codex/threads/${encodeURIComponent(id)}/resume`, { method: "POST", body: {} });
        setActiveThread(id);
        setStatus(`Resumed thread ${id}`);
        hideWelcomeCard();
        setMobileTab("chat");
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
    }
    list.appendChild(group);
  }
  if (!renderedThreads) list.innerHTML = `<div class="muted">No threads match search.</div>`;
  state.lastChevronToggleKey = "";
  state.lastChevronToggleCollapsed = false;
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

async function refreshThreads(workspaceTarget = getWorkspaceTarget()) {
  const target = normalizeWorkspaceTarget(workspaceTarget);
  const workspace = encodeURIComponent(target);
  const data = await api(`/codex/threads?workspace=${workspace}`);
  const items = ensureArrayItems(data.items);
  if (getWorkspaceTarget() !== target) return;
  state.threadItemsAll = items;
  updateWorkspaceAvailabilityFromThreads(items);
  applyThreadFilter();
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
  const data = await api("/codex/threads", { method: "POST", body: { workspace: getWorkspaceTarget() } });
  const id = data.id || data.threadId || data?.thread?.id || "";
  if (id) setActiveThread(id);
  await refreshThreads();
  setMainTab("chat");
}

async function sendTurn() {
  if (blockInSandbox("send turn")) return;
  const prompt = getPromptValue();
  if (!prompt) return;
  const payload = {
    threadId: state.activeThreadId || null,
    prompt,
    collaborationMode: "default",
  };
  addChat("user", prompt);
  setMainTab("chat");
  clearPromptValue();
  connectWs();

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    const reqId = nextReqId();
    let text = "";
    hideWelcomeCard();
    const msg = document.createElement("div");
    msg.className = "msg assistant";
    msg.innerHTML = `<div class="msgHead">assistant</div><div></div>`;
    const body = msg.querySelector("div:last-child");
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
          if (!text.trim()) body.textContent = normalizeTextPayload(result);
          maybeNotifyTurnDone(body.textContent || "");
          state.wsReqHandlers.delete(reqId);
          resolve();
        } else if (type === "error") {
          setStatus(evt.message || "WS stream error.", true);
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
  const msg = document.createElement("div");
  msg.className = "msg assistant";
  msg.innerHTML = `<div class="msgHead">assistant</div><div></div>`;
  const body = msg.querySelector("div:last-child");
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
        if (!text.trim()) body.textContent = normalizeTextPayload(result);
        maybeNotifyTurnDone(body.textContent || "");
      } else if (evtName === "error") {
        setStatus(data?.message || "Stream error.", true);
      }
    }
  }
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
    if (event.key === "Enter") {
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
  window.addEventListener("resize", () => {
    setMobileTab("chat");
  });
}

function bootstrap() {
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
  updateWorkspaceAvailability(false, false);
  applyWorkspaceUi();
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
  setMobileTab("chat");
  // Always attempt connect: gateway auth can now come from HttpOnly cookie.
  connect().catch((e) => setStatus(e.message, true));
}

bootstrap();
