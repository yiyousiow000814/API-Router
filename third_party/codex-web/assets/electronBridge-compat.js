(function () {
  if (window.electronBridge) return;

  const FROM_VIEW = "codex_desktop:message-from-view";
  const FOR_VIEW = "codex_desktop:message-for-view";
  const SHOW_CONTEXT_MENU = "codex_desktop:show-context-menu";
  const SHOW_APPLICATION_MENU = "codex_desktop:show-application-menu";
  const GET_FAST_MODE_ROLLOUT_METRICS = "codex_desktop:get-fast-mode-rollout-metrics";
  const INVOKE_MESSAGE_TYPES = new Set([
    "fetch",
    "fetch-stream",
    "cancel-fetch",
    "cancel-fetch-stream",
    "shared-object-set",
    "shared-object-subscribe",
    "shared-object-unsubscribe",
    "mcp-request",
    "open-in-browser",
  ]);
  const sessionKey = "api-router-codex-web-session-id";
  const wsPath = "/__backend/ipc";

  let socket = null;
  let nextRequestId = 1;
  const pending = new Map();
  const queue = [];
  const sharedObjectSnapshot = Object.create(null);
  const workerMessageSubscribers = new Map();
  let systemThemeVariant = "light";
  const systemThemeSubscribers = new Set();
  const compactTouchViewport = isCompactTouchViewport();
  const resolvedWindowType = resolveCodexWindowType();

  function resolveCodexWindowType() {
    return "electron";
  }

  function isCompactTouchViewport() {
    try {
      const coarsePointer =
        window.matchMedia?.("(pointer: coarse)")?.matches === true ||
        window.matchMedia?.("(hover: none)")?.matches === true ||
        Number(window.navigator?.maxTouchPoints || 0) > 0;
      const narrowViewport =
        Number(window.innerWidth || 0) > 0 &&
        Number(window.innerWidth || 0) <= 900;
      return coarsePointer && narrowViewport;
    } catch {
      return false;
    }
  }

  function trace(kind, detail) {
    const entry = { at: Date.now(), kind, detail };
    const target = (window.__API_ROUTER_BRIDGE_TRACE__ ||= []);
    target.push(entry);
    if (target.length > 200) target.splice(0, target.length - 200);
    let node = document.getElementById("api-router-bridge-trace");
    if (!node) {
      node = document.createElement("script");
      node.id = "api-router-bridge-trace";
      node.type = "application/json";
      document.documentElement.appendChild(node);
    }
    node.textContent = JSON.stringify(target);
  }

  function getBridgeToken() {
    const meta = document.querySelector('meta[name="api-router-gateway-token"]');
    return meta?.content || "";
  }

  function getSessionId() {
    let id = sessionStorage.getItem(sessionKey);
    if (!id) {
      id = `web_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
      sessionStorage.setItem(sessionKey, id);
    }
    return id;
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const url = new URL(wsPath, window.location.href);
    const token = getBridgeToken();
    if (token) url.searchParams.set("token", token);
    socket = new WebSocket(url.toString());
    socket.addEventListener("open", flushQueue);
    socket.addEventListener("message", onSocketMessage);
    socket.addEventListener("close", () => {
      socket = null;
      setTimeout(connect, 250);
    });
    socket.addEventListener("error", () => {});
  }

  function flushQueue() {
    while (queue.length > 0 && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(queue.shift()));
    }
  }

  function sendRaw(message) {
    const viewMessage = message?.args?.[0];
    trace("send", {
      type: message?.type,
      channel: message?.channel,
      requestId: message?.requestId,
      messageType: viewMessage?.type,
      url: viewMessage?.url,
      method: viewMessage?.request?.method,
      mcpRequestId: viewMessage?.request?.id,
    });
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      queue.push(message);
      connect();
      return;
    }
    socket.send(JSON.stringify(message));
  }

  function invoke(channel, ...args) {
    const requestId = `req_${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      sendRaw({
        type: "ipc-renderer-invoke",
        requestId,
        channel,
        args,
      });
      setTimeout(() => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        reject(new Error(`bridge timeout: ${channel}`));
      }, 30000);
    });
  }

  function send(channel, ...args) {
    sendRaw({
      type: "ipc-renderer-send",
      channel,
      args,
    });
    return Promise.resolve();
  }

  function updateSharedObject(message) {
    if (message?.type !== "shared-object-updated") return;
    if (message.value === undefined) {
      delete sharedObjectSnapshot[message.key];
      return;
    }
    sharedObjectSnapshot[message.key] = message.value;
  }

  function emitWindowMessage(data) {
    window.dispatchEvent(new MessageEvent("message", { data }));
  }

  function emitWorkerMessage(message) {
    const workerId = typeof message?.workerId === "string" ? message.workerId : "";
    if (!workerId) return;
    const subscribers = workerMessageSubscribers.get(workerId);
    if (!subscribers || subscribers.size === 0) return;
    for (const callback of [...subscribers]) {
      try {
        callback(message);
      } catch {
        // Keep bridge delivery best-effort so one bad subscriber does not break startup.
      }
    }
  }

  function onSocketMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const viewMessage = payload?.args?.[0];
    const mcpMessage = viewMessage?.message;
    const mcpResult = mcpMessage?.result;
    trace("receive", {
      type: payload?.type,
      channel: payload?.channel,
      requestId: payload?.requestId,
      messageType: viewMessage?.type,
      responseType: viewMessage?.responseType,
      status: viewMessage?.status,
      error: viewMessage?.error || mcpMessage?.error || payload?.errorMessage,
      mcpResponseId: mcpMessage?.id,
      mcpResultKeys: mcpResult && typeof mcpResult === "object" ? Object.keys(mcpResult).slice(0, 12) : undefined,
      ok: payload?.ok,
    });

    if (payload.type === "ipc-renderer-invoke-result") {
      const entry = pending.get(payload.requestId);
      if (!entry) return;
      pending.delete(payload.requestId);
      if (payload.ok) {
        entry.resolve(payload.result);
      } else {
        entry.reject(new Error(payload.errorMessage || "bridge invoke failed"));
      }
      return;
    }

    if (payload.type !== "ipc-main-event") {
      return;
    }

    if (payload.channel !== FOR_VIEW) {
      return;
    }

    const message = payload.args?.[0];
    updateSharedObject(message);
    emitWorkerMessage(message);
    emitWindowMessage(message);
  }

  window.electronBridge = {
    windowType: resolvedWindowType,
    sendMessageFromView(message) {
      if (message?.type === "shared-object-set") {
        if (message.value === undefined) {
          delete sharedObjectSnapshot[message.key];
        } else {
          sharedObjectSnapshot[message.key] = message.value;
        }
      }
      if (INVOKE_MESSAGE_TYPES.has(message?.type)) {
        return invoke(FROM_VIEW, message);
      }
      return send(FROM_VIEW, message);
    },
    async sendWorkerMessageFromView(workerId, message) {
      if (typeof workerId !== "string" || workerId.length === 0) {
        throw new Error("workerId is required");
      }
      await invoke(`codex_desktop:worker:${workerId}:from-view`, message);
    },
    subscribeToWorkerMessages(workerId, callback) {
      if (typeof workerId !== "string" || workerId.length === 0 || typeof callback !== "function") {
        return function unsubscribe() {};
      }
      let subscribers = workerMessageSubscribers.get(workerId);
      if (!subscribers) {
        subscribers = new Set();
        workerMessageSubscribers.set(workerId, subscribers);
      }
      subscribers.add(callback);
      return function unsubscribe() {
        const current = workerMessageSubscribers.get(workerId);
        if (!current) return;
        current.delete(callback);
        if (current.size === 0) {
          workerMessageSubscribers.delete(workerId);
        }
      };
    },
    getPathForFile(file) {
      return typeof file?.path === "string" ? file.path : null;
    },
    async showContextMenu(payload) {
      return invoke(SHOW_CONTEXT_MENU, payload);
    },
    ...(compactTouchViewport
      ? {}
      : {
          async showApplicationMenu(menuId, x, y) {
            return invoke(SHOW_APPLICATION_MENU, { menuId, x, y });
          },
        }),
    async getFastModeRolloutMetrics(payload) {
      return invoke(GET_FAST_MODE_ROLLOUT_METRICS, payload);
    },
    getSharedObjectSnapshotValue(key) {
      return sharedObjectSnapshot[key];
    },
    getSystemThemeVariant() {
      return systemThemeVariant;
    },
    subscribeToSystemThemeVariant(callback) {
      systemThemeSubscribers.add(callback);
      return function unsubscribe() {
        systemThemeSubscribers.delete(callback);
      };
    },
    triggerSentryTestError() {
      return Promise.resolve();
    },
    getSentryInitOptions() {
      return null;
    },
    getAppSessionId() {
      return getSessionId();
    },
    getBuildFlavor() {
      return "prod";
    },
  };

  window.codexWindowType = resolvedWindowType;
  document.documentElement.dataset.codexWindowType = resolvedWindowType;
  window.__API_ROUTER_CODEX_WEB__ = true;
  connect();
})();
