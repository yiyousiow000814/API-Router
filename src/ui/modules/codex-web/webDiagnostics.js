const DEFAULT_VISIBLE_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_HIDDEN_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_BATCH_DELAY_MS = 750;
const DEFAULT_LONG_TASK_THRESHOLD_MS = 1000;
const DEFAULT_FRAME_STALL_THRESHOLD_MS = 180;
const DEFAULT_INTERACTION_SAMPLE_COOLDOWN_MS = 600;
const DEFAULT_INTERACTION_MONITOR_WINDOW_MS = 8000;

export function normalizeCodexWebActivePage(state) {
  const tab = String(state?.activeMainTab || "").trim();
  if (!tab || tab === "chat") return "codex-web";
  return `codex-web:${tab}`;
}

function isVisible(documentRef) {
  return String(documentRef?.visibilityState || "visible").trim().toLowerCase() !== "hidden";
}

function truncateMessage(value, maxLength = 500) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function shouldReportFrontendError(message) {
  const text = String(message || "").trim();
  return text !== "" && text !== "Script error.";
}

export function createCodexWebDiagnostics(deps) {
  const {
    state,
    windowRef = typeof window === "undefined" ? null : window,
    documentRef = typeof document === "undefined" ? null : document,
    fetchRef = typeof fetch === "undefined" ? null : fetch,
    nowRef = () => Date.now(),
    setTimeoutRef = setTimeout,
    clearTimeoutRef = clearTimeout,
    setIntervalRef = setInterval,
    clearIntervalRef = clearInterval,
    requestAnimationFrameRef =
      typeof requestAnimationFrame === "undefined" ? null : requestAnimationFrame,
    PerformanceObserverRef =
      typeof PerformanceObserver === "undefined" ? null : PerformanceObserver,
    visibleHeartbeatIntervalMs = DEFAULT_VISIBLE_HEARTBEAT_INTERVAL_MS,
    hiddenHeartbeatIntervalMs = DEFAULT_HIDDEN_HEARTBEAT_INTERVAL_MS,
    batchDelayMs = DEFAULT_BATCH_DELAY_MS,
    longTaskThresholdMs = DEFAULT_LONG_TASK_THRESHOLD_MS,
    frameStallThresholdMs = DEFAULT_FRAME_STALL_THRESHOLD_MS,
    interactionSampleCooldownMs = DEFAULT_INTERACTION_SAMPLE_COOLDOWN_MS,
    interactionMonitorWindowMs = DEFAULT_INTERACTION_MONITOR_WINDOW_MS,
  } = deps || {};

  const queue = {
    traces: [],
    invokeResults: [],
    longTasks: [],
    frameStalls: [],
    frontendErrors: [],
  };
  let installed = false;
  let flushTimer = 0;
  let heartbeatTimer = 0;
  let startupFrameMonitorUntil = 0;
  let interactionFrameMonitorUntil = 0;
  let interactionFrameMonitorScheduled = false;
  let lastInteractionSampleAt = 0;

  function activePage() {
    return normalizeCodexWebActivePage(state);
  }

  function visible() {
    return isVisible(documentRef);
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    const token = String(state?.token || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  function buildHeartbeat() {
    return {
      activePage: activePage(),
      visible: visible(),
      statusInFlight: Boolean(
        state?.activeThreadLoading ||
          state?.threadListLoading ||
          state?.folderPickerLoading ||
          state?.activeThreadPendingTurnRunning
      ),
      configInFlight: Boolean(state?.modelOptionsLoading || state?.workspaceRuntimeLoading),
      providerSwitchInFlight: Boolean(
        state?.providerSwitchboardLoading || state?.providerSwitchboardApplying
      ),
    };
  }

  function scheduleFlush() {
    if (flushTimer || !fetchRef) return;
    flushTimer = setTimeoutRef(() => {
      flushTimer = 0;
      flush().catch(() => {});
    }, batchDelayMs);
  }

  function enqueue(key, value) {
    if (!queue[key]) return;
    queue[key].push({
      activePage: activePage(),
      visible: visible(),
      ...value,
    });
    if (queue[key].length > 256) {
      queue[key].splice(0, queue[key].length - 256);
    }
    scheduleFlush();
  }

  async function flush(extra = {}) {
    if (!fetchRef) return;
    const body = {
      ...extra,
      traces: queue.traces.splice(0, 256),
      invokeResults: queue.invokeResults.splice(0, 256),
      longTasks: queue.longTasks.splice(0, 64),
      frameStalls: queue.frameStalls.splice(0, 64),
      frontendErrors: queue.frontendErrors.splice(0, 64),
    };
    const hasQueued =
      body.traces.length ||
      body.invokeResults.length ||
      body.longTasks.length ||
      body.frameStalls.length ||
      body.frontendErrors.length ||
      body.heartbeat;
    if (!hasQueued) return;
    try {
      await fetchRef("/codex/ui-diagnostics", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
    } catch {}
  }

  function recordApiResult({ command, elapsedMs, ok, errorMessage }) {
    const route = String(command || "").trim();
    if (!route) return;
    enqueue("invokeResults", {
      command: route,
      elapsedMs: Math.max(0, Math.round(Number(elapsedMs || 0))),
      ok: ok !== false,
      errorMessage: errorMessage ? truncateMessage(errorMessage) : null,
    });
  }

  function recordTrace(kind, fields = {}) {
    const normalizedKind = String(kind || "").trim();
    if (!normalizedKind) return;
    enqueue("traces", {
      kind: normalizedKind,
      fields: fields && typeof fields === "object" ? fields : { value: String(fields || "") },
    });
  }

  function installLongTaskObserver() {
    if (!PerformanceObserverRef) return;
    try {
      const observer = new PerformanceObserverRef((list) => {
        for (const entry of list.getEntries?.() || []) {
          const elapsedMs = Math.round(Number(entry.duration || 0));
          if (elapsedMs >= longTaskThresholdMs) {
            enqueue("longTasks", { elapsedMs });
          }
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {}
  }

  function recordFrameStall(elapsedMs, monitorKind) {
    if (elapsedMs < frameStallThresholdMs) return;
    enqueue("frameStalls", {
      elapsedMs: Math.round(elapsedMs),
      monitorKind,
    });
  }

  function startFrameMonitor() {
    if (!requestAnimationFrameRef) return;
    startupFrameMonitorUntil = nowRef() + 10000;
    let lastFrameAt = nowRef();
    const tick = () => {
      const now = nowRef();
      const elapsedMs = now - lastFrameAt;
      lastFrameAt = now;
      if (now <= startupFrameMonitorUntil) {
        recordFrameStall(elapsedMs, "startup");
        requestAnimationFrameRef(tick);
      }
    };
    requestAnimationFrameRef(tick);
  }

  function startInteractionFrameMonitor() {
    if (!requestAnimationFrameRef || interactionFrameMonitorScheduled) return;
    interactionFrameMonitorScheduled = true;
    let lastFrameAt = nowRef();
    const tick = () => {
      const now = nowRef();
      const elapsedMs = now - lastFrameAt;
      lastFrameAt = now;
      if (now <= interactionFrameMonitorUntil && visible()) {
        recordFrameStall(elapsedMs, "interaction");
        requestAnimationFrameRef(tick);
        return;
      }
      interactionFrameMonitorScheduled = false;
    };
    requestAnimationFrameRef(tick);
  }

  function installInteractionFrameMonitor() {
    if (!windowRef || !requestAnimationFrameRef) return;
    const handler = () => {
      const now = nowRef();
      if (now - lastInteractionSampleAt < interactionSampleCooldownMs) return;
      lastInteractionSampleAt = now;
      interactionFrameMonitorUntil = Math.max(
        interactionFrameMonitorUntil,
        now + interactionMonitorWindowMs
      );
      startInteractionFrameMonitor();
    };
    for (const eventName of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      windowRef.addEventListener?.(eventName, handler, { passive: true });
    }
  }

  function installErrorHandlers() {
    windowRef?.addEventListener?.("error", (event) => {
      const message = truncateMessage(event?.message || event?.error?.message || "frontend error");
      if (!shouldReportFrontendError(message)) return;
      enqueue("frontendErrors", {
        kind: "error",
        message,
      });
    });
    windowRef?.addEventListener?.("unhandledrejection", (event) => {
      const message = truncateMessage(event?.reason?.message || event?.reason || "unhandled rejection");
      if (!shouldReportFrontendError(message)) return;
      enqueue("frontendErrors", {
        kind: "unhandledrejection",
        message,
      });
    });
  }

  function sendHeartbeat() {
    flush({ heartbeat: buildHeartbeat() }).catch(() => {});
  }

  function heartbeatDelayMs() {
    return visible() ? visibleHeartbeatIntervalMs : hiddenHeartbeatIntervalMs;
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeoutRef(heartbeatTimer);
    heartbeatTimer = setTimeoutRef(() => {
      heartbeatTimer = 0;
      sendHeartbeat();
      if (installed) scheduleHeartbeat();
    }, heartbeatDelayMs());
  }

  function install() {
    if (installed) return;
    installed = true;
    try {
      windowRef.__API_ROUTER_ACTIVE_PAGE__ = "codex-web";
    } catch {}
    installLongTaskObserver();
    installErrorHandlers();
    startFrameMonitor();
    installInteractionFrameMonitor();
    sendHeartbeat();
    scheduleHeartbeat();
    documentRef?.addEventListener?.("visibilitychange", () => {
      sendHeartbeat();
      scheduleHeartbeat();
    });
    windowRef?.addEventListener?.("pagehide", () => {
      if (flushTimer) clearTimeoutRef(flushTimer);
      flushTimer = 0;
      sendHeartbeat();
    });
  }

  function dispose() {
    if (heartbeatTimer) {
      clearTimeoutRef(heartbeatTimer);
      clearIntervalRef(heartbeatTimer);
    }
    if (flushTimer) clearTimeoutRef(flushTimer);
    heartbeatTimer = 0;
    flushTimer = 0;
    installed = false;
  }

  return {
    install,
    dispose,
    flush,
    recordApiResult,
    recordTrace,
  };
}
