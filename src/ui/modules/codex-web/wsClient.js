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

export function resolveApiErrorMessage(payload, status) {
  return payload?.error?.detail || payload?.error?.message || `HTTP ${status}`;
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
  } = deps;

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
          localStorageRef.setItem(LAST_EVENT_ID_KEY, String(state.wsLastEventId));
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
        });
        return;
      }
      if (kind === "assistant_delta") {
        renderLiveNotification({
          method: "turn/assistant/delta",
          params: {
            conversationId,
            threadId: conversationId,
            delta: readString(record?.delta) || "",
          },
        });
        return;
      }
      if (kind === "tool") {
        renderLiveNotification({
          method: "item/updated",
          params: {
            conversationId,
            threadId: conversationId,
            itemId: readString(record?.itemId) || "",
            item: toRecord(record?.item) || {},
          },
        });
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
      return;
    }
    if (payload.type === "subscribed") {
      state.wsSubscribedEvents = true;
      setStatus("WS subscribed.");
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
    const wsUrl = buildCodexWsUrl(windowRef.location, state.token || "");
    const ws = new WebSocketRef(wsUrl);
    state.ws = ws;
    state.wsSubscribedEvents = false;
    ws.onopen = () => {
      setStatus("Connected (HTTP + WS).");
      let lastEventId = 0;
      try {
        lastEventId = Number(localStorageRef.getItem(LAST_EVENT_ID_KEY) || 0) || 0;
      } catch {}
      wsSend({
        type: "subscribe.events",
        reqId: nextReqId(),
        payload: { events: true, lastEventId },
      });
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

  return {
    api,
    connectWs,
    handleWsPayload,
    wsCall,
    wsSend,
  };
}
