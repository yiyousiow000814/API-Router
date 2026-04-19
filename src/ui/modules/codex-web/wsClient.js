import { createMockCodexTransport } from "./mockTransport.js";
import { synthesizeProvisionalThreadItem } from "./notificationRouting.js";
import { setThreadOpenState } from "./threadOpenState.js";

export function ensureArrayItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return value ? [value] : [];
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export function nextReqId() {
  return `req_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export function buildCodexWsUrl(locationLike, token) {
  const proto = locationLike?.protocol === "https:" ? "wss" : "ws";
  const host = String(locationLike?.host || "").trim();
  return `${proto}://${host}/codex/ws?token=${encodeURIComponent(token || "")}`;
}

export function normalizeLiveWorkspaceTarget(value, fallback = "windows") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "windows" || text === "wsl2") return text;
  const base = String(fallback || "").trim().toLowerCase();
  return base === "wsl2" ? "wsl2" : "windows";
}

export function resolveLiveWorkspaceSubscription(state) {
  const availability = state?.workspaceAvailability || {};
  const targets = [];
  if (availability.windowsInstalled === true) targets.push("windows");
  if (availability.wsl2Installed === true) targets.push("wsl2");
  if (!targets.length) {
    targets.push(
      normalizeLiveWorkspaceTarget(
        state?.activeThreadWorkspace || state?.workspaceTarget || "windows",
        "windows"
      )
    );
  }
  const uniqueTargets = Array.from(new Set(targets));
  if (uniqueTargets.length > 1) {
    return {
      workspace: "all",
      workspaces: uniqueTargets,
    };
  }
  return {
    workspace: uniqueTargets[0] || "windows",
    workspaces: uniqueTargets,
  };
}

export function subscriptionIncludesWorkspace(subscription, target) {
  const normalizedTarget = normalizeLiveWorkspaceTarget(target, "windows");
  const items = Array.isArray(subscription)
    ? subscription
    : [String(subscription || "").trim().toLowerCase()];
  if (items.includes("all")) return true;
  return items.map((value) => normalizeLiveWorkspaceTarget(value, "windows")).includes(normalizedTarget);
}

export function resolveApiErrorMessage(payload, status) {
  return payload?.error?.detail || payload?.error?.message || `HTTP ${status}`;
}

export function mapUiEventToNotification(record, readString, toRecord) {
  const kind = readString(record?.kind) || "";
  const conversationId = readString(record?.conversationId) || readString(record?.threadId) || "";
  if (kind === "activity") {
    return {
      method: "thread/status",
      params: {
        conversationId,
        threadId: conversationId,
        status: readString(record?.status) || "",
        message: readString(record?.message) || "",
        code: readString(record?.code) || "",
        thread: {
          id: conversationId,
          status: readString(record?.status) || "",
          message: readString(record?.message) || "",
        },
      },
    };
  }
  if (kind === "assistant_delta") {
    return {
      method: "turn/assistant/delta",
      params: {
        conversationId,
        threadId: conversationId,
        delta: readString(record?.delta) || "",
      },
    };
  }
  if (kind === "tool") {
    return {
      method: "item/updated",
      params: {
        conversationId,
        threadId: conversationId,
        itemId: readString(record?.itemId) || "",
        item: toRecord(record?.item) || {},
      },
    };
  }
  return null;
}

export function createWsClientModule(deps) {
  const {
    state,
    setStatus,
    setRuntimeActivity = () => {},
    toRecord,
    readString,
    readNumber,
    resetEventReplayState,
    markEventIdSeen,
    extractNotificationEventId,
    extractNotificationThreadId,
    shouldRefreshThreadsFromNotification,
    shouldRefreshActiveThreadFromNotification,
    scheduleThreadRefresh,
    scheduleActiveThreadRefresh,
    renderLiveNotification,
    applyPendingPayloads,
    addChat,
    upsertProvisionalThreadItem = () => false,
    recordWebTransportEvent = () => {},
    LAST_EVENT_ID_KEY,
    windowRef = window,
    WebSocketRef = WebSocket,
    fetchRef = fetch,
    localStorageRef = localStorage,
    setTimeoutRef = setTimeout,
    clearTimeoutRef = clearTimeout,
    setIntervalRef = setInterval,
    clearIntervalRef = clearInterval,
    WS_PING_INTERVAL_MS = 15000,
    WS_RECONNECT_BASE_MS = 800,
    WS_RECONNECT_MAX_MS = 5000,
    WS_RECONNECT_MAX_ATTEMPTS = 5,
    transportMode = "live",
    seedDefaultThreads = false,
  } = deps;

  function getActiveThreadRuntimeActivityTitle() {
    const threadId = String(state.activeThreadId || "").trim();
    if (!threadId) return "";
    return String(state.activeThreadActivity?.threadId || "").trim() === threadId
      ? String(state.activeThreadActivity?.title || "").trim().toLowerCase()
      : "";
  }

  function setReconnectRuntimeActivity(title, detail) {
    const threadId = String(state.activeThreadId || "").trim();
    if (!threadId) return;
    setRuntimeActivity({
      threadId,
      title,
      detail,
      tone: title === "Error" ? "error" : "running",
    });
  }

  function restoreRuntimeActivityAfterReconnect() {
    const threadId = String(state.activeThreadId || "").trim();
    if (!threadId) return;
    const isWorkingThread =
      state.activeThreadPendingTurnRunning === true ||
      Boolean(String(state.activeThreadPendingAssistantMessage || "").trim()) ||
      String(state.activeThreadLiveAssistantThreadId || "").trim() === threadId;
    const currentActivityTitle = getActiveThreadRuntimeActivityTitle();
    if (isWorkingThread) {
      setRuntimeActivity({ threadId, title: "Working", detail: "", tone: "running" });
      return;
    }
    if (currentActivityTitle === "reconnecting" || currentActivityTitle === "error") {
      setRuntimeActivity(null);
    }
  }

  async function liveApi(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    if (state.token.trim()) headers.Authorization = `Bearer ${state.token.trim()}`;
    const route = `${String(options.method || "GET").toUpperCase()} ${String(path || "")}`.trim();
    let res;
    try {
      res = await fetchRef(path, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || "Network request failed");
      recordWebTransportEvent("api_request_failed", `${route} -> network error: ${detail}`);
      throw error;
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = resolveApiErrorMessage(payload, res.status);
      recordWebTransportEvent("api_request_failed", `${route} -> HTTP ${String(res.status)}: ${detail}`);
      if (/thread not found/i.test(detail)) {
        recordWebTransportEvent("thread_missing_observed", detail);
      }
      throw new Error(detail);
    }
    return payload;
  }

  const mockTransport =
    transportMode === "mock" || transportMode === "safe"
      ? createMockCodexTransport({
          state,
          setStatus,
          transportMode,
          seedDefaultThreads,
          liveApi,
          handleWsPayload: (payload) => handleWsPayload(payload),
        })
      : null;

  function clearWsPingTimer() {
    if (!state.wsPingTimer) return;
    clearIntervalRef(state.wsPingTimer);
    state.wsPingTimer = null;
  }

  function clearWsReconnectTimer() {
    if (!state.wsReconnectTimer) return;
    clearTimeoutRef(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }

  function scheduleReconnect(reason = "unknown") {
    if (state.wsReconnectTimer) return;
    const attempt = Math.max(0, Number(state.wsReconnectAttempt || 0));
    const maxAttempts = Math.max(1, Number(WS_RECONNECT_MAX_ATTEMPTS || 5));
    if (attempt >= maxAttempts) {
      recordWebTransportEvent("ws_reconnect_failed", String(reason));
      const failureMessage = `Live updates disconnected after ${maxAttempts} ${maxAttempts === 1 ? "retry" : "retries"}.`;
      setStatus(failureMessage, true);
      setReconnectRuntimeActivity("Error", failureMessage);
      return;
    }
    const delay = Math.min(
      WS_RECONNECT_MAX_MS,
      WS_RECONNECT_BASE_MS * Math.max(1, 2 ** attempt)
    );
    state.wsReconnectAttempt = attempt + 1;
    recordWebTransportEvent("ws_reconnect_scheduled", String(reason));
    pushLiveDebugEvent("ws.reconnect:scheduled", {
      attempt: state.wsReconnectAttempt,
      delay,
      reason,
    });
    setStatus(`Reconnecting... ${state.wsReconnectAttempt}/${maxAttempts}`, true);
    setReconnectRuntimeActivity("Reconnecting", `${state.wsReconnectAttempt}/${maxAttempts}`);
    state.wsReconnectTimer = setTimeoutRef(() => {
      state.wsReconnectTimer = null;
      recordWebTransportEvent("ws_reconnect_attempted", null);
      pushLiveDebugEvent("ws.reconnect:attempt", {
        attempt: Number(state.wsReconnectAttempt || 0),
        reason,
      });
      connectWs();
    }, delay);
  }

  function startWsHeartbeat(ws) {
    clearWsPingTimer();
    state.wsPingTimer = setIntervalRef(() => {
      if (state.ws !== ws || ws.readyState !== WebSocketRef.OPEN) {
        clearWsPingTimer();
        return;
      }
      wsSend({ type: "ping", reqId: nextReqId() });
    }, WS_PING_INTERVAL_MS);
  }

  function subscribePayload(lastEventId = null) {
    const subscription = resolveLiveWorkspaceSubscription(state);
    const payload = {
      events: true,
      workspace: subscription.workspace,
    };
    if (subscription.workspaces.length > 1) payload.workspaces = subscription.workspaces;
    if (typeof lastEventId === "number" && Number.isFinite(lastEventId) && lastEventId >= 0) {
      payload.lastEventId = lastEventId;
    }
    return payload;
  }

  function sendSubscribeEvents(lastEventId = null) {
    const payload = subscribePayload(lastEventId);
    state.wsSubscribedEvents = false;
    state.wsRequestedWorkspaceTarget = String(payload.workspace || "windows").trim().toLowerCase();
    state.wsRequestedWorkspaceTargets = Array.isArray(payload.workspaces)
      ? payload.workspaces.slice()
      : [normalizeLiveWorkspaceTarget(payload.workspace, "windows")];
    pushLiveDebugEvent("ws.subscribe:send", {
      workspace: state.wsRequestedWorkspaceTarget,
      workspaces: state.wsRequestedWorkspaceTargets.slice(),
      lastEventId:
        typeof lastEventId === "number" && Number.isFinite(lastEventId) && lastEventId >= 0
          ? lastEventId
          : null,
    });
    wsSend({ type: "subscribe.events", reqId: nextReqId(), payload });
  }

  function pushLiveDebugEvent(kind, payload = {}) {
    if (!Array.isArray(state.liveDebugEvents)) state.liveDebugEvents = [];
    state.liveDebugEvents.push({
      at: Date.now(),
      kind: String(kind || ""),
      ...payload,
    });
    if (state.liveDebugEvents.length > 80) {
      state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 80);
    }
  }

  function wsSend(value) {
    if (mockTransport) return mockTransport.wsSend(value);
    if (!state.ws || state.ws.readyState !== WebSocketRef.OPEN) return false;
    state.ws.send(JSON.stringify(value));
    return true;
  }

  function wsCall(type, payload, expectedType) {
    if (mockTransport) return mockTransport.wsCall(type, payload, expectedType);
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== WebSocketRef.OPEN) {
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
    if (mockTransport) return mockTransport.api(path, options);
    return liveApi(path, options);
  }

  function currentLiveWorkspace() {
    return normalizeLiveWorkspaceTarget(
      state.activeThreadWorkspace || state.workspaceTarget || "windows",
      "windows"
    );
  }

  function maybeUpsertProvisionalThread(notification, workspaceHint = "windows") {
    const item = synthesizeProvisionalThreadItem(
      notification,
      normalizeLiveWorkspaceTarget(workspaceHint, currentLiveWorkspace()),
      Date.now()
    );
    if (!item) return false;
    return upsertProvisionalThreadItem(item) === true;
  }

  function handleWsPayload(payload) {
    if (!payload || typeof payload !== "object") {
      pushLiveDebugEvent("ws.drop:invalid_payload", {});
      return;
    }
    if (payload.reqId && state.wsReqHandlers.has(payload.reqId)) {
      pushLiveDebugEvent("ws.req:handled", {
        type: String(payload.type || ""),
        reqId: String(payload.reqId || ""),
      });
      state.wsReqHandlers.get(payload.reqId)(payload);
      return;
    }
    if (payload.type === "approval.requested") {
      pushLiveDebugEvent("pending.ws:approval_requested", {
        approvalCount: Array.isArray(payload.payload) ? payload.payload.length : 0,
      });
      applyPendingPayloads(payload.payload, state.pendingUserInputs);
      setStatus("Approval requested.");
      return;
    }
    if (payload.type === "user_input.requested") {
      pushLiveDebugEvent("pending.ws:user_input_requested", {
        userInputCount: Array.isArray(payload.payload) ? payload.payload.length : 0,
      });
      applyPendingPayloads(state.pendingApprovals, payload.payload);
      setStatus("User input requested.");
      return;
    }
    if (payload.type === "events.snapshot") {
      pushLiveDebugEvent("pending.ws:events_snapshot", {
        approvalCount: Array.isArray(payload?.payload?.approvals) ? payload.payload.approvals.length : 0,
        userInputCount: Array.isArray(payload?.payload?.userInputs) ? payload.payload.userInputs.length : 0,
      });
      applyPendingPayloads(payload?.payload?.approvals || [], payload?.payload?.userInputs || []);
      return;
    }
    if (payload.type === "ui.event") {
      const record = toRecord(payload.payload) || {};
      const liveNotification = mapUiEventToNotification(record, readString, toRecord);
      const liveMethod = readString(liveNotification?.method) || "";
      const conversationId =
        readString(liveNotification?.params?.conversationId) ||
        readString(record?.conversationId) ||
        readString(record?.threadId) ||
        "";
      pushLiveDebugEvent("ui.event", {
        eventKind: readString(record?.kind) || "",
        conversationId,
        method: liveMethod,
      });
      const eventId = readNumber(record?.eventId);
      if (eventId !== null) {
        if (eventId === 1 && state.wsLastEventId > 1) resetEventReplayState();
        if (eventId <= state.wsLastEventId) return;
        if (state.wsRecentEventIds.has(eventId)) return;
        markEventIdSeen(eventId);
        state.wsLastEventId = Math.max(state.wsLastEventId, eventId);
        try {
          localStorageRef.setItem(LAST_EVENT_ID_KEY, String(state.wsLastEventId));
        } catch {}
      }
      maybeUpsertProvisionalThread(liveNotification, currentLiveWorkspace());
      if (conversationId && liveMethod && shouldRefreshThreadsFromNotification(liveMethod)) {
        scheduleThreadRefresh(120);
      }
      if (
        conversationId &&
        liveMethod &&
        shouldRefreshActiveThreadFromNotification(liveMethod)
      ) {
        scheduleActiveThreadRefresh(conversationId, 90);
      }
      if (liveNotification) {
        renderLiveNotification(liveNotification);
      }
      return;
    }
    if (payload.type === "rpc.notification") {
      const notification = payload.payload || {};
      const record = toRecord(notification);
      const method = readString(record?.method) || "";
      if (!method) {
        pushLiveDebugEvent("ws.drop:no_method", {
          payloadType: String(payload.type || ""),
        });
        return;
      }
      const debugThreadId = extractNotificationThreadId(record);
      const params = toRecord(record?.params) || toRecord(record?.payload) || null;
      const item = toRecord(params?.item) || toRecord(params?.msg) || toRecord(params?.delta) || null;
      pushLiveDebugEvent("rpc.notification", {
        method,
        threadId: debugThreadId || "",
        itemType: readString(item?.type) || "",
      });
      const eventId = extractNotificationEventId(record);
      if (eventId !== null) {
        if (eventId === 1 && state.wsLastEventId > 1) resetEventReplayState();
        if (eventId <= state.wsLastEventId) {
          pushLiveDebugEvent("ws.drop:stale_event_id", {
            method,
            threadId: debugThreadId || "",
            eventId,
            wsLastEventId: state.wsLastEventId,
          });
          return;
        }
        if (state.wsRecentEventIds.has(eventId)) {
          pushLiveDebugEvent("ws.drop:duplicate_event_id", {
            method,
            threadId: debugThreadId || "",
            eventId,
          });
          return;
        }
        markEventIdSeen(eventId);
        state.wsLastEventId = Math.max(state.wsLastEventId, eventId);
        try {
          localStorageRef.setItem(LAST_EVENT_ID_KEY, String(state.wsLastEventId));
        } catch {}
      }
      const threadId = extractNotificationThreadId(record);
      maybeUpsertProvisionalThread(
        notification,
        state.wsSubscribedWorkspaceTarget || state.wsRequestedWorkspaceTarget || currentLiveWorkspace()
      );
      if (shouldRefreshThreadsFromNotification(method)) scheduleThreadRefresh();
      if (threadId && shouldRefreshActiveThreadFromNotification(method)) {
        scheduleActiveThreadRefresh(threadId);
      }
      renderLiveNotification(notification);
      return;
    }
    if (payload.type === "events.reset") {
      resetEventReplayState();
      scheduleThreadRefresh();
      if (state.activeThreadId) scheduleActiveThreadRefresh(state.activeThreadId);
      setStatus("Live event stream resynced.");
      return;
    }
    if (payload.type === "subscribed") {
      state.wsSubscribedEvents = true;
      state.wsSubscribedWorkspaceTarget = String(
        payload?.payload?.workspace || state.wsRequestedWorkspaceTarget || currentLiveWorkspace()
      )
        .trim()
        .toLowerCase() || "windows";
      state.wsSubscribedWorkspaceTargets = Array.isArray(payload?.payload?.workspaces)
        ? payload.payload.workspaces.map((value) => normalizeLiveWorkspaceTarget(value, "windows"))
        : Array.isArray(state.wsRequestedWorkspaceTargets)
          ? state.wsRequestedWorkspaceTargets.slice()
          : [normalizeLiveWorkspaceTarget(state.wsRequestedWorkspaceTarget, "windows")];
      scheduleThreadRefresh(0);
      if (state.activeThreadId) {
        scheduleActiveThreadRefresh(state.activeThreadId, 0);
      }
      setStatus("Live updates connected.");
    }
  }

  function connectWs() {
    if (mockTransport) {
      mockTransport.connectWs();
      return;
    }
    if (
      state.ws &&
      (state.ws.readyState === WebSocketRef.OPEN ||
        state.ws.readyState === WebSocketRef.CONNECTING)
    ) {
      return;
    }
    clearWsReconnectTimer();
    const wsUrl = buildCodexWsUrl(windowRef.location, state.token || "");
    const ws = new WebSocketRef(wsUrl);
    state.wsConnectSeq = Math.max(0, Number(state.wsConnectSeq || 0)) + 1;
    const connectSeq = state.wsConnectSeq;
    state.ws = ws;
    state.wsSubscribedEvents = false;
    ws.onopen = () => {
      if (state.ws !== ws || connectSeq !== state.wsConnectSeq) return;
      recordWebTransportEvent("ws_open_observed", null);
      pushLiveDebugEvent("ws.open", {
        url: wsUrl,
      });
      const hadReconnectAttempt = Number(state.wsReconnectAttempt || 0) > 0;
      state.wsReconnectAttempt = 0;
      setStatus("Connected (live updates syncing).");
      restoreRuntimeActivityAfterReconnect();
      if (hadReconnectAttempt && String(state.activeThreadId || "").trim()) {
        const openState = state.activeThreadOpenState;
        if (openState?.loaded === true) {
          setThreadOpenState(state, {
            ...openState,
            threadStatusType: "notLoaded",
            loaded: false,
          });
        }
      }
      startWsHeartbeat(ws);
      let lastEventId = 0;
      try {
        lastEventId = Number(localStorageRef.getItem(LAST_EVENT_ID_KEY) || 0) || 0;
      } catch {}
      sendSubscribeEvents(lastEventId);
    };
    ws.onerror = () => {
      if (state.ws !== ws || connectSeq !== state.wsConnectSeq) return;
      recordWebTransportEvent("ws_error_observed", null);
      pushLiveDebugEvent("ws.error", {});
      state.wsSubscribedEvents = false;
      state.wsSubscribedWorkspaceTarget = "";
      state.wsSubscribedWorkspaceTargets = [];
      scheduleReconnect("ws error");
    };
    ws.onclose = (event) => {
      if (state.ws !== ws || connectSeq !== state.wsConnectSeq) return;
      clearWsPingTimer();
      const rawCloseCode = Number(event?.code);
      const closeCode = Number.isFinite(rawCloseCode) && rawCloseCode >= 1000 ? rawCloseCode : null;
      recordWebTransportEvent(
        "ws_close_observed",
        JSON.stringify({
          code: closeCode,
          reason: String(event?.reason || ""),
          wasClean: event?.wasClean === true,
        }),
      );
      pushLiveDebugEvent("ws.close:client", {
        code: Number(event?.code ?? 0),
        reason: String(event?.reason || ""),
        wasClean: event?.wasClean === true,
      });
      pushLiveDebugEvent("ws.close", {});
      state.wsSubscribedEvents = false;
      state.wsSubscribedWorkspaceTarget = "";
      state.wsSubscribedWorkspaceTargets = [];
      setStatus("WS closed; fallback to HTTP.", true);
      scheduleReconnect(String(event?.reason || `code:${Number(event?.code ?? 0) || 0}`));
    };
    ws.onmessage = (event) => {
      if (state.ws !== ws || connectSeq !== state.wsConnectSeq) return;
      let payload = {};
      try {
        payload = JSON.parse(event.data);
      } catch {
        pushLiveDebugEvent("ws.drop:invalid_json", {
          raw: String(event?.data || "").slice(0, 180),
        });
        return;
      }
      handleWsPayload(payload);
    };
  }

  function syncEventSubscription() {
    if (mockTransport) return mockTransport.syncEventSubscription();
    if (!state.ws || state.ws.readyState !== WebSocketRef.OPEN) return false;
    let lastEventId = 0;
    try {
      lastEventId = Number(localStorageRef.getItem(LAST_EVENT_ID_KEY) || 0) || 0;
    } catch {}
    sendSubscribeEvents(lastEventId);
    return true;
  }

  return {
    api,
    connectWs,
    handleWsPayload,
    syncEventSubscription,
    wsCall,
    wsSend,
  };
}
