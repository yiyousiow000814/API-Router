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
  } = deps;

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
    const delay = Math.min(
      WS_RECONNECT_MAX_MS,
      WS_RECONNECT_BASE_MS * Math.max(1, 2 ** attempt)
    );
    state.wsReconnectAttempt = attempt + 1;
    pushLiveDebugEvent("ws.reconnect:scheduled", {
      attempt: state.wsReconnectAttempt,
      delay,
      reason,
    });
    state.wsReconnectTimer = setTimeoutRef(() => {
      state.wsReconnectTimer = null;
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

  function currentLiveWorkspace() {
    return normalizeLiveWorkspaceTarget(
      state.activeThreadWorkspace || state.workspaceTarget || "windows",
      "windows"
    );
  }

  function subscribePayload(lastEventId = null) {
    const payload = {
      events: true,
      workspace: currentLiveWorkspace(),
    };
    if (typeof lastEventId === "number" && Number.isFinite(lastEventId) && lastEventId >= 0) {
      payload.lastEventId = lastEventId;
    }
    return payload;
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
    if (!state.ws || state.ws.readyState !== WebSocketRef.OPEN) return false;
    state.ws.send(JSON.stringify(value));
    return true;
  }

  function wsCall(type, payload, expectedType) {
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
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    if (state.token.trim()) headers.Authorization = `Bearer ${state.token.trim()}`;
    const res = await fetchRef(path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(resolveApiErrorMessage(payload, res.status));
    }
    return payload;
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
      applyPendingPayloads(payload.payload, state.pendingUserInputs);
      setStatus("Approval requested.");
      return;
    }
    if (payload.type === "user_input.requested") {
      applyPendingPayloads(state.pendingApprovals, payload.payload);
      setStatus("User input requested.");
      return;
    }
    if (payload.type === "events.snapshot") {
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
      if (shouldRefreshThreadsFromNotification(method)) scheduleThreadRefresh();
      if (threadId && shouldRefreshActiveThreadFromNotification(method)) {
        scheduleActiveThreadRefresh(threadId);
      }
      renderLiveNotification(notification);
      return;
    }
    if (payload.type === "events.reset") {
      resetEventReplayState();
      setStatus("Live event stream resynced.");
      return;
    }
    if (payload.type === "subscribed") {
      state.wsSubscribedEvents = true;
      setStatus("Live updates connected.");
    }
  }

  function connectWs() {
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
      pushLiveDebugEvent("ws.open", {
        url: wsUrl,
      });
      state.wsReconnectAttempt = 0;
      setStatus("Connected (live updates syncing).");
      startWsHeartbeat(ws);
      let lastEventId = 0;
      try {
        lastEventId = Number(localStorageRef.getItem(LAST_EVENT_ID_KEY) || 0) || 0;
      } catch {}
      wsSend({ type: "subscribe.events", reqId: nextReqId(), payload: subscribePayload(lastEventId) });
    };
    ws.onerror = () => {
      if (state.ws !== ws || connectSeq !== state.wsConnectSeq) return;
      pushLiveDebugEvent("ws.error", {});
      state.wsSubscribedEvents = false;
      setStatus("WS error; fallback to HTTP.", true);
    };
    ws.onclose = (event) => {
      if (state.ws !== ws || connectSeq !== state.wsConnectSeq) return;
      clearWsPingTimer();
      pushLiveDebugEvent("ws.close:client", {
        code: Number(event?.code ?? 0),
        reason: String(event?.reason || ""),
        wasClean: event?.wasClean === true,
      });
      pushLiveDebugEvent("ws.close", {});
      state.wsSubscribedEvents = false;
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
    if (!state.ws || state.ws.readyState !== WebSocketRef.OPEN) return false;
    let lastEventId = 0;
    try {
      lastEventId = Number(localStorageRef.getItem(LAST_EVENT_ID_KEY) || 0) || 0;
    } catch {}
    state.wsSubscribedEvents = false;
    wsSend({
      type: "subscribe.events",
      reqId: nextReqId(),
      payload: subscribePayload(lastEventId),
    });
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
